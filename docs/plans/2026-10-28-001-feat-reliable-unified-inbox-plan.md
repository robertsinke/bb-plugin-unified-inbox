---
title: "feat: Reliable unified inbox"
type: feat
status: superseded
date: 2026-10-28
---

> **Superseded.** This plan's outcome shipped; the current contract is `PLUGIN_OVERVIEW.md` and
> `src/rpc-contract.ts`. Decisions that postdate it: `decisions/0001`–`0004`. Kept as history.

# feat: Reliable unified inbox

## Summary

Replace repeated full inbox refreshes with a responsive, paginated, incrementally synchronized inbox; support normal Gmail and WhatsApp actions safely in BB; investigate and correct WhatsApp dates.

---

## Problem frame

The prototype can take tens of seconds to refresh, shows limited messages, uses a temporary polling implementation and cannot send Gmail replies. WhatsApp replies currently require a separate owner confirmation in WhatsAgent. The user reports that WhatsApp dates appear as January 21. The two Gmail accounts and the existing headless WhatsAgent backend are already connected.

---

## Requirements

- R1. Show available cached messages immediately, clearly identify unread messages and accounts, and independently communicate loading, sync age, stale data and failures.
- R2. Browse older Gmail and WhatsApp conversations through real pagination, without gaps, duplicates or cross-account mixing.
- R3. Incrementally synchronize both Gmail accounts, handle expired history and offline/restart recovery, and avoid repeatedly fetching the full inbox.
- R4. Use the existing WhatsAgent backend and database; never create or start a second WhatsApp connection.
- R5. Support normal Gmail compose, reply, reply-all and forward, plus read/unread and archive, with correct account and recipients.
- R6. Enable owner-confirmed WhatsApp sending within BB without allowing an agent to approve its own proposals; handle failures and delivery status honestly.
- R7. Investigate and fix reported WhatsApp timestamps using actual source units, correct timezone presentation and regression coverage.
- R8. Preserve privacy, account isolation, safe retries, and a usable UI on partial source failures.

## Scope boundaries

- Exhaustive Gmail and WhatsAgent API coverage, external provider support, and unattended agent sending are excluded.
- Normal inbox actions include the explicitly requested actions above. Inventory available capabilities and surface unsupported operations honestly rather than exposing every API.
- Do not change or discard existing WhatsAgent session credentials or the user's Gmail authorizations.

---

## Context & research

