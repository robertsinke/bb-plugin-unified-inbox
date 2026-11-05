---
title: "Baileys 7.0.0-rc14 against our pin: measured, and held at rc13"
description: "rc14 installs, patches after a one-line anchor fix, keeps 487 tests green, grows the bundle by 426 bytes, and still reaches pairing-needed — but nothing in it touches a path the plugin uses, so the pin stays at rc13."
type: research-note
status: settled
date: 2026-11-05
tags: [research, whatsapp, baileys, dependencies, build]
sources:
  - resource: ./2026-11-05-whatsapp-transport-a-stranger-can-install.md
---

# Baileys 7.0.0-rc14: safe to adopt, and not worth adopting

**Date:** 2026-11-05
**Machine:** this macOS checkout, `baileys` pinned at `7.0.0-rc13`; `npm view baileys dist-tags` answers
`latest: 7.0.0-rc14`, `legacy: 6.7.24`, and rc14 is still the newest published version.
**Evidence class:** measured. rc14 was installed into this worktree, patched, typechecked, tested, bundled and
opened as a socket; the tree was then put back on rc13 and rebuilt to the byte. No device paired, no pairing code
requested, no account touched, no plugin reloaded.

## Verdict: hold rc13. rc14 is compatible, and buys nothing.

The question is not "is rc14 safe" but "what does rc14 change that reaches the plugin". The answer is nothing
that the plugin calls — and the price of the two-line bump is that the mandatory desktop-pairing patch has to be
rewritten, on an anchor that upstream has already moved once for an unrelated reason.

## What was measured

| probe | rc13 (today) | rc14 |
|---|---|---|
| `node _tools/patch-baileys.mjs` | applies | **throws** — `Unsupported Baileys validate-connection.js layout; missing: platform: proto.ClientPayload.UserAgent.Platform.WEB,` |
| same patch, one anchor rewritten | — | applies; `--check` passes |
| `npm run typecheck` | pass | pass |
| `npm test` | 487 pass | 487 pass |
| `npm run build` → `dist/server.js` | 5,960,701 B | 5,961,127 B (**+426 B**) |
| bundle evaluates in bare node | `BUNDLE LOADED, exports: [ 'default' ]` | same |
| socket, scratch state dir | `connecting → pairing-needed → disconnected` | `connecting → pairing-needed (qr 277 chars) → disconnected` |

The socket probe used `UNIFIED_INBOX_WHATSAPP_AUTH=/tmp/wa-rc14-proof`, an empty scratch directory: the live
`~/.bb/plugins/unified-inbox/whatsapp-auth` holds only its `key` file and no creds, so an empty directory is the
same unpaired state without writing anything into the live one. It is the U1 shape — open, print the states,
close.

## The premise that was wrong: `whatsapp-rust-bridge` is already a rc13 dependency

The task's stated risk was that rc14 adds a dependency rc13 does not have, and that a native or WASM module the
bundler cannot inline would fail at plugin load. **Both versions declare `whatsapp-rust-bridge: 0.5.4`, and both
import it from the same three files** (`Utils/crypto.js` re-exports `md5`/`hkdf` from it, `Utils/lt-hash.js` takes
`LTHashAntiTampering`, `Utils/chat-utils.js` takes `expandAppStateKeys`). The module has a WASM payload of about
2 MB, base64-inlined in its own `dist/index.js` — no loose `.wasm` file for a bundler to lose — and the shipped
5.7 MB `dist/server.js` already contains it. The +426 B is the entire rc14 delta, which is the measurement that
settles the bundler question: there is nothing new to inline.

`sharp`, `jimp`, `audio-decode` and `link-preview-js` are peers, not new dependencies; rc13 already carried the
same `sharp` peer, and Baileys reaches them only through `await import()` inside media and link-preview helpers.

## What rc14 actually changes

Twenty-eight files differ between the two published tarballs, of which seven are runtime code; the rest are
`.d.ts` and `.map`. `WAProto/` is byte-identical, and no runtime file under `Socket/messages-recv.js` or
`Socket/messages-send.js` changed — message upserts and media handling are untouched.

| file | change | reaches the plugin? |
|---|---|---|
| `Defaults/index.js`, `Utils/generics.js` | bundled WA Web version `1035194821 → 1043857760` | **No.** `src/whatsapp/version.ts` probes at runtime and falls back to `[2,3000,1043856522]`, so the bundled constant is never presented. |
| `Utils/validate-connection.js` | the Android platform ternary, `webInfo` skipped for Android, `ANDROID_PHONE` platform type | **Only as the broken patch anchor.** The plugin passes `Browsers.macOS('Desktop')`; the Android branch is dead for us. |
| `Utils/browser-utils.js`, `Socket/socket.js` | a `Browsers.android` tuple and a warning when it is used | No — we never build an Android tuple. |
| `Socket/chats.js` | `profilePictureUrl` builds its `picture` node per call and attaches the tctoken with its `t` timestamp, only for user JIDs | No — the plugin never calls `profilePictureUrl`; WhatsApp avatars are not read. |
| `Utils/tc-token-utils.js` | `buildTcTokenFromJid` treats `timestamp === undefined` as expired and sends `attrs.t` | Only via `profilePictureUrl` and `presenceSubscribe`, neither of which the plugin calls. |

The one behavioural fix in the release — a shared `baseContent` array in `profilePictureUrl` that put the previous
caller's picture type on the next request — is real, and in a function this plugin does not call.

## What would change the answer

Bump to rc14 — and rewrite the patch anchor in the same commit — when one of these becomes true:

1. **rc13 is refused at the handshake even after the version probe.** Today the stale bundled constant is already
   worked around by the probe, and rc14's constant is 1,238 builds newer than our fallback and still not what is
   presented. If WhatsApp starts rejecting the connection outright rather than the version, the release that
   carries the fix is the one to take.
2. **rc14 or later fixes something in message upserts, history sync, media fetch, or the reconnect path.** The
   diff is the test: nothing under `Socket/messages-recv.js`, `Socket/messages-send.js` or `Media/` changed.
3. **A pairing or history failure is traced to the profile-picture or tctoken path.** Then the tctoken fixes stop
   being academic.
4. **Another release needs the patch rewritten anyway** — at that point the anchor rewrite is free, and the
   smallest release that carries any of the above is the one to take.

Until then the pin is the cheaper invariant: one version, one patch anchor, one state in which "the patch
applies" is a fact rather than a variant. When it is bumped, `_tools/patch-baileys.mjs` needs its second
replacement to match rc14's three-line ternary —

```
        platform: config.browser[1].toLocaleLowerCase().includes('android')
            ? proto.ClientPayload.UserAgent.Platform.ANDROID
            : proto.ClientPayload.UserAgent.Platform.WEB,
```

— becoming `        platform: getUserAgentPlatform(config),`, with the `Windows: … WIN32 → WIN_HYBRID` and the
injected `getUserAgentPlatform` helper unchanged. That was verified here: with that one anchor rewritten, the
patch applies, the suite is 487/487, and a socket reaches `pairing-needed`.
