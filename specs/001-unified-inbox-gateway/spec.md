---
type: spec
description: "Restructure Unified Inbox into one gateway with per-provider adapters, so agent-reachable surfaces narrow to one process (containment mechanism deferred to OQ-1)"
status: draft
owner: robert
target_release:
created: 2026-10-29
parent_proposal: none — see DL-1
tags: [spec, gateway, adapters, containment]
---

# Unified Inbox gateway and adapters

## Goals

1. **One entry point.** A single surface — RPC today, optionally CLI/MCP later — exposes every inbox operation: list, open, media, search, action. Callers never talk to a provider directly.
2. **Adapters own providers.** Gmail, Messages (`imsg`), and WhatsApp (WhatsAgent/Baileys) each implement one interface; provider quirks, auth, and mapping live there and nowhere else.
3. **Policy lives once.** Approval gating, cache, audit, and error isolation are gateway responsibilities, written once rather than per provider. Search-ranking ownership follows OQ-4's outcome rather than being asserted here.
4. **One choke point, designed for containment.** All provider access in the plugin flows through the gateway, making OS-level containment a single decision about one process (OQ-1). Enforcement of that boundary is deliberately out of scope for this spec; the goal is the choke point, not the wall.

## Non-goals

1. **Enabling Messages sending** — deferred; blocked on the human-gesture question tracked in [GH #6556](https://github.com/get-bb/bb/issues/6556) and [the send-approval proposal](../../docs/plans/2026-10-29-messages-send-approval-proposal.md).
2. **Choosing the agent containment mechanism** (separate macOS user vs sandbox profile vs VM) — deferred to OQ-1; this spec designs *for* a boundary without deciding which one.
3. **New providers** — deferred; the adapter interface is validated against the three existing sources first.
4. **Outgoing reactions, threaded replies, edit history, video/document attachments** — deferred; still unavailable or partial per [the Messages plan](../../docs/plans/2026-10-28-003-feat-local-messages-inbox-plan.md).
5. **Rewriting the UI** — deferred; the existing `app.tsx` keeps working through the gateway, unchanged in behaviour.

## Design

### Current system

One plugin, one server file, provider logic inlined per source.

- `server.ts` — the whole surface. `rpcContract` (L34–46) defines eleven methods: `list`, `cached`, `search`, `cached_open`, `clear_cache`, `list_source`, `open`, `media`, `imsg_media`, `action`, `send_gmail`. Provider dispatch is by `account` string with early branches; `gmail()` (L50) shells out to the `gws` CLI, `wa()` (L92) talks to the WhatsApp runtime, `listGmail()` (L133) and `listWa()` (L182) each build their own item shape, `confirmInWhatsAgent()` (L232) is a provider-specific approval path. `send_gmail` (L45) is registered but its handler is disabled fail-closed (L334) pending the owner-confirmation boundary.
- `src/inbox-cache.ts` — `createInboxCache(db)` owns a single SQLite cache shared by all accounts; rows are keyed by `account`/`id`, so provider identity is a column, not a type.
- The `search` handler in `server.ts` + `src/bm25.ts` — pure BM25 ranking over cached rows, built in-memory per query.
- `src/sync-plan.ts` — pure functions (`gmailCursorUnchanged`, `gmailIdsToFetch`, `whatsappListUnchanged`) deciding what to refetch. Already adapter-shaped, but named per provider.
- `src/imsg-client.ts`, `src/imsg-mapping.ts`, `src/imsg-media.ts` — the closest thing to a real adapter today: supervised child process, zod-validated payloads, bounded media.
- `src/gmail-*.ts`, `src/whatsapp-*.ts` — provider mapping/parsing helpers, invoked from `server.ts` rather than through an interface.

What exists is a monolith with adapter-shaped parts. The refactor formalises the seam that already exists rather than inventing one.

### Proposed change

**Adapter interface.** One contract in `src/adapters/types.ts`:

```
capabilities(): { send, markRead, archive, media, search?, attachments }
list(cursor?): Promise<{ items: Conversation[]; cursor?: string; errors: ProviderError[] }>
open(id, opts): Promise<{ messages: Message[]; cursor?: string }>
media(account, id, index): Promise<{ bytes, mime, filename }>
action(kind, id, opts): Promise<{ status }>
send?(draft, authorization): Promise<SendReceipt>
```

`media` carries the account routing key so the registry can dispatch it; `imsg_media`'s chat/message/index shape collapses into it at plan time. `action` covers the non-send kinds (read, unread, archive); reply/confirm/reject continue through `send` plus the policy layer per DL-4. The `search` flag is annotation-only pending OQ-4; `attachments` is served by `media`.

`Conversation`, `Message`, and attachment metadata are already implied by the cache schema and `imsg-mapping.ts`; they move to the shared types module. `send` is declared but unimplemented for Messages and gated by the gateway (see DL-4).

**Gateway.** `server.ts` shrinks to: contract definition, adapter registry, request routing, error isolation, cache write, index update. Per-provider branches disappear; `account` becomes a lookup into the registry. `confirmInWhatsAgent` moves into the WhatsApp adapter as its own `send` implementation. The existing `send_gmail` RPC routes to the Gmail adapter's `send` behind the same policy gate and stays disabled (as today, L334) until the approval boundary lands.

**Registry and configuration.** `src/adapters/index.ts` maps `account → adapter`. Adding a provider means adding a file and a registry entry, not editing seven functions in `server.ts`.

**Policy layer.** Approval gating and audit sit between the RPC handler and `adapter.send`, so a new adapter cannot ship without inheriting the gate. (Rate limiting is not specified here; it returns when a requirement, threshold, and test exist for it.)

**Agent surface.** The RPC contract stays the agent-reachable surface. Because all provider access is inside the gateway, containment becomes one decision about one process instead of three (see OQ-1).

### Options considered

| Option | Why not (now) |
|---|---|
| **A. Keep the monolith, extract later** | The seam already exists informally; every new provider (and every approval change) edits the same file. Cost grows with each addition. |
| **B. In-process gateway + adapters** *(chosen)* | Smallest change that produces the boundary: same plugin, same RPC surface, same UI. Adapters become separable later without moving the contract. |
| **C. Separate gateway daemon with its own OS identity** | The only shape that makes goal 4 enforceable (own TCC grants, own credentials, agents unable to reach providers). Larger: process supervision, socket protocol, install/upgrade story. Deferred to OQ-1, not rejected. |
| **D. Adopt a third-party unified-messaging gateway** | Would replace the existing read-only work and its verification; no candidate covers local `imsg` plus SIP constraints. |

The chosen option is a stepping stone toward C: the interface, registry, and policy layer carry over, but a process boundary additionally adds serialization, process lifecycle, and its own auth — that cost, not merely the socket, is why C is deferred.

## Decision Log

### DL-1: Proceed without an accepted parent proposal?

- **Options:** A — frame and accept a proposal first; B — proceed with the spec and record the skip; C — stop.
- **Choice:** B
- **Rationale:** The architecture direction was decided in conversation on 2026-10-29 (gateway + adapters + agent containment). The user directed the write-up. No `proposals/` directory exists in this repo, so the gate could not be satisfied in the normal way.
- **Date:** 2026-10-29
- **Reverses if:** a proposal is later written that scopes the gateway differently, or a maintainer rejects the direction.

### DL-2: In-process adapters rather than a separate daemon

- **Options:** A — keep the monolith; B — in-process adapters behind one interface; C — separate gateway process with its own identity.
- **Choice:** B
- **Rationale:** Produces the boundary and the single policy point without a process boundary, supervision, or install story. C is the only option that enforces goal 4, but it is a superset of B: the interface and registry survive the move.
- **Date:** 2026-10-29
- **Reverses if:** OQ-1 concludes containment requires a separate process; then B is retained and the adapters are hosted in C.

### DL-3: One normalized model, not per-provider passthrough

- **Options:** A — normalized `Conversation`/`Message` for all providers; B — per-provider shapes surfaced to the gateway consumer.
- **Choice:** A
- **Rationale:** The cache, search index, and UI already assume one shape. Passthrough would push provider differences into every consumer, and the cache schema migration would be far more expensive later.
- **Date:** 2026-10-29
- **Reverses if:** a provider needs a capability the normalized model cannot express without loss (for example, native reply threading), and hiding it degrades the UI.

### DL-4: `send` is declared on the interface but gated at the gateway

- **Options:** A — omit `send` until approval exists; B — declare it, implement per adapter, gate centrally.
- **Choice:** B
- **Rationale:** WhatsApp already sends through its own confirmation path, and Gmail's `send_gmail` is registered but disabled fail-closed pending the owner-confirmation boundary; pretending the interface has no send would leave both existing paths outside the policy layer. Central gating gives one place to add the human-approval boundary when it exists.
- **Date:** 2026-10-29
- **Reverses if:** the approval boundary lands as a host feature (GH #6556) and the gate moves into bb rather than the gateway.

## Open Questions

### OQ-1: Which containment mechanism actually holds?

- **Blocks:** goal 4; DL-2's reversal condition.
- **Closed by:** a spike proving (a) an agent shell cannot execute `imsg`, send AppleEvents, or drive the UI, and (b) the gateway still can. Candidates: separate macOS user, sandbox profile, VM.
- **Decider:** robert.
- **Status:** open

### OQ-2: Where do provider credentials and sessions live once the gateway owns them?

- **Blocks:** goal 4 for Gmail (OAuth tokens) and WhatsApp (Baileys session files).
- **Closed by:** a decision on Keychain ACLs vs an encrypted store vs filesystem permissions, plus evidence that an agent running as the same user cannot read them.
- **Decider:** robert.
- **Status:** open

### OQ-3: Does the gateway need a CLI/MCP surface, or is RPC enough?

- **Blocks:** nothing structural; affects goal 1's wording.
- **Closed by:** a check of whether any real caller needs to reach the inbox outside bb's plugin RPC.
- **Decider:** robert.
- **Status:** open

### OQ-4: Who owns search when adapters arrive?

- **Blocks:** Migration.
- **Closed by:** deciding whether adapters return pre-ranked matches or the gateway keeps the single BM25 index. Current index is global and provider-agnostic.
- **Decider:** robert.
- **Status:** open

### OQ-5: How are attachment bytes streamed across the adapter boundary?

- **Blocks:** the `media` signature; today base64 data URLs are returned to the UI.
- **Closed by:** measuring the current media path — base64 data URLs via `media` (WhatsApp images, bounded by `IMAGE_LIMIT`) and `imsg_media` (Messages images, bounded at 6 MiB by `IMSG_IMAGE_LIMIT`; WhatsApp video by `VIDEO_LIMIT`; RPC frames capped at 8 MiB) — and deciding whether to keep data URLs or move to a handle-based fetch.
- **Decider:** robert.
- **Status:** open

## Migration

Live system: the plugin runs against real accounts with mutating actions — Gmail `action` modifies threads, WhatsApp marks read, and a confirmed WhatsApp send dispatches — plus a SQLite cache and a verified rollback copy. Production registration follows whichever thread build was installed last (currently the tagging thread's build; consolidation of the three divergent trees is the prerequisite state — see [the consolidation plan](../../docs/plans/2026-10-29-inbox-branch-consolidation.md)). Git reverts code, not provider-side effects, so states that touch dispatch warrant extra care. States:

1. **Types and interface land, no behaviour change.** `src/adapters/types.ts` added; existing helpers untouched; all current tests pass unchanged. Reversible.
2. **Adapters wrap existing code.** Each provider gets an adapter that delegates to today's functions (`gmail()`, `listWa()`, `imsg-*`). `server.ts` still calls the old paths; new adapters are exercised only by tests. Reversible.
3. **Gateway switches to the registry.** `server.ts` handlers call `adapter.<method>`; per-provider branches removed. Cache rows and index entries unchanged — no schema migration. Reversible by restoring the previous `server.ts`; the cache is untouched either way.
4. **Policy layer inserted** between handler and adapter. WhatsApp's existing confirmation moves behind it. Reversible.
5. **Legacy branches deleted.** `gmail()`, `wa()`, and the per-account `if` chains removed. **Point of no return** for this spec's code shape (recoverable only from git).

Data at rest: none dropped. The cache schema is unchanged in every state; `account` stays a column. Media and message rows keep today's keys, so a rollback to the installed snapshot still reads them.

## Test plan

| Goal | Tier | What proves it |
|---|---|---|
| 1 — one entry point | contract | Every provider-backed RPC method routes through the registry; a fake adapter is reachable for each account key. Cache-serving methods (`cached`, `cached_open`, `clear_cache`) stay gateway-owned. |
| 2 — adapters own providers | unit | Each adapter maps its raw payload to `Conversation`/`Message`; existing mapping tests (`imsg-mapping`, `gmail-mime`, `whatsapp-chat`) move under the adapter and keep their assertions. |
| 3 — policy once | integration | A gate inserted at one point rejects unapproved and stale `send` calls for every adapter, no adapter can bypass it, and an approved WhatsApp send still passes. |
| 4 — boundary | — | **Not verifiable in this spec.** Depends on OQ-1; today only the plugin-side surface can be asserted. |

Failure modes worth explicit tests: one provider down does not fail `list` for the others (partial `errors` already returned); adapter throwing inside `media` does not poison the cache; concurrent refresh and open do not interleave into a torn thread; WhatsApp confirmation still rejects a stale proposal.

Not verifiable before ship: real provider behaviour under containment (blocked on OQ-1); production cache performance after the registry indirection (measurable only on real data).

## Links

- [Local Messages inbox plan](../../docs/plans/2026-10-28-003-feat-local-messages-inbox-plan.md)
- [Messages send approval proposal](../../docs/plans/2026-10-29-messages-send-approval-proposal.md)
- [Human authorization requirements](../../docs/plans/2026-10-29-messages-human-authorization-requirements.md)
- [GH #6556 — trusted human-gesture signal](https://github.com/get-bb/bb/issues/6556)
- [BB #1541](https://github.com/get-bb/bb/issues/1541) · [BB #1564](https://github.com/get-bb/bb/issues/1564)