- `server.ts` currently shells out to GWS per Gmail thread, runs independent `list_source` calls, and connects to WhatsAgent MCP over loopback; it does not launch a backend.
- `app.tsx` currently displays an initial five Gmail threads then fetches 20 and polls while visible. `inbox.css` owns panel styling. `README.md` documents prototype limitations.
- WhatsAgent owns its storage, action registry, outbox and timestamp conversion. Its headless MCP does not instantiate the WhatsApp transport; `propose-send` is tool-callable but `confirm-proposal` is owner/frontend-only and checks content hash, staleness and single-use transaction semantics. The existing launch agent already runs the backend.
- GWS is installed and both accounts use separate configuration directories. GWS CLI schema discovery confirms Gmail history and threads endpoints. Official references: [Gmail synchronization](https://developers.google.com/workspace/gmail/api/guides/sync), [history.list](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.history/list), [sending mail](https://developers.google.com/workspace/gmail/api/guides/sending), [threads](https://developers.google.com/workspace/gmail/api/guides/threads).
- The WhatsAgent repository is separate; its paths below are relative to that repository, not this plugin.

---

## Key technical decisions

- **Persistent local index, not repeated thread fan-out:** use BB plugin-owned storage for account-scoped metadata and cursors; cache message content only to the extent necessary for the selected UX. Treat cached mail as sensitive, bound retention and permissions, document removal and avoid logging contents or tokens.
- **Incremental sync per account:** acquire an initial history baseline before listing, bootstrap the first page, then replay history from that baseline; advance the cursor atomically only after all changes have been applied. Paginate history and recover from expired cursors with a safe full resync. Incremental sync must handle label changes, deletion, messages moving in and out of inbox, and duplicate events.
- **A responsive independent-source UI:** render cached entries immediately; synchronize in the background with bounded concurrency and no overlapping worker for the same account. Distinguish initial load from an older-page request. Use stable source-specific cursors and deterministic sort/tie-breakers; avoid claiming global chronological completeness when an unexhausted source has older pages.
- **GWS transport is provisional:** benchmark whether the CLI supports efficient history and message retrieval without keyring contention. Prefer supported GWS behavior and preserve account isolation. If batching or authentication limitations prevent responsive sync, evaluate a supported Gmail API client rather than reading undocumented credential files. Do not expose secrets or message bodies in process arguments or logs without a deliberate security review.
- **Human confirmation is a trust boundary, not a visual dialog:** an agent-callable RPC plus a browser confirmation is insufficient. Verify a BB-supported authenticated owner-presence mechanism; extend the appropriate boundary only if it can prove owner approval and bind approval to the exact recipient and content. If that cannot be established, keep sending disabled and report the blocker; never bypass WhatsAgent's frontend-only rule.
- **Single backend, fail closed:** attach to the existing launch-managed service. Do not add automatic launch or recovery that could start a second transport; service lifecycle improvements require a proven shared lock covering every entry point.

---

## Implementation units

### U1. Characterize sources and correct timestamps

**Goal:** Resolve incorrect WhatsApp dates and establish a measurable baseline.

**Requirements:** R1, R4, R7, R8. **Dependencies:** None.

**Files:** Modify `server.ts`, `app.tsx` as indicated by investigation; create `tests/timestamps.test.ts` and `tests/source-contracts.test.ts`. WhatsAgent repository: inspect `server/channels/whatsapp/ingest.ts`, `server/api/message-view.ts`, `server/actions/get-messages.ts`.

**Approach:** Compare source timestamp values, persisted units and UI conversion using privacy-preserving aggregate diagnostics. Normalize once at the owning boundary, preserve valid milliseconds and display local time; do not guess the cause from the January symptom. Establish baseline time to first usable result and source-level error rate without logging message contents.

**Execution note:** Characterize representative timestamp fixtures before changing conversion.

**Test scenarios:** Seconds and milliseconds map to the intended date; null/invalid values produce a clear fallback; source list and detail agree; timestamps remain ordered across sources; real source adapter returns correct normalized values.

**Verification:** A known recent WhatsApp message displays its correct date and first-result latency is measurable.

### U2. Account-scoped cache and Gmail synchronization

**Goal:** Show cached data promptly and reliably track changes without full reloads.

**Requirements:** R1, R3, R8. **Dependencies:** U1.

**Files:** Modify `server.ts`, `package.json`; create `src/cache.ts`, `src/gmail-sync.ts`, `tests/cache.test.ts`, `tests/gmail-sync.test.ts`.

**Approach:** Introduce versioned plugin storage with per-account identity, history cursor and sync state. Separate source adapters from RPC. Implement bootstrap, paginated history replay, bounded per-account concurrency, coalesced triggers, backoff and restart recovery. Transactions commit cache updates and cursor together; resync stages replacement safely and retains old visible data with stale status on failure. Ensure SQLite and any temporary data are private and cleanup is defined. Measure GWS and select a supported transport during implementation; avoid relying on unsupported token storage internals.

**Test scenarios:** Separate accounts cannot collide on thread IDs; startup cache appears before network completes; events during bootstrap are replayed; multi-page history applies in order; duplicate events are idempotent; labels and deleted messages update the index; expired history triggers resync without losing the previous cache on failure; crashes cannot advance the cursor ahead of writes; overlapping triggers coalesce; auth failure affects only its account; local data removal is explicit.

**Verification:** Two consecutive refreshes with no Gmail changes avoid full thread retrieval; both accounts recover independently after reconnect.

### U3. Pagination and freshness UX

**Goal:** Provide understandable and responsive browsing across all sources.

**Requirements:** R1, R2, R3, R4, R8. **Dependencies:** U2.

**Files:** Modify `app.tsx`, `inbox.css`, `server.ts`, `README.md`; create `tests/pagination.test.ts`, `tests/inbox-ui.test.tsx`.

**Approach:** Keep per-source continuation and completion state and merge cached pages deterministically. Offer clear load-more controls, incremental updates, unread markers, source-specific sync status, stale/error/retry states and loading feedback. Coordinate background polling centrally rather than one timer per panel instance; refresh on reopen or focus and prevent races between requests and selection. Poll only through the existing WhatsAgent backend; use its existing pagination contracts and test timestamp tie-breakers.

**Test scenarios:** Empty source and offline source do not hide healthy sources; multiple pages with identical timestamps contain no duplicate or missing items; asynchronous completions and rapid filter/selection changes do not replace newer state; UI indicates partial results and stale cache; background refresh and manual refresh coalesce; mounted panels receive updates; WhatsAgent is never spawned.

**Verification:** Usable cached inbox is visible immediately and first-page and subsequent-page timing are recorded under representative conditions.

### U4. Gmail normal messaging and actions

**Goal:** Compose, reply, reply-all and forward from the correct account with explicit user intent.

**Requirements:** R5, R8. **Dependencies:** U2, U3.

**Files:** Modify `server.ts`, `app.tsx`, `inbox.css`, `README.md`; create `src/gmail-actions.ts`, `tests/gmail-actions.test.ts`, `tests/compose-ui.test.tsx`.

**Approach:** Inventory supported Gmail operations and implement the requested actions, including correct thread ID, MIME encoding, message references, reply-to handling and reply-all recipient deduplication/self-exclusion; forward is a new outgoing message with explicit recipients. Show sender/account and recipients before sending. Integrate archive and read/unread with cache reconciliation. Preserve drafts on errors and report uncertain send outcomes without blind retries. Handle attachments only if supported and implemented securely; otherwise make limitations visible rather than silently dropping content.

**Test scenarios:** New mail uses selected account; reply honors Reply-To and thread headers; reply-all handles duplicate addresses, aliases and self; forward targets explicitly selected recipients; non-ASCII headers/body round-trip; untrusted content cannot inject headers; send failure preserves text; timeout after possible send reports unknown outcome and does not retry; account isolation and concurrent actions hold; archive/unread update after authoritative response.

**Verification:** Controlled integration tests with a test mailbox demonstrate correct recipients and threading without sending to real contacts.

### U5. Protected WhatsApp confirmation and delivery

**Goal:** Send through the existing backend entirely from BB while preserving human approval and single-connection safety.

**Requirements:** R4, R6, R8. **Dependencies:** U3. **Blocking prerequisite:** Establish a real owner-authenticated confirmation mechanism; do not substitute a frontend button or generic RPC.

**Files:** Modify `server.ts`, `app.tsx`, `inbox.css`, `README.md`; create `src/whatsapp-actions.ts`, `tests/whatsapp-approval.test.ts`, `tests/whatsapp-ui.test.tsx`. If a supported owner boundary requires an upstream change, plan that change in the WhatsAgent repository's `server/actions/confirm-proposal.ts`, `server/api/routes.ts` and corresponding tests; do not weaken existing frontend-only authorization.

**Approach:** Reuse WhatsAgent proposal and outbox lifecycle. Bind approval to exact chat, content, proposal and latest inbound; preserve atomic single-use confirmation and stale conflict handling. Show queued, sent, failed and unknown states; retain drafts on errors. Ensure backend discovery failure does not launch a replacement. Validate and test the owner identity boundary before connecting it to sending.

**Test scenarios:** An agent or direct RPC caller cannot approve; an actual authorized owner can approve only the reviewed proposal; changed content or newer inbound requires re-review; duplicate approvals enqueue at most once; disconnected backend creates no second connection; unknown delivery outcome is not retried as a fresh send; group support is explicitly accurate to upstream capabilities.

**Verification:** End-to-end owner approval through BB and denial of agent-only attempts are demonstrated against an isolated fake transport. If no trustworthy owner identity mechanism exists, the unit remains blocked and send stays disabled.

---

## Risks and rollout

- **Sensitive local data:** document what is cached, filesystem protections, retention, clear-cache behavior, and access by trusted BB clients. Do not log message bodies, credentials or raw API failures.
- **Correctness during synchronization:** isolate cursors by account, apply changes atomically, and retain stale data on failed recovery. Reconcile actions with subsequent source updates.
- **Delivery and connection safety:** do not retry an ambiguous send automatically, weaken owner checks, or launch a second WhatsApp socket. Existing launch-agent ownership remains unchanged.
- **Deployment:** characterize and test with fixtures first; build and reload only after non-destructive checks. Verify in the real panel without sending to contacts; use a designated test mailbox or fake transport for sending.
- **Performance:** record cold-cache time, cached time-to-first-content, incremental refresh time and error rate per source. The goal is visibly immediate cached rendering and materially faster fresh first results than the observed 23–62 second full refresh; choose numeric targets after profiling.
