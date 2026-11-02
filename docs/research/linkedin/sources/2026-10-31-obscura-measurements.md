# Obscura measurements — 2026-10-31, macOS 26.6.2 arm64, 16 GB

Binary: `obscura 0.2.5`, `obscura-aarch64-macos.tar.gz` (67,143,887 bytes, sha256 `fcca31eba4280cd67a2e226e…`),
adhoc/linker-signed, unpacked to `obscura` 72,940,672 B + `obscura-worker` 69,462,608 B.
Baseline: `Google Chrome for Testing 150.0.7871.24` (346 MB unpacked), plugin's own launch args.

Every run: start the browser, poll `http://127.0.0.1:<port>/json/version`, `Target.createTarget` →
`Target.attachToTarget` → `Page.navigate https://www.linkedin.com/feed/` → poll `document.readyState === 'complete'`
→ `Runtime.evaluate` with `awaitPromise: true, returnByValue: true`. RSS = process tree of the spawned pid.
Read-only: the only LinkedIn traffic is GET.

## Cold path

| Run | ready (ms) | nav→complete (ms) | evaluate (ms) | RSS idle (MB) | RSS after page (MB) |
|---|---|---|---|---|---|
| obscura 1 | 59 | 459 | 193 | 22 | 40 |
| obscura 2 | 98 | 479 | 159 | 22 | 40 |
| obscura 3 | 98 | 504 | 138 | 22 | 40 |
| obscura 4 | 159 | 529 | 183 | 22 | 40 |
| chrome, fresh profile 1 | 812 | 385 | 179 | 834 | 1158 |
| chrome, fresh profile 2 | 927 | 433 | 186 | 874 | 1104 |
| chrome, fresh profile 3 | 901 | 359 | 166 | 813 | 1132 |
| chrome, copy of the real 119 MB LinkedIn profile 1 | 1012 | 2078 | 474 | 853 | 1236 |
| chrome, copy of the real profile 2 | 823 | 3385 | 1541 | 872 | 1393 |
| chrome, copy of the real profile 3 | 3148 | 2354 | 2919 | — | — |

`Page.loadEventFired` fires in obscura (399 ms after navigate), so the plugin's `waitForLoad` needs no change.

## The plugin's own expression, unmodified

`linkedinPageExpression({ mode: 'list' })` from `src/linkedin-page.ts`, run over CDP:

- obscura, empty storage dir → `{ ok: false, error: "LinkedIn 401 for /voyager/api/me" }`, total 753 ms.
- Chrome for Testing, copy of the real profile → `{ ok: true, conversations: 20, unread: 2, invitations: 4 }`, total 8889 ms
  (ready 3148 + nav 2354 + read 2919). Sample rows: "Andrea Sophie Stave Lepsøe / Shared a post", "Hugo Pinto / Hi Hugo, good meeting you this week!…".

The real `~/.bb/plugins/unified-inbox/linkedin-profile` was never opened by a browser for this test; it was copied to `/tmp`.

## Cookie persistence

| Probe | Result |
|---|---|
| `document.cookie = 'session_probe=kept-42'`, SIGTERM, restart with same `--storage-dir` | cookie present on second run; `cookies.json` written |
| SIGKILL instead of SIGTERM | storage dir never created (no cookies on disk at all) |
| hand-written jar, camelCase keys (`httpOnly`, `sameSite`) | honoured: seeded cookie visible in `document.cookie` |
| hand-written jar, snake_case keys (`http_only`, `same_site` as the docs show) | silently ignored |
| `stat` on `cookies.json` | `-rw-------`, values in cleartext JSON, dir `drwxr-xr-x` |
| Chrome's own `Default/Cookies` (copy of the LinkedIn profile) | `encrypted_value` prefix hex `763130` (`v10`, Keychain-bound) |

## Protocol surface actually observed

`GET /json/version` →

```json
{"Browser":"Chrome/145.0.0.0","Protocol-Version":"1.3","V8-Version":"15.6.75",
 "User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
 "webSocketDebuggerUrl":"ws://127.0.0.1:<port>/devtools/browser/<uuid>"}
```

- `/json`, `/json/list`, `/json/protocol` also served.
- Methods used successfully: `Target.createTarget`, `Target.attachToTarget` (flatten), `Page.enable`,
  `Page.navigate`, `Runtime.evaluate`, plus events `Page.loadEventFired`, `Page.lifecycleEvent`.
- Rejected flags: `--remote-debugging-port` (`error: unexpected argument`); the port comes from `serve --port`.
- No `DevTools listening on ws://…` line on stderr, so a spawner cannot discover its port.
- Default UA claims Windows while running on macOS arm64; no `--headless` flag needed or accepted (there is no headful mode).

## LinkedIn reachability

- `https://www.linkedin.com/` rendered: title "LinkedIn: Log In or Sign Up", 4 inputs, one form.
- `https://www.linkedin.com/login` and `/feed` returned Cloudflare "Attention Required! / you have been blocked"
  in several attempts — but a **fresh Chrome profile got the same block** in the same minute, so that is an
  IP/rate challenge, not an obscura fingerprint signal.
- `/feed` did load unauthenticated in earlier runs (LinkedIn cookies `bcookie`, `lidc`, `li_gc`, `lang`,
  `JSESSIONID` were set; `/voyager/api/me` → 401 because the jar holds no session).
