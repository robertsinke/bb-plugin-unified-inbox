---
type: spec-tasks
description: "Task breakdown for the Unified Inbox gateway and adapter refactor"
status: shipped
owner: robert
created: 2026-10-29
parent_spec: ./spec.md
tags: [spec, tasks]
---

# Tasks — Unified Inbox gateway and adapters

> **Open work lives in BB Tasks (project `INBOX`), not here.** This checklist records what the
> spec unit shipped and the commit that closed it; it is not a tracker. As of 2026-11-02 the only
> open unit is **T8**, tracked as **INBOX-7**. Do not add new work to this file.

## Tasks

Ordered by dependency. Each task is independently verifiable; do not start a task before its predecessors are green.

- [x] **T1. Adapter types and interface** — Created `src/adapters/types.ts`: `Conversation`, `Message`, `ProviderError`, `SendReceipt`, and the adapter interface with `capabilities()`, `list`, `open`, `media(account, id, index)`, `action(kind, id, opts)`, optional `send`. Action kinds enumerated per provider in comments (Gmail: read/unread/archive; WhatsApp: read/unread/reply/confirm/reject; Messages: none). *Verified by:* `npx tsc --noEmit` passes with the new file imported nowhere (tsconfig include extended to `src`/`tests` so the check is real).
- [x] **T2. ProviderError redaction rule** — Defined in `src/adapters/types.ts` what `ProviderError` may carry (classification text only, ≤300 chars, single line); redaction enforced in `src/adapters/provider-error.ts` (`toProviderError`, `redactProviderText`): labeled secrets, `ya29`/JWT tokens, and opaque runs scrubbed; raw stderr/stdout never enter the message. *Verified by:* `tests/adapters/provider-error.test.ts` feeding credential-laden error strings through the normalizer and asserting redaction — 6 cases, all green.
- [x] **T3. Gmail adapter** — Shipped as `src/adapters/gmail.ts` (one factory serving both Gmail accounts), covering list/sync/open/action/attachment/send. *Verified by:* `tests/adapters/personal.test.ts`, `tests/adapters/business.test.ts`, plus the Gmail body/mime/upload suites.
- [x] **T4. Messages adapter** — Shipped as `src/adapters/imessage.ts` over `imsg-client`/`imsg-mapping`/`imsg-media`; sends through `imsg send`, attachments through the one media primitive. *Verified by:* `tests/adapters/imessage.test.ts` and the `imsg-*` suites.
- [x] **T5. WhatsApp adapter** — Shipped as `src/adapters/whatsapp.ts` over the WhatsAgent backend; group send is one call and a stale approval is still refused. *Verified by:* `tests/adapters/whatsapp.test.ts` and the `whatsapp-*` suites.
- [x] **T6. Registry** — Shipped as `src/adapters/index.ts`: `account → adapter` with capabilities declared once (`CAPABILITY_KEYS`) and `NO_CAPABILITIES` as the fallback. *Verified by:* `tests/adapters.test.ts`, `tests/capability-keys.test.ts`.
- [x] **T7. Gateway routing** — Shipped: every handler dispatches through `registry[...]`; `cached`, `cached_open`, `clear_cache` stay gateway-owned. The per-source refresh branch was the last one and it is gone (`56e7270`’s sibling `fbf7bee`, one `sync` RPC). *Verified by:* full suite + live five-account `sync`.
- [ ] **T8. Policy layer** — **Open, tracked as INBOX-7 in BB Tasks** (the tracker is the source of truth). Today `send_gmail` refuses behind an inline `const sendingVerified = false`, WhatsApp/Messages handlers call `adapter.send` directly, and nothing writes an audit record. Needed: one gate in front of every adapter send (unapproved, stale and replayed refused for all five sources), plus an audit record carrying operation, timestamp, account, conversation id and policy decision but no bodies and no bytes. *Verified by:* `tests/adapters/policy.test.ts` — refusals for every adapter, an approved WhatsApp send passing, and an audit row without message text.
- [x] **T9. Media unification** — Done (`56e7270`). One `media` RPC carries a `MediaRequest` that names how the file is addressed (`message` slot, `imsg` attachment slot, `attachment` name); `Adapter.media(request)` answers it, `attachment` and `imsg_media` are gone, and `MediaPayload` describes both answers with an optional `size`. *Verified by:* `tests/media-request.test.ts` pins the request shapes and the single-method interface; 251 tests green; live — old names answer `unknown_method`, each kind routes to its own adapter wording, and a cached image returned 265 KB through the one path. Size bounds unchanged (`IMAGE_LIMIT`, `VIDEO_LIMIT`, `IMSG_IMAGE_LIMIT`, 8 MiB frame cap).
- [x] **T10. Legacy deletion** — Done: `function gmail(`/`function wa(` are gone from `server.ts` (grep count 0); adapters own the provider calls.
- [x] **T11. Spec status update** — `spec.md`, `plan.md` and this file move to `status: shipped`; T8 is the one unit deliberately left open and is tracked in BB Tasks as INBOX-7.

## Done when

- One registry surface: every provider-backed RPC method dispatches through the adapter registry; cache-serving methods are documented gateway-owned.
- Adapters own providers: Gmail, Messages, WhatsApp logic lives in `src/adapters/*` with their mapping tests; `server.ts` contains routing and gateway concerns only.
- Policy lives once: a single gate rejects unapproved and stale sends for every adapter, accepts approved WhatsApp sends, keeps `send_gmail` disabled, and writes audit records without message bodies.
- All existing tests pass; `npx tsc --noEmit` is clean; no cache or index schema change.
- Goal 4 (containment) is **not** claimed anywhere; it remains owned by OQ-1.

## Out of scope

Per the spec's non-goals: enabling Messages or Gmail sending; choosing the containment mechanism (OQ-1); new providers (LinkedIn arrives as its own validation later); outgoing reactions, threaded replies, edit history, video/document attachments; UI rewrites. Deployment to the installed plugin follows the separate activation protocol and is not part of these tasks.