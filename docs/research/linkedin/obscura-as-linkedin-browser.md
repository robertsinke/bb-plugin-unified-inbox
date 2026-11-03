---

> Re-checked 2026-11-03: obscura v0.2.6 (its newest release, published the day of this probe)
> adds request interception and CDP responsiveness — still headless-only, still no sign-in window.
> The verdict below is unchanged; the decision it supports is
> `decisions/0003-the-session-is-minted-where-it-reads.md`.

title: Obscura as the browser for LinkedIn reads — can it replace Chrome for Testing?
description: Protocol, persistence, macOS support, measured startup and memory, and containment for obscura 0.2.5 against the unified-inbox LinkedIn read path
type: research-note
status: settled
date: 2026-11-02
tags:
  - research
  - provisional
  - linkedin
  - unified-inbox
  - browser
sources:
  - resource: ./sources/2026-10-31-obscura-readme.md
  - resource: ./sources/2026-10-31-obscura-persist-cookies-and-storage.md
  - resource: ./sources/2026-10-31-obscura-cli-reference.md
  - resource: ./sources/2026-10-31-obscura-connect-puppeteer-playwright.md
  - resource: ./sources/2026-10-31-obscura-site.txt
  - resource: ./sources/2026-10-31-obscura-measurements.md
  - resource: ./sources/2026-10-31-handoff-probe-log-round1.jsonl
  - resource: ./sources/2026-10-31-handoff-probe-log-round2.jsonl
  - resource: ./sources/2026-10-31-handoff-probe-log-round3.jsonl
---

## Question

