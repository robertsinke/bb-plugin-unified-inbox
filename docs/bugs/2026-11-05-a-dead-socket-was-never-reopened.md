---
title: "Bug report — a dead WhatsApp socket was silent, and the card still said connected"
status: settled
date: 2026-11-05
---

# Bug report — a dead WhatsApp socket was silent, and the card still said connected

**Filed:** 2026-11-05 · **Owner:** `src/whatsapp/lifecycle.ts`, `src/whatsapp/pairing.ts`, `src/whatsapp/transport.ts` ·
**Status:** cause named, fixed here, live proof is the parent's

## Symptom

The owner's paired socket stopped answering at some point on 2026-11-05, and nothing ever opened
another one:

- every media read failed with `This media could not be loaded.`, and the row stayed
  `media_state = 'placeholder'` — a download that never happened is not a verdict on the message;
- a send failed with `Nothing was sent: WhatsApp is not connected.`;
- `bb plugin rpc call unified-inbox whatsapp_pairing` answered **`connected`** throughout;
- `bb plugin reload unified-inbox` restored both at once: a 159,297-byte JPEG downloaded and served
  as `ready`.

## What was measured

The host log (`~/.bb/logs/server.13.log`) has the whole story and none of the reason:

```
15:46:47.033 plugin unified-inbox@0.1.0 loaded
15:46:47.070 [plugin:unified-inbox] service whatsapp-connection stopped
15:48:01.078 plugin unified-inbox@0.1.0 loaded
15:48:01.082 [plugin:unified-inbox] service whatsapp-connection stopped
15:58:19.766 plugin unified-inbox@0.1.0 loaded
15:58:19.771 [plugin:unified-inbox] service whatsapp-connection stopped
16:01:00     rpc media failed: This media could not be loaded.
```

Three starts ended 4–5 ms after load: faster than any socket open, so the service returned without
holding one — either the account check or a start the lock refused. After 17:59:47 there is no stop
line at all, and media still failed from 18:17, so that instance's socket went away inside
`WhatsAppConnection` and nothing recorded it. **Neither case can be told apart from the log today**,
because no code wrote a line for it. That gap, not the specific trigger, is the defect.

`socket.lock` is stamped 18:21 and `creds` 18:26: the account was linked the whole time the card said
`connected`.

## Root cause

Three separate holes, one story:

1. **A call that needed the socket could only read `current()`.** `src/whatsapp/transport.ts` returned
   `{ info }` when `getMediaSocket()` was `undefined` and let `send.ts` throw
   `WhatsAppDisconnectedError`. `lifecycle.open()` was already single-flight and already kept a
   refusal, so a reopen was one call away and nobody asked. A recoverable state became a dead source.
2. **`connected` came from the credential files.** `src/whatsapp/pairing.ts` ended with
   `linked(undefined) ? { state: 'connected' } : { state: 'unpaired' }`. With the lifecycle empty and
   no failure kept (both are cleared by `close()`), the card answered `connected` over the exact
   state that is not connected — the lie this module was written to stop.
3. **Two failures shared one sentence.** A missing socket and a message WhatsApp will no longer serve
   both reached the panel as `This media could not be loaded.` Only the second is permanent.

## What was changed here

- `lifecycle.ensure()` — `open()` for a caller that cannot throw: a linked account is reopened on
  demand, and a refusal is kept in `failure()` and answered with `undefined`. `opening()` exposes
  whether an open is in flight. `close(reason)` and the connection's own `connection-closed` event are
  written as one line each, so a stopped or dropped socket is diagnosable from the plugin log.
- `WhatsAppConnection` reports `connection-closed` with WhatsApp's words and the reconnect delay
  (`#scheduleReconnect` now returns it), instead of disappearing into a silent ladder.
- `transport.loadMedia` and `sendText` ask for a socket before they give up; with none, the answer is
  `notConnected: true` and **no** row is written, so a later open may still fetch it.
- `pairing.state()` never answers `connected` without a socket: an open in flight is `connecting`, and
  anything else is `failed` with the socket's words, or with the act that reopens it.
- `src/adapters/whatsapp.ts` words the third path: `WhatsApp is not connected, so this media cannot be
  fetched yet. Reconnect it and try again.` beside the unchanged `This media is no longer available.`

## What the tests pin

`tests/whatsapp/lifecycle.test.ts` — `ensure()` reopens a socket the lifecycle no longer holds, a
refused ask answers `undefined` and keeps its words, `opening()` is true only while an open is in
flight, the recorded lines carry the open, the caller's close reason and WhatsApp's close reason, and a
linked account with no socket is `failed` (never `connected`) whether or not an open is on its way.
`tests/whatsapp/connection.test.ts` — a close reports its reason and the retry delay.
`tests/whatsapp/transport.test.ts` — a picture no socket could serve is fetched by opening one, a send
asks for one first, and with nothing to ask the answer is `notConnected` with the row left
`placeholder`. `tests/adapters/whatsapp.test.ts` — the two failures read differently.

## Not verified here

No test opens a socket against the live account state: `connectionReplaced` spends a device slot and
re-pairing is the ban lever, so every test runs on fakes and the live proof is the parent's reload
plus one media read and one send.

## Why the socket actually died

The child left this as "not fully recoverable". It was recoverable, and the parent found it on the live
account: **`creds.registered` is `false` on a device paired by QR.** Read of the live state through the
plugin's own `createFileAuthStore()`: `registered = false | has me = true | hasCreds = true`. rc13 sets
that flag in one place only, `Socket/messages-recv.js` on the pair-device path, so a device paired by
scanning a QR keeps a live identity with the flag still false.

`WhatsAppConnection.registered()` answered from that flag, and `armIdle()` reads it as "still a pairing
in progress, so a timer may stop it". Every linked socket therefore got the ten-minute idle timer, and
`close()` at that time wrote nothing. Timeline matches to the minute: the plugin reloaded at 18:02:54,
opened one socket, kept receiving until 18:06:56, and the socket was gone by 18:17 — with no stop line
anywhere, because there was nothing to log.

The fix is the definition, not the timer: `registered()` now answers from the device identity
(`creds.me?.id`), which is what "linked" means. `tests/whatsapp/lifecycle.test.ts` pins the exact state —
`me` present, `registered: false`, idle window 20 ms — and asserts the socket survives it.
`tests/whatsapp/fake-socket.ts` now carries an identity for a linked fake, so a fake cannot model a
device that does not exist.
