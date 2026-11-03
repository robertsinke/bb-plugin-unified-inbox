---
type: spec-plan
description: "Build phases and risks for the Unified Inbox gateway and adapter refactor"
status: shipped
owner: robert
created: 2026-10-29
parent_spec: ./spec.md
tags: [spec, plan]
date: 2026-11-03
---
> **Historical.** The gateway shipped and the code has moved past this document; read the status
> block in `spec.md` for what changed, and `PLUGIN_OVERVIEW.md` for the current contract.


# Plan — Unified Inbox gateway and adapters

## Source sync design input

The [source synchronization model](../../docs/plans/2026-10-30-inbox-source-sync-model.md) defines the shared domain terms, independent conversation/message paging, provider-owned sync cursors, cache semantics, and source-specific freshness guarantees. Use it when refining gateway states 2+; it is design input, not authorization to expand the current adapter tasks.

## Approach

In-process gateway plus per-provider adapters (spec DL-2): one adapter interface in `src/adapters/types.ts`, one registry in `src/adapters/index.ts`, `server.ts` reduced to routing plus gateway-owned concerns, and a single policy layer in front of every adapter `send`. The five migration states in the spec are executed in order, each keeping the full test suite green and the cache schema untouched. Messages sending and Gmail sending stay disabled throughout; the policy layer exists to gate them, not to enable them. Deployment to the installed plugin is **not** part of this plan — it follows the existing activation protocol when the owner separately approves it.

## Phases

1. **Types and interface.** Add `src/adapters/types.ts` with `Conversation`, `Message`, `ProviderError`, `SendReceipt`, and the adapter interface (`capabilities`, `list`, `open`, `media(account, id, index)`, `action(kind, id, opts)`, optional `send`). No behavior change; existing code untouched.
2. **Adapters wrap existing code.** `src/adapters/gmail.ts`, `imsg.ts`, `whatsapp.ts` delegate to today's functions (`gmail()`, `listGmail()`, `imsg-*`, `wa()`, `listWa()`, `confirmInWhatsAgent`). `server.ts` still calls the old paths; only tests exercise adapters.
3. **Gateway routes through the registry.** `server.ts` handlers dispatch via the registry; per-provider branches removed. Cache-serving methods (`cached`, `cached_open`, `clear_cache`) stay gateway-owned. No cache or index schema change.
4. **Policy layer.** One gate between handlers and `adapter.send`. WhatsApp's propose/confirm semantics (proposalId, hash, stale rejection) pass through intact; `send_gmail` routes behind it, still disabled. Audit records defined here: operation, timestamp, account, conversation/message id, policy decision — no message bodies, no attachment bytes.
5. **Legacy branch deletion.** Remove `gmail()`, `wa()`, the per-account `if` chains, and dead helpers. Tag the commit first; this is the point of no return for the code shape.

## Risks + unknowns

- **Three-tree drift (state 0, blocking).** `server.ts` and `app.tsx` are modified in three unmerged trees: this worktree (Messages + architecture), the tagging thread's branch (committed, currently serving production), and the LinkedIn thread's WIP (uncommitted, in the main checkout). Gateway states 2–3 rewrite `server.ts`, so they must start from the consolidated tree — see [the consolidation plan](../../docs/plans/2026-10-29-inbox-branch-consolidation.md). T1–T2 are type-only additions and are safe to have landed already.
- **OQ-1 containment (design-blocking, but not refactor-blocking).** The structural refactor delivers goals 1–3 on its own; the containment claim stays deferred until the OQ-1 spike closes. If no mechanism holds, the refactor still stands on maintainability, and the spec's goal 4 wording already reflects that.
- **States 3–4 gap.** Between state 3 and state 4, `adapter.send` is RPC-reachable before the policy layer exists. Mitigation: land states 3 and 4 in the same change, or keep send-capable handlers on the legacy path until the gate lands.
- **OQ-4 search ownership.** No adapter work may depend on search ranking until OQ-4 closes; the `search` capability stays annotation-only.
- **OQ-5 media transport.** `media(account, id, index)` fixes routing only; data-URL-vs-handle transport is decided at plan time for state 2, with a size bound on fetches either way.
- **Audit placement.** Audit contents are defined in state 4; storage placement rides the OQ-1/OQ-2 boundary outcome and must not be hardcoded before then.
- **Provider error leakage.** `ProviderError` redaction rules are written before the first adapter normalizes raw provider failures.

## Dependencies

- Spec `draft` sign-off by the owner (this plan is the greenlight artifact).
- Consolidated main baseline — [the consolidation plan](../../docs/plans/2026-10-29-inbox-branch-consolidation.md) merges the Messages, tagging, and LinkedIn trees into one main line before state 2; state 1 (types only) may land before or during.
- GH #6556 / the send-approval proposal — gates any future *enabling* of sends; nothing in this plan waits on it.
- OQ-1 spike — gates only the containment claim and any move to option C (separate daemon), not the refactor.

## Rollout

Mirrors the spec's migration states 1–5, each landing as its own verified commit in the feature worktree on top of the consolidated baseline ([consolidation plan](../../docs/plans/2026-10-29-inbox-branch-consolidation.md), step 6): types → adapters → registry routing → policy layer → deletion. States 1–4 are reversible by reverting the commit; state 5 is the no-return point (tagged). Production activation, if approved later, goes through the existing activation check and rollback copy protocol.