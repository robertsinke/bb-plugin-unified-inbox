---
type: spec-tasks
description: "Task breakdown for the Unified Inbox gateway and adapter refactor"
status: draft
owner: robert
created: 2026-10-29
parent_spec: ./spec.md
tags: [spec, tasks]
---

# Tasks — Unified Inbox gateway and adapters

## Tasks

Ordered by dependency. Each task is independently verifiable; do not start a task before its predecessors are green.

- [x] **T1. Adapter types and interface** — Created `src/adapters/types.ts`: `Conversation`, `Message`, `ProviderError`, `SendReceipt`, and the adapter interface with `capabilities()`, `list`, `open`, `media(account, id, index)`, `action(kind, id, opts)`, optional `send`. Action kinds enumerated per provider in comments (Gmail: read/unread/archive; WhatsApp: read/unread/reply/confirm/reject; Messages: none). *Verified by:* `npx tsc --noEmit` passes with the new file imported nowhere (tsconfig include extended to `src`/`tests` so the check is real).
- [x] **T2. ProviderError redaction rule** — Defined in `src/adapters/types.ts` what `ProviderError` may carry (classification text only, ≤300 chars, single line); redaction enforced in `src/adapters/provider-error.ts` (`toProviderError`, `redactProviderText`): labeled secrets, `ya29`/JWT tokens, and opaque runs scrubbed; raw stderr/stdout never enter the message. *Verified by:* `tests/adapters/provider-error.test.ts` feeding credential-laden error strings through the normalizer and asserting redaction — 6 cases, all green.
- [ ] **T3. Gmail adapter** — Create `src/adapters/gmail.ts` wrapping `gmail()`, `listGmail()`, thread/attachment fetch, and the disabled `send_gmail` handler as the adapter's `send`. *Verified by:* existing Gmail tests (`gmail-body`, `gmail-mime`, `gmail-upload`) pass against the adapter; new `tests/adapters/gmail.test.ts` covers list/open/action mapping with fixtures.
- [ ] **T4. Messages adapter** — Create `src/adapters/imsg.ts` wrapping `imsg-client`, `imsg-mapping`, `imsg-media`. No `send` implementation. *Verified by:* existing `imsg-client`, `imsg-mapping`, `imsg-media` tests pass under the adapter; media path still confines files and enforces the 6 MiB bound.
- [ ] **T5. WhatsApp adapter** — Create `src/adapters/whatsapp.ts` wrapping `wa()`, `listWa()`, `waImage`, and `confirmInWhatsAgent` as `send` plus the propose/confirm action kinds, preserving proposalId/hash stale rejection. *Verified by:* `whatsapp-chat`, `whatsapp-confirm`, `whatsapp-media` tests pass; new adapter test asserts a stale proposal is rejected.
- [ ] **T6. Registry** — Create `src/adapters/index.ts` mapping `account → adapter`; capability flags per provider. *Verified by:* unit test asserting a fake adapter is reachable for each account key and absent for unknown keys — `tests/adapters/registry.test.ts`.
- [ ] **T7. Gateway routing** — Rewire `server.ts` handlers to dispatch through the registry; keep `cached`, `cached_open`, `clear_cache` gateway-owned; delete per-provider dispatch branches from handlers. *Verified by:* full existing suite green; contract test asserting every provider-backed RPC method reaches a fake adapter; live read-only smoke via `bb plugin rpc` against a temporary registration is **not** run without separate approval.
- [ ] **T8. Policy layer** — Insert one gate between handlers and `adapter.send`: unapproved and stale sends rejected for every adapter; approved WhatsApp sends pass; `send_gmail` stays disabled behind it. Define audit records (operation, timestamp, account, conversation/message id, policy decision; no bodies, no bytes). *Verified by:* integration test `tests/adapters/policy.test.ts` — unapproved/stale/replayed rejected, approved WhatsApp send accepted, audit row written without message text.
- [x] **T9. Media unification** — Done (`56e7270`). One `media` RPC carries a `MediaRequest` that names how the file is addressed (`message` slot, `imsg` attachment slot, `attachment` name); `Adapter.media(request)` answers it, `attachment` and `imsg_media` are gone, and `MediaPayload` describes both answers with an optional `size`. *Verified by:* `tests/media-request.test.ts` pins the request shapes and the single-method interface; 251 tests green; live — old names answer `unknown_method`, each kind routes to its own adapter wording, and a cached image returned 265 KB through the one path. Size bounds unchanged (`IMAGE_LIMIT`, `VIDEO_LIMIT`, `IMSG_IMAGE_LIMIT`, 8 MiB frame cap).
- [ ] **T10. Legacy deletion** — Tag the commit, then remove `gmail()`, `wa()`, per-account `if` chains, and dead helpers. *Verified by:* full suite green; `rg 'function (gmail|wa)\(' server.ts` returns nothing; `npx tsc --noEmit` clean.
- [ ] **T11. Spec status update** — Move `spec.md` to the next status per repo convention and record actuals in the Migration section if any state deviated. *Verified by:* spec frontmatter matches shipped reality.

## Done when

- One registry surface: every provider-backed RPC method dispatches through the adapter registry; cache-serving methods are documented gateway-owned.
- Adapters own providers: Gmail, Messages, WhatsApp logic lives in `src/adapters/*` with their mapping tests; `server.ts` contains routing and gateway concerns only.
- Policy lives once: a single gate rejects unapproved and stale sends for every adapter, accepts approved WhatsApp sends, keeps `send_gmail` disabled, and writes audit records without message bodies.
- All existing tests pass; `npx tsc --noEmit` is clean; no cache or index schema change.
- Goal 4 (containment) is **not** claimed anywhere; it remains owned by OQ-1.

## Out of scope

Per the spec's non-goals: enabling Messages or Gmail sending; choosing the containment mechanism (OQ-1); new providers (LinkedIn arrives as its own validation later); outgoing reactions, threaded replies, edit history, video/document attachments; UI rewrites. Deployment to the installed plugin follows the separate activation protocol and is not part of these tasks.