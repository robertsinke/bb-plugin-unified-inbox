---
title: "Pricing a Baileys WhatsApp transport: own it, or keep WhatsAgent"
description: "What the plugin asks of WhatsAgent today, what an in-plugin Baileys transport would make us own, the first production failure, maintenance and ban exposure, and why the transport is already Baileys three hops away."
status: settled
date: 2026-11-05
---

# Pricing a Baileys WhatsApp transport

**Date:** 2026-11-05
**Machine:** local macOS checkout; WhatsAgent headless backend pid 49510 on loopback port 63765, Baileys
`7.0.0-rc13`, account paired 2026-10-11
**Evidence class:** measured against the live WhatsAgent runtime with read-only calls (`initialize`,
`tools/list`, `list-chats`, `get-messages`), the plugin's own source, and the WhatsAgent source on this disk.
No message sent, no dependency installed, no code changed.

## Verdict: keep WhatsAgent. Do not port Baileys into the plugin.

The question "what does owning WhatsApp cost, compared with keeping WhatsAgent" has a premise worth stating
before the answer: **WhatsApp is already Baileys.** WhatsAgent is a local Baileys client with its own SQLite
store, its own encrypted auth state, its own outbox, its own reconnect supervisor and its own tests. It is not
a third-party dependency in the sense Gmail's `gws` was — it is a second program of ours, on this disk, built
from the same library a port would import. So the decision is not "adopt Baileys or not". It is "move 1,782
lines of working, tested protocol code across a process boundary, or leave it where it is".

