---
title: "Unified Inbox source synchronization model"
status: historical
date: 2026-10-30
---

# Unified Inbox source synchronization model

## Purpose

Define how Unified Inbox should grow beyond a fixed latest-N snapshot while keeping one gateway, provider-owned cursors, and a bounded local cache. This is a design baseline for gateway work, not a claim that all sources support the same sync guarantees.

## Ubiquitous language

Use these terms consistently in code, RPC, plans, and conversation:

- **Provider** — the external system and protocol implementation: Gmail, WhatsAgent/Baileys, macOS Messages via `imsg`, or LinkedIn through the BB browser.
- **Source** — one connected data scope the user can browse, such as the personal Gmail mailbox or the local Messages account. A source has a stable `sourceId`, a provider, and provider-specific identity/configuration. `account` is the current UI name for this concept; prefer `source` in new gateway interfaces.
- **Conversation** — the provider-owned container shown in the inbox: a Gmail thread, WhatsApp chat, Messages chat, or LinkedIn conversation. Do not call all of these “threads” in shared domain language; reserve *thread* for the Gmail/provider identifier or BB conversation when context says so.
- **Message** — an entry in a conversation. Its stable identity is scoped by source and conversation; an edit updates that identity rather than creating a new message.
- **Local read model** — the SQLite cache and search index used to render quickly and search offline. It is a projection, never the authority for whether a provider has older data or whether a sync is complete.
- **Sync cursor** — opaque provider-owned progress for reconciling changes in one source. It is distinct from a **page cursor**, which pages conversations or messages for browsing.
- **Sync run** — one bounded attempt to reconcile a source, recording start/end, outcome, cursor advancement, and whether cached data may be stale.

## Recommended behavior

1. **One gateway, source-scoped operations.** Callers use gateway operations for source discovery, conversation pages, message pages, media, search, and actions. Provider APIs and cursors remain inside their adapters.
2. **Two independent navigation dimensions.** The inbox pages conversations by source; opening one pages its messages. Older-conversation pagination must not be confused with history pagination inside a conversation.
3. **Initial load is bounded.** Show cached conversations immediately, then fetch a small first page per healthy source. Do not repeatedly fetch “latest N” as the only refresh strategy. A visible “load older” path continues using that source's page cursor and merges by stable identity.
4. **Sync is incremental where supported.** Each adapter reports whether it supports push, delta/cursor sync, or only polling/full snapshots. Persist one sync cursor per source. Apply a batch and its cursor atomically; replay is idempotent. If a cursor expires or a source only supports snapshots, stage a safe reconciliation and retain the previous read model if it fails.
5. **Provider changes update existing messages.** Upsert by stable message identity; edits replace body/metadata and carry `editedAt`/`isEdited`, deletes become tombstones where the provider exposes them, and reactions update independently. The UI reflects provider updates without inventing a second message.
6. **Cache has explicit bounds and status.** Keep conversation metadata and the search index separately from message bodies/media. Define retention by source and data class, expose cache age/stale state, cap media bytes, and make “clear local cache” semantics explicit. Never evict the only copy of an unacknowledged cursor or advance a cursor past unapplied writes.
7. **Source failures are isolated.** A failed source does not erase healthy results or its last good cache. Show a per-source error indicator at refresh; reveal details on hover/focus. Retry/backoff and in-flight coalescing are gateway-owned policies, while provider-specific recovery remains adapter-owned.
8. **Realtime is capability-based.** Prefer provider events when available; otherwise use bounded polling while the source or conversation is active. Surface actual freshness and do not label periodic polling as real-time. For WhatsApp, first ensure Baileys edit events are decoded, persisted, exposed, and propagated to the open conversation.

## Gateway contract direction

Keep stable IDs and provider cursors opaque at the boundary. New operations should conceptually be:

- `sources()` — stable source identity, display name, capabilities, last successful sync, stale/error status.
- `conversations(sourceId, pageCursor?)` — one page and its next page cursor.
- `conversation(sourceId, conversationId, pageCursor?)` — recent or older message page, plus continuation state.
- `sync(sourceId)` — coalesced incremental reconciliation; provider cursor remains private to the adapter.
- `search(query, scope?)` — query the read model and return source-scoped stable IDs; opening a hit can retrieve its surrounding message page.

This is a direction, not a requirement to add all five RPCs before any adapter can land. Preserve current callers through a narrow migration and do not expose `send` before the centralized policy gate.

## Invariants to test

- A source cursor is never shared across connected sources, even when provider IDs collide.
- A page cursor cannot advance the sync cursor; an older-page fetch cannot silently mean “fully synchronized.”
- Duplicate and out-of-order provider changes converge to one correct conversation/message state.
- An edited message updates the same stable message ID and its edited marker; it does not surface protocol/encryption metadata as user text.
- Cursor advancement and all corresponding cache/index writes commit together; failed or interrupted runs remain retryable.
- A provider outage retains last-known data, marks it stale, and leaves other sources usable.
- Pagination includes deterministic tie-breakers and produces no duplicates or gaps across equal timestamps.
- Cache retention and clear operations never expose provider credentials or log private message contents.

## Open design work before gateway states 2+

- Decide whether `sourceId` is a generated local identity or a stable provider account identifier, without persisting credentials in it.
- Inventory each source's real cursor, event, deletion, and older-page guarantees; do not assume symmetry.
- Choose retention defaults and migration/rollback behavior for the existing shared SQLite cache.
- Define how sync runs are scheduled/coalesced across multiple mounted inbox panels.
