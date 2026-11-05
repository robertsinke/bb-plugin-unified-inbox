---
title: "The WhatsApp transport the plugin has to carry itself"
description: "Under the real constraint — a plugin user has no WhatsAgent — what has to ship, how a stranger pairs, which of our 2,318 lines lift, the first failure they hit, and the ban exposure we can defend."
type: research-note
status: settled
date: 2026-11-05
supersedes: ../research/2026-11-05-baileys-whatsapp-transport.md
tags: [research, whatsapp, baileys, distribution, transport]
sources:
  - resource: ./2026-11-05-baileys-whatsapp-transport.md
---

# The WhatsApp transport the plugin has to carry itself

**Date:** 2026-11-05
**Machine:** this macOS checkout; WhatsAgent source at `/Users/robert/dev/whatsagent` (`baileys@7.0.0-rc13`),
WhatsAgent's headless backend running on this machine (which is precisely what a plugin user does not have).
**Evidence class:** file-level measurement of both trees, the plugin's own build output, and one offline
bundling probe of Baileys into a single file. No code changed, no dependency installed, no message sent, no
device paired — pairing is the risk event this document is about, so it was not performed.
**Supersedes:** [Pricing a Baileys WhatsApp transport](./2026-11-05-baileys-whatsapp-transport.md), whose
verdict ("keep WhatsAgent, do not port Baileys") is withdrawn. See [what changed](#what-changed-and-why).

## What changed, and why

The superseded note answered a question that only has an answer **on this machine**: move WhatsApp into the
plugin, or keep the WhatsAgent process that already runs here. On this machine, keeping it is free.

A plugin user has no WhatsAgent. Not "has not configured it" — *has no such program*. Unified Inbox is a
plugin: it is installed into a BB instance on somebody else's computer, and nothing in its package can assume
a second program of ours exists there. So on a fresh install today the WhatsApp source does not exist at all,
and the honest statement of its state is not "borrowed" but **unshipped**.

Three of the old note's conclusions survive unchanged and are reused here rather than re-measured: the
WhatsApp message store is the part a port cannot skip (`getMessage` must answer, so raw protobuf envelopes
have to be durable), media expiry classes are a classification problem we already own a bug against, and a
ban probability is not knowable from our data. Its cost table, its verdict, and the sentence "the plugin's
cache can stand in for the store" do not survive.

## Verdict

**Baileys runs in the plugin's own process, and the plugin owns the WhatsApp account state in its own data
directory — the shape [decisions/0008](../../decisions/0008-the-plugin-owns-the-gmail-credential.md) set for
the Gmail credential.** No child binary, no second program, no loopback neighbour.

This is not a preference between two working options. Of the two shapes, only one can be *installed*:

- **Bundled child binary.** There is no precedent in this plugin to copy. The Messages source does **not**
  bundle `imsg`: the README tells the user to install it (`PLUGIN_OVERVIEW.md` line 26, `README.md` line 26),
  `server.ts` looks for it at `~/.local/bin/imsg`, `/opt/homebrew/bin/imsg`, `/usr/local/bin/imsg`, then
  `PATH`, and on this machine it resolves to a symlink the user made into a versioned install directory
  (`~/.local/bin/imsg → ~/.local/share/imsg/0.20.0/imsg`). A bundled binary would mean publishing and
  signing per-platform artifacts inside a plugin that currently ships two JavaScript files.
- **Baileys in-process.** Measured, not assumed: `bb plugin build` produces self-contained bundles
  (`dist/server.js` is 730 KB and carries zod and the MCP SDK inline; `dist/` contains no `node_modules`), so
  a dependency is bundle weight and nothing else. Baileys 7.0.0-rc13 bundles with esbuild into **one 7.9 MB
  ESM file in 0.4 s with no unresolved imports**, and the result imports cleanly in Node 22 with
  `makeWASocket` and `proto` present. Its WASM dependency (`whatsapp-rust-bridge@0.5.4`) carries the WASM
  base64-inlined, so nothing platform-specific has to be shipped.

What the in-process shape costs, stated plainly: roughly 8 MB of plugin bundle, a protocol library whose web
version drifts under it, one mandatory build-time source patch, and the transport's failures landing in the
plugin's log and on the panel's event loop. That is the price of having WhatsApp at all.

## What "ships" means here

Three facts decide this document, and all three are checkable in this checkout.

1. **A plugin carries its dependencies as bundle.** `bb plugin build` writes `server.js`, `app.js` and their
   meta files into `dist/`; there is no `node_modules` in `dist/` and none in the plugin's data directory
   (`~/.bb/plugins/unified-inbox` holds `data.db`, `gmail-credentials`, `linkedin-profile` and nothing else).
2. **A plugin gets its storage from the host.** `bb.storage.database()` is a `better-sqlite3` database in the
   plugin's data directory (the same class WhatsAgent opens), `bb.dataDir` names that directory, and
   `bb.background.service(name, {start})` is the host-owned lifetime a socket needs.
3. **A plugin has no install step of its own.** Anything the user must do to make WhatsApp work has to be
   something the plugin can draw on screen and explain, because there is no terminal instruction that reaches
   them.

Fact 3 is the one the old note missed: it priced *maintenance* and treated distribution as free, because its
only reader already had the program.

## The two shapes, priced

| | Baileys in the plugin's process | a bundled child binary |
|---|---|---|
| can a stranger install it | yes — it comes with the plugin | only if we publish per-platform artifacts; nothing in this plugin does that today |
| WhatsApp today, on a machine with only BB | works after scanning a code | works after the same scan, behind a process we also ship |
| code we write | lift ~2,300 lines we already own, replace the store seam | write a second program *and* keep the RPC seam the old adapter speaks |
| process boundary | none | one, with a crash/supervision story to design (`AGENTS.md` rule 6 sends process leaks upstream) |
| failure surface | plugin log, plugin service | its own log, plus "which binary is running" |
| account state | plugin data dir, 0700, ours to lose | the child's directory |
| startup cost | the socket connects when the service starts | spawn + handshake |
| bundle | +7.9 MB measured | +whatever the artifact weighs |

The child-binary column is not absurd — isolation is real value when a protocol library is as mobile as
Baileys. It is just strictly more work than the in-process shape for a plugin that has no artifact pipeline,
and the isolation it buys is isolation from a bug we would then have to fix in two places.

## Pairing, from the panel

Baileys connects as a **linked device**, the same way WhatsApp Web does. That single sentence carries the
whole pairing design.

**The code the phone scans.** `connection.update` emits a `qr` string; it is not an image. Baileys keeps the
first QR for 60 s and rotates later ones every 20 s (WhatsAgent's `QR_TTL_MS` in `server/api/session.ts`
states the numbers and why the longer first lifetime is used). A stale QR is a dead QR — it is not a retry, so
the panel has to re-render on each emission and show a countdown, not a spinner.

**The alternate path.** `requestPairingCode(phoneNumber)` exists in rc13 (`lib/Socket/socket.js`). It turns
pairing into eight characters the user types on their phone, which needs no camera and no image pipeline. It
is the right first proof for the socket (unit U1 in the plan) and the right fallback in the panel when a QR
will not scan.

**A second device.** Pairing adds this plugin as one linked device beside the phone's WhatsApp Web, Desktop
and any others. WhatsApp allows a fixed number of linked devices; the oldest is dropped when the limit is
reached, so a user who pairs the plugin and later pairs a laptop may silently lose one. Nothing in the plugin
can prevent that, and the honest UI text is "this counts as a linked device, like WhatsApp Web".

**Re-pairing after the state is lost.** `loggedOut` is terminal: no reconnect helps, and the account state in
the data directory is worthless. The panel must show a distinct *unpaired* state with a button that starts a
fresh pairing, never a generic error, because "empty inbox" and "unpaired device" are visually identical
otherwise. Re-pairing is also the ban lever (below), which is why it has to be deliberate.

**What must not happen.** Two live sockets presenting the same device identity. WhatsApp closes one with
`connectionReplaced` (440) and the visible result is a session that flaps between two machines and a consumed
device slot. Today that invariant is held by an external fact: one WhatsAgent process on one machine. In the
plugin it becomes an invariant we implement, because `bb plugin reload` exists and a second BB can be pointed
at the same data directory.

## What lifts from WhatsAgent

Measured on the `server/` tree of `/Users/robert/dev/whatsagent` (non-test files, line counts from `wc -l`).
The total across these modules is 2,318 lines. The classification is by **imports**, not by judgement: a file
that imports `server/store/db.js` or `server/store/*.js` cannot ship against the plugin's database, which does
not have WhatsAgent's tables.

### Lifts as-is

| file | lines | why it lifts |
|---|---|---|
| `server/channels/whatsapp/send.ts` | 63 | Imports Baileys types only. `setPresence`, `sendText`, `sendReaction`, `markRead` over a socket, plus `WhatsAppDisconnectedError`. Nothing to change but the import path. |
| `server/outbox/failure.ts` | 84 | Imports `send.ts` only. The `offline`/`terminal`/`transient` split, `TRANSIENT_STATUS = {408, 411, 428, 429, 440}`, and the deliberate polarity that an unknown error means *retry*. This is the file that decides what the panel is allowed to say about a failed send. |
| `server/channels/whatsapp/message-edit.ts` | 39 | Baileys plus `baileys/lib/Utils/crypto.js`. Deep imports survive because Baileys declares no `exports` map (only `type: module` and `main`). |

### Lifts with the store seam replaced

Every file below imports the store directly, so the socket half is liftable and the persistence half is not.
The good news is that `WhatsAppConnection` already takes its collaborators as options — `db`, `socketFactory`,
`createAuthStore`, `authStore`, `resolveWaVersion`, `reconnectDelayMs`, `maxReconnectDelayMs`, `onError` — so
it is the most liftable of the group: the socket, the reconnect ladder (5 s doubling to 60 s, ten doublings,
reset on open), the version probe with its 10 s timeout and last-live-tested fallback, the `pairing-needed`
event, the LID-mapping merge hook, the `getMessage` hook and the group-metadata cache all arrive intact.

| file | lines | what the store owns today |
|---|---|---|
| `server/channels/whatsapp/connection.ts` | 432 | `getMessage` loader, `deepenChatHistory`, LID-mapping backfill and merge, identity mappings |
| `server/channels/whatsapp/ingest.ts` | 846 | about a dozen message shapes → rows, idempotent upsert on the WhatsApp id, reactions and edits, `chats-merged` and its backfill |
| `server/channels/whatsapp/media.ts` | 179 | message rows, cached media, the 404/410/412/418 expiry classes and the re-upload request |
| `server/channels/whatsapp/history.ts` | 64 | older-history fetch (`deepenChatHistory`) writing rows |
| `server/channels/whatsapp/auth-store.ts` | 159 | AES-256-GCM blobs are liftable verbatim; the key is not (next section) |
| `server/outbox/pacer.ts` | 452 | the persisted outbox and its attempt cap — only needed if the plugin queues sends (decision D6 in the plan says it does not, in v1) |

### Cannot ship

| what | why not |
|---|---|
| `server/store/*` and `server/store/migrations*` | WhatsAgent's own `better-sqlite3` singleton with nine migrations. The plugin has its own database and DDL (`src/inbox-cache.ts`): `inbox_cache`, `inbox_thread`, `inbox_freshness`, `inbox_sync`, `inbox_revision`, `inbox_unread_mark`. Its `inbox_thread` holds mapped messages as JSON, rewritten wholesale per open — a projection, not a message store, and it keeps **no raw envelope**, so `getMessage` cannot be answered from it. |
| `loadKeychainEncryptionKey` | Shells out to `/usr/bin/security` and throws `WhatsApp auth keychain storage currently requires macOS` on any other platform. The plugin cannot assume a macOS keychain, and a keychain grant is a human step the panel cannot perform. |
| `server/index.ts` (1,107), `server/mcp/*` (1,087) | The desktop app's singleton and the MCP surface that exists so *other* programs (this plugin, today) can talk to it. In-process, both are dead weight: the host owns the lifetime, and `bb.rpc` is the surface. |
| `server/api/routes.ts` (1,021) + `server/api/session.ts` | The loopback HTTP API the plugin's 511 lines of coupling speak. The *knowledge* in it lifts (QR TTL constants, `qr_pending`/`qr_expired` states); the endpoints do not, because there is no second program to call them. |
| `scripts/patch-baileys.mjs` as a runtime step | The patch is real and mandatory — it rewrites `Utils/validate-connection.js` so a Desktop/Mac-OS browser tuple reports `MACOS` and `syncFullHistory` is honoured, changing `Windows/WIN32` to `Windows/WIN_HYBRID`. It runs from `postinstall` and `--check` fails loudly when absent. In the plugin it must be a **build step before bundling**, because what ships is the bundle: a `postinstall` in a plugin package is not a step the plugin controls. |

## The first failure a stranger hits

**Scenario: the QR that never arrives.** The stranger installs the plugin, opens the WhatsApp source, taps
*pair*, and the card says **Connecting…**. No QR appears. The phone never gets a chance to do anything wrong.

The cause is the coupling that this machine has already paid for once. Baileys speaks a versioned WhatsApp
Web protocol: `lib/Socket/socket.js` sends a client version, and the server rejects a stale one **before it
emits the first `qr` update**. rc13's bundled version (`[2,3000,1035194821]`) was already rejected on this
machine, which is why WhatsAgent grew two things the plugin must carry: a runtime probe
(`fetchLatestWaWebVersion`, 10 s timeout) and a hand-maintained constant `WA_WEB_VERSION_FALLBACK =
[2,3000,1043856522]` labelled "the last live-tested value". The probe usually saves the stranger; when the
probe answers a version the pinned library cannot drive, or the probe times out on a locked-down network and
the fallback has aged out, nothing does.

**First symptom:** a connect state with no QR, and a log line where the socket closes with a
`Connection Failure` before any `qr` event, retried every 5 s and then on the ladder up to 60 s — forever. The
panel shows the same thing for a wrong password, a firewalled network, an unpaired device and a broken
protocol, which is why the fix is not only "ship the probe" but "say what the socket said".

The failure immediately behind it, if the QR appears and the phone accepts: **linked, and empty.** The phone
shows the plugin under linked devices, the inbox stays empty, and there is no error at all — the shape of a
`syncFullHistory` request that the server answered with nothing because the client did not present the
platform the patch exists to present. First symptom: a linked device, zero chats, and a panel that says "No
conversations in this view".

One failure that must be fixed before it can be a stranger's first impression: **an unpaired source is not an
error.** `src/inbox-refresh.ts` records `lastError` on every failed poll and the panel renders it in
`InboxErrors`, so today's transport failure would greet the user with a red line every 8 seconds before they
have scanned anything. Pairing state has to be a state, not a failure.

## Ban risk

Stated as what can be defended, and nothing more.

**What we cannot say.** Any per-year probability for an arbitrary user. Our whole sample is one account: 25
days of a linked-device session (auth state first written 2026-10-11, 8,540 messages stored to 2026-11-05) and
zero ban events. Zero in 0.068 account-years bounds nothing useful — the 95 % upper bound of the rule of three
is ~44 bans per account-year, which is an absence of data, not a rate. Shipping a plugin multiplies the
population and leaves our sample where it is: **the evidence does not improve with distribution, it dilutes.**

**What we can say.** The mechanism, from the contract WhatsApp publishes. Its terms prohibit access "through
automated or other means" in impermissible ways, reverse engineering, and non-personal use, and name "bulk
messaging, auto-messaging" as impermissible. Baileys' README disclaims affiliation. WhatsAgent's README
records the operational reading: **re-pairing is the main trigger**, more than ordinary traffic.

**What follows for this design.** Since re-pairing is the lever we can move, the plugin's job is to make
re-pairing rare and deliberate:

1. Account state survives restarts; it lives in a 0700 directory that is never a synced folder.
2. One socket per data directory, enforced by the plugin — a `bb plugin reload` race must not look like two
   machines presenting one identity.
3. A lost state is announced as *unpaired* with an explicit re-pair, never silently retried.
4. **The plugin never sends unless a human asked**, and never in bulk. The terms name automated messaging, and
   the existing `src/adapters/policy.ts` gate already means every send carries a caller's `allow: 'send'`.
   That is the property that keeps this a personal-use client rather than a messaging tool.

**The exposure that would change this advice.** Not a bad night — a *number*. Two kinds: (a) a community
pattern of linked-device sessions being banned without unusual traffic, which would say the risk is the
library's fingerprint rather than our behaviour; (b) an actual measurement of re-pair frequency and its
outcome in our own installs, which we do not have and could only get by pairing repeatedly on an account we
are willing to lose. Until either exists, the correct claim is "same mechanism, same triggers, and we control
one of them", and the correct thing to tell the user before they scan is exactly that, in three sentences.

## What would change this verdict

1. **Bundling stops being free.** The probe was esbuild against a tree where Baileys' dependencies were
   already installed. If bb's own bundler cannot carry Baileys (dynamic imports, WASM, `pino`'s worker files),
   the in-process shape loses its main advantage and a child binary becomes the cheaper path again.