Can [obscura](https://www.obscura.sh/) replace the Chrome for Testing binary that `src/linkedin-chrome.ts`
spawns for LinkedIn reads — same code, same persistent signed-in profile, same read-only in-page `fetch`?

## Verdict

**No-go.** The protocol is compatible and the numbers are dramatic, but the session cannot get in. Obscura has
no window to sign in through, and the one silent alternative — carrying Chrome's cookies across — was measured
on a burner account on 2026-10-31 and is a **one-shot**: obscura's single read with Chrome's cookies succeeded
and LinkedIn immediately revoked the session, logging the account's own browser out (`li_at` deleted, `/feed`
redirected to `/uas/login`). That is the failure already recorded on 2026-10-29, reproduced deliberately
([spike](./spike-sidecar.md), [handoff probe](#handoff-probe-on-the-burner-account-2026-10-31),
[plan](../../plans/2026-10-28-002-feat-linkedin-inbox-source-plan.md)). Headful is not valued for its own sake;
it is currently the only mechanism where the session is created by the same client that later uses it, and that
is the requirement that keeps failing. Full reasoning in *Tentative recommendation*.

## Findings

### 1. It speaks real CDP, including `Runtime.evaluate` with `awaitPromise`

`GET /json/version` answers with `webSocketDebuggerUrl`, and `/json`, `/json/list`, `/json/protocol` are
served too (verified on the running binary; the same surface is asserted in the project's
`control_plane_unblocked` test). `Target.createTarget`, `Target.attachToTarget` (flatten), `Page.enable`,
`Page.navigate`, `Runtime.evaluate`, `Page.loadEventFired` all behave as Chrome does. `Runtime.evaluate`
honours `awaitPromise` and `returnByValue` — it is a first-class CDP feature in this codebase, not an
accident of our probe. Evidence: [README CDP table](./sources/2026-10-31-obscura-readme.md),
[measurements](./sources/2026-10-31-obscura-measurements.md).

The differences are in the launcher, not the protocol: there is no `--remote-debugging-port` (the port comes
from `serve --port`), no `DevTools listening on ws://…` line on stderr, and the process is a long-lived
server rather than a per-read browser. `browserArgs()` and `parseDevtoolsUrl()` would both have to go.

### 2. Persistence works, but only on a graceful shutdown, and only for cookies + localStorage

`serve --storage-dir <dir>` writes `cookies.json` and one `localStorage/<origin>.json` per origin, and a
restart starts with them loaded. Verified end-to-end: a cookie set in-page survived SIGTERM and a restart.
SIGKILL loses the *entire directory* — the storage dir is created at flush time, so a browser we kill hard
leaves nothing behind. IndexedDB and `sessionStorage` are explicitly not persisted
([persistence doc](./sources/2026-10-31-obscura-persist-cookies-and-storage.md)).

There is **no interactive sign-in**: the source has no headful/headed/window path at all, and the CLI has no
visible-window flag. `bb unified-inbox linkedin-signin` has no obscura equivalent. The only sign-in obscura
supports is the scripted one its own docs describe — "drive a login flow once via Puppeteer or Playwright"
([persistence doc](./sources/2026-10-31-obscura-persist-cookies-and-storage.md)) — which means the account
password passes through the plugin. The jar *is* writable from outside (a hand-written `cookies.json` is
honoured, in obscura's own camelCase shape; the docs' snake_case field names are silently ignored), so cookie
import is mechanically possible.

### 2b. Why cookie import was rejected — evidence, not principle

The objection is not "cookies are precious". On 2026-10-29 the plugin's predecessor did exactly this: read the
browser's cookie store (plaintext values, no Keychain prompt needed) and called Voyager from Node. It worked —
`200` on `/voyager/api/me`, the conversations query, invitations, and one thread's messages. Minutes later
`li_at` was gone from the cookie store and the real browser was redirecting `/feed/` to `/uas/login`. LinkedIn
rotates and can invalidate a session presented by a different client, and that killed the user's own signed-in
session, not just the copy ([spike](./spike-sidecar.md)). Requirement R6 — no LinkedIn credential, cookie, or
session token in plugin storage, logs, or RPC — was written from that outcome
([plan](../../plans/2026-10-28-002-feat-linkedin-inbox-source-plan.md)).

The same objection transfers to obscura intact: a cookie exported from the Chrome profile was minted and
fingerprinted for Chrome (TLS stack, UA, header order). Obscura's traffic leaves through rustls/`wreq`, or
BoringSSL in the `-stealth` build, with a Windows UA on macOS. That is precisely the "used from a different
client" signal that invalidated `li_at` before, and now a failure would cost the session outright, because
obscura has no window to re-sign-in through.

Whether a *sequential* handoff (Chrome signs in, Chrome closes, obscura uses the cookies) trips the same
heuristic as the observed *concurrent* second client is untested. The only measured data point is that a second
client killed the session.

### 3. macOS arm64: yes, single tarball, Apache-2.0, free

`obscura-aarch64-macos.tar.gz` (67 MB, sha256 `fcca31eb…`) unpacks to a 70 MB `obscura` and 66 MB
`obscura-worker`; no Node, no Chrome, no dependencies, adhoc-signed so Gatekeeper may complain if downloaded
through a browser. Apache-2.0, no feature gating; the paid offering is a separate managed cloud
([site](./sources/2026-10-31-obscura-site.txt)). The repo is young — created 2026-04-13, 29.9k stars,
207 open issues, latest release 0.2.5. Compare: Chrome for Testing is 346 MB unpacked.

### 4. Startup and memory, measured here

| | obscura 0.2.5 | Chrome for Testing 150 (fresh profile) | Chrome for Testing 150 (real LinkedIn profile copy) |
|---|---|---|---|
| ready (`/json/version`) | **59–159 ms** | 812–927 ms | 823–3148 ms |
| navigate `/feed` → complete | **459–529 ms** | 359–433 ms | 2078–3385 ms |
| in-page evaluate | **138–193 ms** | 166–186 ms | 474–1541 ms |
| idle RSS | **22 MB** | 813–874 MB | 853–872 MB |
| RSS after LinkedIn page | **40 MB** | 1.1–1.4 GB | 1.2–1.4 GB |

Navigation and evaluation are at parity; the whole win is process start and memory. On the path that matters
to us — cold read including launch — obscura finished the plugin's expression in **753 ms** where Chrome took
**8.9 s** with the real profile. That is the 5.4 s launch cost the plugin currently pays, gone.

### 5. Containment

- No telemetry, analytics, or call-home found in the source (grep for telemetry/analytics/sentry/posthog and
  for hardcoded `obscura.sh` endpoints: only test fixtures). Page content stays in the process.
- **Credentials and cookies sit in cleartext.** `cookies.json` is `-rw-------` JSON with readable values;
  Chrome stores the same cookies as `v10` blobs whose key lives in the macOS Keychain. Switching moves the
  LinkedIn session from encrypted-at-rest to plaintext-at-rest. For a session that can read a person's whole
  inbox, that is a real downgrade, not a footnote.
- The default UA is a **Windows** Chrome 143 string while the process runs on macOS arm64, and the engine is
  not Chromium (Rust + embedded V8). Against a bot-detecting site with a real account, that mismatch is the
  kind of thing that produces challenges or account restrictions. We saw Cloudflare blocks during testing,
  but a fresh Chrome profile got the same block in the same minute, so those were IP/rate challenges, not
  evidence about obscura's fingerprint either way.

## Handoff probe on the burner account (2026-10-31)

Question this settles: does a session minted in Chrome by a human survive being presented by obscura?
Burner account, throwaway Chrome profile under `/tmp`, cookies moved over CDP (`Network.getAllCookies` →
`setCookies`), so nothing was decrypted off disk and the HttpOnly `li_at` was never read from the profile file.
Every LinkedIn request was a GET.

Timeline, all times UTC:

| Time | Event | Result |
|---|---|---|
| 16:01:55 | signed in by hand in a fresh Chrome profile | 13 LinkedIn cookies, `li_at` present |
| 16:01:58 | **C1** read in that profile | ok — 1 conversation, 1 unread |
| 16:02:01 | 13 cookies moved into obscura | all injected, `li_at` included |
| 16:02:08 | **A** obscura's first read | **ok — 1 conversation, 1 unread, 2383 ms** |
| 16:02:22 | **B** a fresh Chrome profile, same 13 cookies | 401, redirected to `/uas/login` |
| 16:03:56 | **C2b** the birth profile again | `/feed` → `/uas/login`, and **`li_at` was gone from the profile** |
| 16:04:19 | **A2** obscura again | 401 — session dead there too |

(The burner's inbox holds 1 conversation / 1 unread because it is a new account; the shape of the inbox is
not what this measures.)

**Finding: the handoff authenticates exactly once, then the session is destroyed — everywhere, including the
profile that minted it.** Obscura's first read with Chrome's cookies returned real data. Within two minutes
LinkedIn had deleted `li_at` from the birth profile and refused every client. That is the same outcome the
spike hit with Node on 2026-10-29, reproduced with obscura as the second client: the cookie survives being
*presented*, not being *used*, outside the client that minted it.

Rounds 1–2 cannot say whether obscura caused the death or whether any second client would have. Arm B ran
between A and C2b, so it is a possible co-cause. Round 3 below removes that variable.

### Round 3: obscura as the only second client

Signed in again in the same throwaway profile, then let obscura be the only client that touched the session —
no fresh-Chrome arm at all:

| Time | Event | Result |
|---|---|---|
| 16:05:00 | signed in by hand again | `li_at` present |
| 16:05:24 | **C3** read in the birth profile | ok — 1 conversation, 1 unread |
| 16:05:49 | **A3** obscura's only read | **ok — 1 conversation, 1 unread, 11.8 s** |
| 16:07:19 | **C3b** the birth profile, 90 s later | `/feed` → `/uas/login`, `li_at` **gone from the profile** |

**Finding: obscura's use alone is enough to invalidate the session.** One obscura read returned real data, and
the account's own browser was logged out as a direct consequence. No second Chrome was involved. So the
sequential handoff is not a migration, it is a one-shot read with the user's session as the price.

Not isolated: whether *any* different client would trigger the same revocation, or obscura specifically
triggers it. Round 1–2 cannot answer that, because the fresh-Chrome arm ran after obscura. It does not change
the conclusion — obscura is a different client today, and would only stop being one if the session were minted
inside obscura, which is the headful path it does not have. Raw logs: `/tmp/handoff/log{,2,3}.txt`.

## Prototype result

Ran the plugin's own `linkedinPageExpression({ mode: 'list' })`, unmodified, against obscura over CDP:

- obscura, empty `--storage-dir` → `{ ok: false, error: "LinkedIn 401 for /voyager/api/me" }` in 753 ms total.
- Chrome for Testing against a **copy** of the real profile → `{ ok: true, conversations: 20, unread: 2, invitations: 4 }`
  in 8889 ms total.

So the expression, the CDP handshake, the in-page `fetch` and the cookie jar all work in obscura. The 401 is
the missing session, nothing else. The real `~/.bb/plugins/unified-inbox/linkedin-profile` was never opened
by a browser for this test — it was copied to `/tmp` first, and nothing was written to LinkedIn: no accept,
no reply, no mark-read, no UI clicks. Numbers and commands: [measurements](./sources/2026-10-31-obscura-measurements.md).

## The three ways to get a session into obscura

| Path | New secrets | R6 | Session validity | Verdict |
|---|---|---|---|---|
| Headful sign-in in obscura | none | clean | born in the reading client | **not supported** — obscura has no window |
| Scripted login over CDP (obscura's documented path) | the account password, per sign-in | clean only if never stored or logged; the password still crosses the plugin RPC contract | born in obscura, may hit a challenge/2FA wall | possible, costly, unproven |
| Cookie export from the Chrome profile | none | **violated** — a session token lands in plugin-readable storage | **measured 2026-10-31: works exactly once, then the session is revoked everywhere** | rejected on evidence |

Headful is not the requirement; "the session is created in the client that uses it" is. Headful is simply the
only variant that satisfies that today without putting the password through the plugin.

## What would break if we switched

1. **Sign-in.** `bb unified-inbox linkedin-signin` becomes unimplementable as designed (no visible window).
   Replacing it means scripting credential entry from inside the plugin, or exporting cookies out of the
   Chrome profile into a cleartext jar.
2. **Launcher.** `parseDevtoolsUrl()` → fixed `serve --port` (and a port-collision path: during testing a
   stray listener on the chosen port answered `/json/version` and looked exactly like our browser).
   Browser-per-read becomes one long-lived server, so the 90 s idle-stop and the two-reads-at-a-time gate
   need rethinking.
3. **Durability.** Cookies flush on graceful shutdown only; our current `stop()` escalates to SIGKILL after
   3 s, and a SIGKILLed browser loses the session cookies it just refreshed.
4. **Storage fidelity.** IndexedDB and `sessionStorage` do not survive a restart, so "the session survives"
   is true for cookies and localStorage only.
5. **Containment.** The live LinkedIn session would sit in cleartext JSON instead of a Keychain-encrypted
   store, behind a UA string that claims Windows on an Apple-silicon Mac.

## Open questions

- Is the revocation triggered by *any* different client, or by obscura's fingerprint specifically? Answering it
  needs a sign-in, then a *different Chrome profile* as the only second client, then a re-check — the arm order
  rounds 1–2 did not give us. It matters only for a future where sign-in happens inside the obscure client.
- Would a session minted *inside* obscura (its documented Puppeteer/Playwright login flow) survive repeated
  reads? That is the one configuration the probe could not test, and the one that would actually work if it did.
- Does obscura's non-Chromium engine hold up under LinkedIn's own app JS beyond the first navigation, or does
  the feed app start throwing once it touches an API obscura does not implement?
- What would an obscura update policy look like for a pre-1.0 dependency that owns an authenticated session?

## Tentative recommendation

**No-go, and the cookie-export escape hatch is now closed by measurement.** The handoff read worked once and
cost the account its session, in a single-variable run where obscura was the only outside client. A plugin that
must read every few minutes cannot spend the session on the first read.

What would reopen this is narrow and specific: a session minted *inside* obscura — its documented
Puppeteer/Playwright login flow, or a headful mode if one ever ships — surviving repeated reads. That is the
one arm the probe could not run, and it is the arm that would work if obscura's client identity is acceptable
to LinkedIn when it is not a second client. The transport side is already proven: same expression, 753 ms cold
read vs 8.9 s, 22–40 MB vs 0.9–1.4 GB resident, everything unmodified.

Cheap partial use today: nothing. Every read we do needs the session, so obscura's public-page mode — where it
is genuinely strong — has nothing to apply to.

## Further reading

- [LinkedIn as an inbox source — access options](./linkedin-inbox-options.md) — broader transport survey.
- [Sidecar restart review](./sidecar-restart-review.md) and [browser session diagnostic](./browser-session-diagnostic.md)
  — prior work on keeping the session without exporting it.
- [Unread-preserving sync options](./unread-preserving-sync-options.md) — why reads must not mark messages read.
- Obscura: [README](./sources/2026-10-31-obscura-readme.md), [persistence](./sources/2026-10-31-obscura-persist-cookies-and-storage.md),
  [CLI reference](./sources/2026-10-31-obscura-cli-reference.md),
  [Puppeteer/Playwright connection](./sources/2026-10-31-obscura-connect-puppeteer-playwright.md),
  [site text](./sources/2026-10-31-obscura-site.txt), [measurements](./sources/2026-10-31-obscura-measurements.md).
- Handoff probe raw logs: [round 1](./sources/2026-10-31-handoff-probe-log-round1.jsonl),
  [round 2](./sources/2026-10-31-handoff-probe-log-round2.jsonl),
  [round 3](./sources/2026-10-31-handoff-probe-log-round3.jsonl).