Moving it buys one thing: no second process. It costs the whole transport. The measured surface a port would
have to re-create is in [What Baileys would make us own](#what-baileys-would-make-us-own); the part that
already exists elsewhere and works is in [the comparison](#the-comparison).

## What the plugin asks of WhatsAgent today

Four MCP tools and four loopback HTTP routes. That is the entire coupling: no protocol knowledge, no socket,
no encryption, no auth state in this repository.

| call | shape the plugin depends on | file |
|---|---|---|
| `list-chats` | `{filter:'all', limit, offset}` → `items[]` newest-first, `has_more` | `src/adapters/whatsapp.ts` `listChats` |
| `get-messages` | `{chatJid, limit:60}` → `items[]` newest 60, `sender{name, display_jid}`, `media{cached,error,mime,filename,size}` | `src/adapters/whatsapp.ts` `openChat` |
| `load-media` | `{messageId}` → media verdict (caches inside WhatsAgent) | `src/adapters/whatsapp.ts` `image` |
| `mark-read` | `{chatJid}` → local cursor only | `src/adapters/whatsapp.ts` `action` |
| `GET /api/chats/:jid/messages?limit=1` | sender of a group's last message; 1 s timeout | `src/adapters/whatsapp.ts` `previewSender` |
| `GET /api/chats/:jid` | chat title; 1 s timeout | `src/adapters/whatsapp.ts` `chatTitle` |
| `POST /api/chats/:jid/messages` | `{text}` → 202 + row; **no bearer token, `Origin` only** | `src/whatsapp-send.ts` |
| `GET /api/messages/:id/media` | bytes with `content-length` and `content-type` | `src/adapters/whatsapp.ts` `image` |

Ids are WhatsApp's own: a chat JID (`…@g.us` for groups, `…@s.whatsapp.net` for people) and a message id. The
plugin treats both as opaque strings and relies on `endsWith('@g.us')` for the group branch — nothing else.

**Ordering and liveness assumptions**, all of which the plugin states in comments and none of which it can
enforce:

- `list-chats` is newest-first and `has_more` is authoritative. Verified on the live runtime: 50 rows,
  `last_msg_at` strictly descending, `has_more: true`.
- The cursor advances by the rows the backend **returned**, not the rows kept after the plugin filters
  archived chats, or the same page would be re-read forever (comment at the cursor's construction site).
- `get-messages` returns the newest 60; the plugin never pages backwards, so older history is invisible.
- A send is accepted when the POST answers 2xx. WhatsAgent's `send` action is frontend-only and enqueues to a
  paced outbox — it never calls `sendMessage` itself (`~/dev/whatsagent/server/actions/send.ts`). The plugin
  prints `Sending.` at that point and never learns the outcome.
- Media must have been cached by a `load-media` call before the bytes route will answer.

Measured cost of that list on this machine (2026-11-05): `list-chats` 491 ms for 50 rows of which 28 are
groups, and **9 of those groups need a second HTTP round trip** to name the preview sender — 6-at-a-time, one
second timeout each. `get-messages` 653 ms for 60 rows. So one list refresh is roughly eleven loopback
requests, not one. That fan-out exists only because `list-chats` does not return the preview sender.

**Field drift already visible.** The live `list-chats` rows carry `jid, channel, name, kind, last_msg_at,
unread, muted, archived, agent_state, last_read_msg_id, display_jid, needs_reply, preview, preview_from_me,
draft_status` — no `avatar_url`, which the adapter reads (`sourceAvatarUrl(c.avatar_url, 'whatsapp')`), and
`preview` arrives as `null` rather than a string. Both are absorbed silently. Nothing is broken, but this is
what a coupling to another program's JSON looks like from the inside: fields arrive and leave without a type
error.

## What Baileys would make us own

### Auth state, and the two ways it is lost

WhatsAgent's auth state is not a cookie file. Measured on this account today: **5,538 encrypted rows, 1.30 MB**
in `wa_auth_keys`, plus one `wa_auth_creds` row, across ten key types — `lid-mapping` 3,021, `pre-key` 1,448,
`identity-key` 325, `session` 323, `sender-key` 301, `app-state-sync-key` 80, `tctoken` 23, `device-list` 11,
`app-state-sync-version` 5, `sender-key-memory` 1. It is AES-256-GCM encrypted with a key in the macOS login
keychain (`whatsagent.whatsapp-auth`), in an `0600` database in an `0700` directory
(`~/dev/whatsagent/server/channels/whatsapp/auth-store.ts`; README "your local data is worth protecting"). In
the plugin, that file would move beside the Gmail credential and the inbox cache, inside BB plugin storage,
and the keychain item would have to be created and re-authorized by whatever process BB runs the plugin in.

The two loss cases are not symmetrical:

- **Lost** (deleted data dir, a machine rebuild without a keychain migration): no reconnect helps. WhatsApp
  reports `loggedOut`, which WhatsAgent treats as terminal and surfaces as `logged-out`, and the owner must
  pair again by scanning a QR (`connection.ts` `#handleConnectionUpdate`; `server/api/session.ts`). Re-pairing
  is the documented ban trigger, so a lost session is not only an outage — it is the risk event.
- **Copied** (Time Machine restore, a synced folder, a second machine): two live sockets present the same
  device identity. WhatsApp closes one with `connectionReplaced` (440) — one of the five status codes
  WhatsAgent classifies as transient, because a socket that went away mid-send is not a rejected payload
  (`~/dev/whatsagent/server/outbox/failure.ts`). The visible result is a session that flaps between two
  machines, and a device slot consumed on the phone.

Baileys also persists `lid-mapping` keys, and that is not housekeeping: 3,021 of the 5,538 rows are the
LID↔phone-number map, and WhatsAgent has a repair path that **merges two chat rows** when a mapping arrives
late (`handleLidMappingUpdate`, plus the `chats-merged` event and its backfill in `connection.ts`). A port
inherits that: the plugin's cache is keyed by conversation id, so a late LID mapping is a cache migration, not
a field update.

### Multi-device re-pairing

Baileys connects as a linked device, exactly like WhatsApp Web. Pairing is a QR: Baileys keeps the first one
for 60 s and rotates every 20 s (`QR_TTL_MS` in `server/api/session.ts`), and a stale QR is a dead QR, not a
retry. The plugin has no QR surface at all today — the panel draws conversations and a composer. A port must
add a pairing state, a QR render, expiry, and a re-pair flow reachable when the inbox is empty, because
"empty inbox" and "unpaired device" look identical from the list.

### Reconnect after a laptop sleeps

WhatsAgent runs a reconnect ladder: 5 s doubling to a 60 s ceiling, ten doublings, reset on a successful open;
`loggedOut` is terminal and stops the ladder (`connection.ts` `#scheduleReconnect`). Every send that failed
while the socket was down is held in a persisted outbox and retried with classification — `offline`,
`transient`, `terminal` — where **an unknown error means retry**, deliberately, because guessing "terminal"
silently drops a message the owner approved (`~/dev/whatsagent/server/outbox/failure.ts`).

None of that is protocol work, and all of it is work. In the plugin, `bb.background.service('refresh-whatsapp')`
would own the socket, so a dead socket means a refresh loop that fails every 8 seconds; the reply path has no
queue at all, and `sendFromComposer` would have to grow one, with an attempt cap and a terminal state, or
accept loss.

### Duplicate and out-of-order delivery

WhatsApp redelivers: history sync replays batches, a re-sent message arrives with the same id, a reaction or
an edit arrives as an update to a message already stored. WhatsAgent absorbs this in one place, an idempotent
upsert keyed on the WhatsApp message id, which also preserves cached media across a replay
(`~/dev/whatsagent/server/store/messages.ts` `upsertMessage`, `ON CONFLICT(id)`). Its ingest layer maps about a
dozen message shapes and two update kinds (edits as `secretEncryptedMessage`, reactions as their own table).

The plugin cannot substitute its cache for that store, and this is the sharpest hidden cost in the whole
comparison: **Baileys requires the client to answer `getMessage(key)`** for messages it has already seen, when
WhatsApp asks it to decrypt a retry, re-upload media, or resolve a quoted reply. WhatsAgent satisfies that
with a `raw` protobuf envelope stored per message and a loader over it (`createStoredMessageLoader`). The
plugin stores mapped `Message` rows for the newest 60 of a thread, with no raw envelope, in a cache that is
rewritten wholesale on refresh. A port therefore needs a third store the plugin does not have: durable
per-message envelopes. Every one of the 8,540 messages in WhatsAgent's database today is one of those.

### Media: encryption in, expiry out

Inbound media is `mediaclient` ciphertext plus a media key in the envelope; Baileys downloads and decrypts it,
and the CDN URL expires. When it has expired, the only recovery is asking the sender's phone to re-upload
(`reuploadRequest`), and the failures that are terminal look like the failures that are temporary: 404/410,
412, 418, sometimes a 5xx (`~/dev/whatsagent/server/channels/whatsapp/media.ts`). This repository already has
a bug filed against exactly that confusion — see
[the media failure bug](../bugs/2026-11-04-media-download-failure-is-not-temporary.md): 26 failed media clicks
in four days, 14 in one afternoon, each a fresh request that could never succeed. Owning the transport means
owning that classification, that 14-day serve window, and the re-upload path; today the plugin owns only the
error sentence.

### What "sent" can honestly mean

Four tiers, and neither program is above the second:

1. **Queued** — the text is in a local outbox. The plugin's `Sending.` is a 202 from WhatsAgent, so this is
   where the panel currently stops.
2. **Accepted by WhatsApp** — `sendMessage` resolved, or the server echoed the stanza. WhatsAgent marks the row
   `sent` here, immediately after the transport call (`OutboxPacer` → `markOutboxSent`).
3. **Delivered to the recipient's device** — a delivery receipt.
4. **Read** — a read receipt.

Neither program subscribes to `message-receipt.update`; WhatsAgent stores local read cursors only and says so
(`server/actions/mark-read.ts`: "Does not send a WhatsApp read receipt"). So the honest words are "queued" and
"accepted by WhatsApp". A port would not improve this by itself — receipts are one more event to subscribe to
and one more column to store. It is a feature to add deliberately, on the current transport, not a reason to
move the transport.

## The failure that bites first

**Scenario: the morning-after reply.** The laptop sleeps at 00:30 with the socket open. On wake the socket is
gone — WhatsApp closes linked devices on sleep with a 428 `connectionClosed` or a 440, both of which are the
transient class. The owner opens the inbox, sees an overnight message, replies.

- **Today:** the POST is accepted, the outbox holds the row, the pacer sends it once the ladder reconnects, and
  the row goes `sent`. Worst case the reply lands minutes late, in order, once.
- **With Baileys in the plugin, as the adapter is written:** `sendFromComposer` would either throw inside the
  RPC (the panel shows one red error line and the text survives in the draft) or, worse, the owner retries and
  a second copy is queued.

**First symptom to watch for:** a reply that reads as sent in the inbox and never appears on the phone. The
thread ends on the incoming message, because the plugin only shows what a sync returns — so the observable
symptom is "my reply vanished", arriving hours after the send, not "send failed" at the moment of the click.
That asymmetry is the reason to name it now: it is a silent loss with a successful-looking UI, and the outbox in
WhatsAgent is precisely the component that prevents it.

The second-order failure is the copied auth state, and it is the expensive one: a restored backup produces a
flapping session, then `loggedOut`, then a re-pair — the risk event described above.

## Maintenance surface

Measured, not asserted:

| fact | measurement |
|---|---|
| library release cadence | 64 published versions; 12 released in the last 365 days; 14 in the 7.x line since 2025-09-08 (`registry.npmjs.org/baileys`) |
| version pinned here | `7.0.0-rc13`, published 2026-05-21; `rc14` published 2026-07-29 and never adopted — a 3-month-stale pin with a newer release available |
| the pin was already stale at install | rc13 bundles WA web version `[2,3000,1035194821]`; WhatsAgent resolves the live version at every start with a 10 s timeout and falls back to `[2,3000,1043856522]`, "the last live-tested value" (`connection.ts` `WA_WEB_VERSION_FALLBACK`) |
| a local patch is mandatory | `scripts/patch-baileys.mjs` rewrites `node_modules/baileys/lib/Utils/validate-connection.js` from a `postinstall` hook, and throws if the surrounding text moved. A bump that changes that file fails `npm ci` loudly, which is the good case |
| upstream posture | Baileys' README opens with a breaking-change notice for 7.0.0 and a disclaimer of affiliation; the maintainer lists paid support slots |
| adoption signal | 401,539 downloads in the week 2026-10-29…2026-11-04 |

Two of those are the same fact from two directions: the server changes without notice, and the client's answer
is a version probe plus a constant that a human updates after a live test. That constant moved once, in the
commit that also added the pairing patch (`c21b4f7`, 2026-07-26) — every future move is a person noticing
pairing is broken and retesting by hand.

**A bump that breaks the socket** does not announce itself as a type error, because the socket is not typed. It
presents as: pairing QR appears, phone accepts, then no history sync and no messages. That is the observed
shape of the failure that produced the runtime version probe.

**Who debugs it at 2am.** Today: the same person, in the WhatsAgent repository, where 1,782 non-test lines of
transport sit beside 2,895 lines of tests for the same directory plus the outbox — and where a provider-side
defect is fixable in an hour, which is exactly what happened on 2026-11-04 when a permanent media failure was
being reported as temporary (fix `bfd0f2d`, same day, in WhatsAgent). Moving the transport into the plugin does
not remove this person; it moves the code into a repository whose tests are one suite for five sources, and
whose log is `bb plugin logs`. It also puts a protocol failure on the same event loop as Gmail's refresh loop,
the LinkedIn page session and the panel's RPC.

## Ban risk

Stated as a number that can be defended, and a number that cannot:

- **Cannot:** a per-year ban probability for this account. Exposure so far is 25 days of a Baileys
  linked-device session (auth state first written 2026-10-11, 8,540 messages stored to 2026-11-05) with zero
  bans. Zero events in 0.068 account-years bounds nothing useful: the 95 % upper bound of the rule of three is
  about 44 bans per account-year, which is not a probability, it is an absence of data.
- **Can:** the mechanism, from the contract WhatsApp actually publishes. Its Terms prohibit accessing the
  service "through automated or other means" in impermissible or unauthorized manners, reverse engineering,
  and "non-personal use", and name "bulk messaging, auto-messaging" as impermissible communication; Baileys'
  own README disclaims any affiliation. WhatsAgent's README states the operational reading: re-pairing is the
  main trigger, more than ordinary message traffic.

**The decision-relevant consequence:** ban exposure does not depend on which program holds the socket. Same
library, same account, same linked-device sessions, same re-pairing triggers. What a port changes is the
probability of *accidentally re-pairing more often* — a worse reconnect ladder, a lost auth state, a copied
data directory. Owning the transport adds no ban risk by itself; it adds a new way to lose a session, and
losing a session is the trigger. That is the honest form of the risk, and it points the same way as the rest
of this document.

## The comparison

| | own it (Baileys in the plugin) | keep WhatsAgent |
|---|---|---|
| transport code to maintain | re-create 1,782 non-test LOC + 2,895 test LOC (channel, outbox, failure classification, media, store) and 4 migrations, inside this repo | 511 LOC total on the plugin side (`whatsapp.ts` 311, `whatsagent.ts` 100, helpers 100) |
| auth state | plugin owns 1.3 MB of account-hijack credentials, a keychain item, and the copied/lost cases | stays in WhatsAgent's keychain-encrypted SQLite, `0600` in `0700` |
| pairing UX | new: QR surface, expiry, re-pair flow in an inbox that cannot distinguish empty from unpaired | exists in the app, outside the plugin |
| reconnect + retries | new outbox, backoff, terminal-state cap, restart recovery | exists and is tested |
| message store | new durable raw-envelope store (required by `getMessage`), plus idempotent upsert and LID merges | exists: 8,540 messages, idempotent, raw envelopes kept |
| media | new decrypt path, re-upload, expiry window, failure classes | exists; the plugin's own media bug was fixed upstream in a day |
| protocol breaks | a pairing failure takes the plugin's WhatsApp service down every 8 s and lands in the plugin's log | a separate process, a separate log, a separate test suite |
| extra features (archive, audio, documents, older history, avatars) | unlocked, because the protocol is in hand | a feature request away: the app implementing them is also ours (`deepen-history`, contact avatars, and media states already exist there) |
| human gates today | one, at install | two: a live pid plus the MCP toggle in WhatsAgent's Settings (`/api/agent/status` shows `mcp.enabled: true`); a keychain authorization at first start |
| install footprint | none added | a second program to keep installed and updated; on this machine the launch agent runs a **dev build** (`/Users/robert/dev/whatsagent/dist/server/server/index.js`) while WhatsAgent's own Settings describe the packaged bundle (`/Applications/WhatsAgent.app/…/mcp/stdio.js`) — two candidates for the same runtime file |

On the last row, and on the report that WhatsAgent "now requires a browser login on this machine": I could not
verify a login. `GET /` and `GET /login` both answer 200 with no credentials, the loopback API answers
`/api/session` with `status: ready`, and no login gate appears in `server/api/routes.ts`. What is real is the
MCP toggle in the app's Settings, which is a human step but not a login. The claim should be re-checked before
it is used as an argument either way.

## What would change this verdict

Three reversal conditions, so a future reader can re-run the decision instead of re-arguing it:

1. WhatsApp's linked-device surface stops being enough for the feature list — e.g. the inbox must show audio,
   documents, archived chats or history older than 60 messages, **and** those stay unexposed in WhatsAgent after
   a deliberate attempt to add them there.
2. The second process becomes the problem it is not today: the app cannot be installed where the plugin runs
   (a Linux host, a headless server, a second machine), or its dev-build/bundle split keeps attaching the
   plugin to a stale binary.
3. Baileys' maintenance posture collapses — releases stop, the pairing patch cannot be re-applied, or the
   version probe stops working for a period the owner is unwilling to absorb.

None of the three is true on 2026-11-05.

## Cheaper wins available without moving the transport

Ordered by cost, all inside this repository except the second:

1. **Send the bearer token on the composer POST.** `composerSendRequest` authorizes with `Origin` alone; every
   other call carries `Authorization: Bearer`. One header, and the write path stops depending on WhatsAgent's
   CSRF guard alone.
2. **Ask WhatsAgent for the preview sender in `list-chats`.** One field removes 9 of the ~11 loopback requests
   in a list refresh, and with them the 1 s timeouts that make a group's preview occasionally blank.
3. **Make the send outcome visible.** WhatsAgent already knows `pending → sending → sent/failed`; the panel
   shows only `Sending.`. A status read after the send turns a silent queue into a visible one, without any
   protocol work.
4. **Name the runtime candidate.** `/api/agent/status` reports the packaged entry point while the launch agent
   runs a dev build; the plugin trusts whichever process wrote `mcp-runtime.json` last. Record the version and
   path in the plugin's status line so "which WhatsAgent am I talking to" is answerable from the inbox.

## What I could not verify

- **Whether WhatsAgent requires a browser login** on this machine: no login gate found on the loopback API or
  the UI routes; not tested in a browser session.
- **Ban probability.** One account, 25 days, zero events. No publishable rate exists and this sample cannot
  produce one.
- **Behaviour of a copied auth state on a second machine.** The 440/`connectionReplaced` classification and the
  README's warning are code and prose, not an experiment — deliberately not run, since it would risk the
  account.
- **Whether the plugin's current 8-second poll and 5-second watch cause any WhatsApp-side rate limiting.** Not
  instrumented; WhatsAgent's API is local, so the plugin cannot see what the socket does.
- **Baileys 7.0.0-rc14.** Never installed or started here; its breaking changes are known only from the
  README's notice.

## Further reading

- [The media failure bug](../bugs/2026-11-04-media-download-failure-is-not-temporary.md) — the measured cost of
  a transport classification mistake, and of trusting a provider's error text.
- [`src/CONTEXT.md`](../../src/CONTEXT.md) — the adapter/gateway seam a transport swap would have to preserve.
- [`src/adapters/README.md`](../../src/adapters/README.md) — what an adapter owns versus what the toolbox owns.
- [`docs/plans/2026-11-04-001-refactor-own-source-transports-plan.md`](../plans/2026-11-04-001-refactor-own-source-transports-plan.md)
  — the Gmail transport refactor that named Baileys as a separate, unsettled foundation.
- WhatsAgent, on this machine: `~/dev/whatsagent/server/channels/whatsapp/` (connection, auth store, ingest,
  media, send), `~/dev/whatsagent/server/outbox/` (pacer, failure), `~/dev/whatsagent/scripts/patch-baileys.mjs`.
- Upstream: [Baileys README](https://github.com/WhiskeySockets/Baileys) (breaking-change notice, disclaimer),
  [npm registry metadata](https://registry.npmjs.org/baileys) (release cadence),
  [WhatsApp Terms of Service](https://www.whatsapp.com/legal/terms-of-service) (the prohibited-use clauses
  quoted above).