2. **The pin becomes undrivable.** If rc13 cannot be kept current — the mandatory source patch stops applying,
   or the version probe keeps answering versions the library cannot drive — then the plugin would be shipping
   a client that pairs for a week at a time, and a separately versioned child binary becomes the only way to
   keep the library current without a plugin release.
3. **The account state has to leave the machine.** If BB's storage model moves plugin data to a synced or
   server-held location, the copied-auth-state case stops being hypothetical and the transport moves out of
   process, because two sockets on one identity is the failure WhatsApp punishes.

## What I could not verify

- **A connect, a pairing, an ingest.** Deliberately not performed in this unit; the plan's unit U1 exists to
  do it and is the first thing that should happen.
- **Whether bb's bundler behaves like esbuild here.** The probe was esbuild (the bundler available in
  WhatsAgent's tree). `bb plugin build`'s bundler is not in this repository, and it is the thing that actually
  has to carry 7.9 MB, `pino`, and an inlined WASM module.
- **The linked-device limit and the drop-oldest policy.** Not measured; it is WhatsApp server behaviour and
  experimenting with it costs device slots on a real account.
- **Ban probability** — see above; not obtainable from this data.
- **Whether `syncFullHistory` is required for the inbox to be useful at first run.** Our own client sets it
  (`connection.ts`: `browser: Browsers.macOS('Desktop')`, `syncFullHistory: true`); whether the plugin can
  start with only live messages and fill backwards from the phone is untested.

## Further reading

- [The superseded verdict](./2026-11-05-baileys-whatsapp-transport.md) — everything measured about the
  WhatsAgent coupling (511 plugin lines, four MCP tools, four HTTP routes), the auth-state size (5,538 rows,
  1.30 MB, ten key types, 3,021 of them LID mappings), the media expiry classes and their bug, and the
  maintenance facts about the pin. Those measurements stand; only the verdict changed.
- [decisions/0008](../../decisions/0008-the-plugin-owns-the-gmail-credential.md) — the shape this follows:
  the plugin owns the credential, in one place, written by one module.
- [`src/CONTEXT.md`](../../src/CONTEXT.md) — the adapter seam, capability vocabulary and cache ownership the
  transport has to fit behind.
- [`docs/plans/2026-11-05-001-feat-whatsapp-transport-in-the-plugin-plan.md`](../plans/2026-11-05-001-feat-whatsapp-transport-in-the-plugin-plan.md)
  — the plan these findings feed.
- On this machine: `/Users/robert/dev/whatsagent/server/channels/whatsapp/` (connection, ingest, media,
  auth-store, send), `server/outbox/failure.ts`, `scripts/patch-baileys.mjs`.
