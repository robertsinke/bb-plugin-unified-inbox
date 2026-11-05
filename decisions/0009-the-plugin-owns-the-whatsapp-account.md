# 0009 — The plugin owns the WhatsApp account state and the socket lives in process

- **Type:** architecture decision
- **Description:** The plugin opens its own Baileys socket inside its own process and keeps the linked account's state in a 0700 directory under its data directory, so WhatsApp works on a machine that has never had WhatsAgent on it.
- **Status:** accepted
- **Date:** 2026-11-05
- **Deciders:** Robert (owner)
- **Supersedes:** nothing
- **Verified against the code:** 2026-11-05 — `src/whatsapp/connection.ts` holds one socket with its reconnect ladder; `src/whatsapp/auth.ts` resolves the state to `~/.bb/plugins/unified-inbox/whatsapp-auth` (overridable with `UNIFIED_INBOX_WHATSAPP_AUTH`), creates it `0o700`, writes files `0o600`, and keeps the AES-256-GCM key beside the ciphertext; `src/whatsapp/lock.ts` takes an `O_EXCL` `socket.lock` per state directory; `src/whatsapp/version.ts` pairs a live version probe with a fallback constant; `_tools/patch-baileys.mjs` patches the pinned client and `npm run build` runs it before `bb plugin build`; `bb unified-inbox whatsapp-link [phone]` opens the socket from the CLI; `src/adapters/whatsagent.ts` still answers reads and sends, unchanged, because the store has not moved yet.
- **Tags:** whatsapp, transport, credentials, portability, security

> **Current state (2026-11-05, plan U7): the decision holds and the coupling it replaced is gone.**
> `src/adapters/whatsagent.ts` and its runtime-file discovery are deleted, which retires the last
> sentence of the verification line above: reads answer from `src/whatsapp/store.ts` and sends from
> `src/whatsapp/send.ts`. What the record does not name, because it did not exist yet, is the lifetime:
> `src/whatsapp/lifecycle.ts` now decides when the one socket exists — opened on first ask, closed on
> dispose, and stopped after a ten-minute idle window only when it never became a linked device, since
> a linked socket is how messages arrive. A start that is refused (the lock is held elsewhere, the state
> will not decrypt) is kept there and drawn by the pairing card as `failed`, because the credential
> files say an account exists and never say a socket is up. Nothing below is rewritten: an ADR records
> what was decided, not what the code looks like today.

## Context

WhatsApp is the plugin's only source that was never really ours. `src/adapters/whatsapp.ts` speaks to WhatsAgent, whose backend is a separate program on this machine: the plugin reads a runtime file for its port and bearer token, checks a pid, and calls MCP tools over loopback. Everything below that — the Baileys socket, the encrypted auth state, the outbox, the reconnect supervisor — belonged to the other program.

That arrangement is invisible as long as one person runs both. It stops working the moment anyone else installs the plugin: a stranger has no WhatsAgent, no runtime file, no paired state, and therefore no WhatsApp tab at all. The Gmail slice had the same shape and it was removed by [0008](./0008-the-plugin-owns-the-gmail-credential.md), which made the plugin hold its own credential rather than borrow a CLI's. WhatsApp is the same defect with a larger object: not a token, but a linked device and the protocol session behind it.

Three shapes were considered for who runs the socket.

- **Keep WhatsAgent as a dependency.** Zero work, and it is what the plugin does today. It also means the plugin ships only to machines that already run our second program, which is the problem rather than a solution, and it leaves the two-socket, two-store coupling in place.
- **Bundle a child binary behind the plugin, the way a native helper would be shipped.** There is no precedent here to copy: the Messages source does not bundle `imsg`, `README.md` asks the user to install it. Shipping per-platform artifacts from a plugin whose output is two JavaScript files, and re-creating the process boundary this decision exists to remove, is more work than the socket itself.
- **Pair through a hosted service.** Someone else's server would hold the account and the traffic; it contradicts a plugin whose whole premise is local, and it moves the ban exposure onto a third party we cannot see.
- **Own the socket in the plugin's own process.** The account state becomes a file under the plugin's data directory, in the shape 0008 already established.

The fourth is chosen. The trade is explicit: the plugin now holds a second secret at rest, carries ~5 MB of protocol client, and inherits the protocol's churn — in exchange for WhatsApp that exists on a machine that has never heard of us.

## Decision

The plugin owns the WhatsApp account state, and the socket lives in its process.

`src/whatsapp/auth.ts` is the only module that knows where the state is: one directory per account, `0o700`, files `0o600`, one AES-256-GCM blob per key with the key beside the ciphertext. `src/whatsapp/connection.ts` owns exactly one socket, a 5 s → 60 s reconnect ladder, and treats `loggedOut` as terminal; it reports what the socket said instead of a spinner, because a client whose version WhatsApp rejects closes without ever emitting a QR. `src/whatsapp/lock.ts` holds an `O_EXCL` `socket.lock` for the life of the socket: two sockets presenting one identity get `connectionReplaced` (440), flap the session, burn a device slot, and re-pairing is the ban lever, so this invariant is enforced rather than assumed.

Pairing is the plugin's own act: `bb unified-inbox whatsapp-link [phone]` today, the panel's QR card in plan unit U4 next. A pairing code is the fallback, and a lost account state is a deliberate re-pair, never a silent one.

The pinned client is part of the decision, not an implementation detail below it. `_tools/patch-baileys.mjs` rewrites the version's `validate-connection` so a desktop client reports `Platform.MACOS` and `syncFullHistory` is honoured — without it the account links and then shows nothing. The patch runs from `npm run build` before `bb plugin build`, and `npm run check` fails on an unpatched tree, because a silent no-op there ships a client that pairs and then looks empty.

The Gmail slice's boundary rules still apply here unchanged: the state file is never returned over RPC, never logged, and never printed by a CLI. Sends remain gated by `src/adapters/policy.ts`; this decision changes who carries the bytes, not who authorises them.

## Consequences

Easier:

- WhatsApp exists for anyone who installs the plugin, with no second program and no runtime file to discover.
- A pairing problem is now visible in the plugin's own vocabulary: no state, QR offered, QR expired, code requested, logged out.
- Reads and sends no longer depend on another process being alive, so a WhatsAgent crash is no longer an inbox outage.
- The reconnect ladder, the state store and the failure classification are ours to fix instead of another program's behaviour to work around.

Harder, and accepted:

- The plugin holds a second secret at rest, and a key beside its ciphertext is not a secret store. The `0o700` directory is the protection; the documents say so rather than implying encryption is one. This is a one-way door in practice: once a user has paired, the state is the account, and losing it means asking WhatsApp for a new device slot.
- The bundle carries the whole protocol client: `dist/server.js` went from 730 KB to 5.7 MB. It loads through a lazy import, so plugin start does not pay the ~400 ms, but the size is permanent.
- The plugin now tracks a pinned third-party protocol release and a patch against it. A Baileys bump is a code change with a verification burden, and a stale pin is a client WhatsApp may reject before it ever shows a QR.
- Ban exposure is inherited and cannot be removed in code. It is bounded by behaviour — one socket, durable state, deliberate re-pair, no automatic sends — and stated to the user before the QR, not after.
- U1 proved a socket connects and offers a QR with the account untouched. A linked account, a history sync and a delivered message remain unproven until the owner pairs, so this decision is accepted ahead of its largest piece of evidence.
- `src/adapters/whatsagent.ts` and the WhatsAgent coupling stay until plan unit U3 moves reads onto the plugin's store. Until then the plugin holds two ways to reach one account, which is a state no release should ship in.
