---
title: 'feat: Redact inbox PII before inference'
type: feat
status: active
date: 2026-11-12
---

# feat: Redact inbox PII before inference

## Summary

Redact inbox text locally before attention scoring and before agent tools return it. Keep the human inbox unchanged. Evaluate OpenRedaction for detection, and use opaque references so agents can still address conversations without exposing source identifiers.

---

## Problem Frame

Attention scoring sends conversation text to the Decisions plugin. Inbox agent tools return conversation text and identifiers to agents, which can pass them to inference providers. Names, addresses, phone numbers and other identifiers can occur in free text, structured fields and source IDs. A visual blur would not protect these paths.

---

## Requirements

- R1. Redact detectable names, email addresses, telephone numbers, social security and other supported identifiers locally before attention requests and agent tool results leave the plugin.
- R2. Keep the human UI, original stored messages, search index and source data unchanged.
- R3. Preserve agent workflows for listing, searching, reading, paging, attachment retrieval, reactions and replies, without returning raw identifiers that may contain PII.
- R4. Keep original attachments available to agents, as explicitly requested. Their contents are not guaranteed to be redacted.
- R5. Do not claim complete PII protection. Report detection limits and the attachment exception.
- R6. If redaction fails, do not send unredacted text as a fallback. Do not expose original content in error messages or logs.

---

## Scope Boundaries

- This covers this plugin's Decisions request and agent-tool output boundaries, not all inference traffic in BB or other plugins.
- Original attachment bytes, including text files returned as attachments, remain accessible to agents; their filenames and surrounding metadata are text and must be protected. Attachment contents can expose PII.
- No modification of historical provider requests, deletion of cached data, OCR, audio transcription, or redaction of the human UI.
- User-supplied prompts and tool arguments may already have reached an inference provider before an inbox tool executes. This plugin cannot retract them.

---

## Context & Research

- `server.ts` sends the attention request to the Decisions plugin; `src/attention.ts` builds the state and uses original text to maintain line keys, scores and hashes. Transform a copy at the outbound boundary, not the stored state.
- `src/inbox-agent-tools.ts` registers list, search, read, refresh, attachment, reaction and reply tools. Conversation IDs, account IDs, message IDs and attachment filenames can be needed for later calls and can themselves contain PII. Responses also include nested quotes, reactions, coverage errors and filenames.
- `tests/attention.test.ts` and `tests/inbox-agent-tools.test.ts` cover the existing behavior and are the characterization baseline.
- `src/adapters/provider-error.ts` scrubs provider errors, but is not a general PII detector and must not be presented as one.
- [OpenRedaction](https://github.com/sam247/openredaction) documents local regex-first detection, name support and deterministic placeholders. It explicitly warns that detection is best effort. Its npm package has multiple integrations; `@openredaction/core` is separately published and should be evaluated as the narrower dependency.
- `docs/solutions/2026-11-05-a-name-only-arrives-with-live-traffic.md` illustrates why contact names cannot be assumed to exist in every source field.

---

## Key Technical Decisions

| Decision | Rationale |
|---|---|
| Redact locally at each outbound boundary | Protects the two requested paths without mutating data used by the UI, cache or source adapters. Do not enable hosted detection. |
| Treat detection as risk reduction, not a guarantee | Regex and contextual name detection can miss PII or redact harmless words. Use representative multilingual fixtures and record measured limitations, not a 100% claim. |
| Use field-aware protection and opaque handles | Free-text detection alone cannot safely handle source IDs or guarantee detection of standalone names. Hide known identity fields and replace routing identifiers with opaque handles, resolved only inside the plugin. |
| Fail closed on redaction and handle resolution errors | A failed detector or expired handle must never silently return original text or route a send to a different target. |
| Preserve attachment bytes as an explicit exception | The user chose continued original attachment access. The agent and operator documentation must state that files can still disclose PII. |

---

## High-Level Technical Design

> This illustrates the intended approach and is directional guidance for review, not implementation specification.

```text
Original cache / source data ──> human UI (unchanged)
             │
             ├──> local redaction ──> Decisions ──> attention result
             │
             └──> local redaction + opaque handles ──> agent tool result
                     agent tool input ──> resolve handles ──> existing gateway
                     original attachment bytes ──> agent (explicit exception)
```

---

## Implementation Units

### U1. Local redaction boundary

**Goal:** Provide one local, fail-closed redaction policy for outbound text.

**Requirements:** R1, R2, R5, R6.

**Dependencies:** None.

**Files:** Create `src/inference-redaction.ts`; modify `package.json`, `package-lock.json`; test `tests/inference-redaction.test.ts`.

**Approach:** Evaluate the published `@openredaction/core` API, version, license, build compatibility, supported locales and dependency footprint before selecting and pinning it. Configure local-only full replacement, not partial masks. Use one shared policy for structured names and free text; avoid emitting detection maps or raw values. Verify how the library handles names without context, international numbers, overlapping matches and split inputs. If it cannot meet the representative cases, document the gap and choose a local complement before enabling the feature; never silently substitute remote inference. Use synthetic data only for evaluation.

**Test scenarios:**
- Email, international telephone, contextual personal name and representative social-security number are absent from resulting text; non-sensitive task meaning remains.
- A standalone structured sender name is hidden even when regex name detection does not recognize it.
- Empty text, Unicode and adjacent or overlapping identifiers do not throw or return original detected identifiers.
- Detector failure returns a sanitized failure and never returns original input; no detection map reaches callers.
- Fixtures include expected false-negative and false-positive cases so limitations are visible rather than concealed.

**Verification:** The library runs locally in the plugin runtime; representative results meet the documented policy without mutating input.

### U2. Protect attention scoring

**Goal:** Redact the full request before it reaches Decisions while preserving attention state behavior.

**Requirements:** R1, R2, R6.

**Dependencies:** U1.

**Files:** Modify `server.ts`, `src/attention.ts` only if necessary; test `tests/attention.test.ts` and an appropriate server-wiring test.

**Approach:** At the Decisions RPC boundary, redact every untrusted textual value in a copy of the request, including title, preview, sender, message bodies and any custom wording that may contain user data. Preserve structural keys, line numbers and questions. Keep original-based hashing, line identity, cached verdicts, mute and push behavior local and unchanged. On redaction failure, skip the request and follow the existing classification failure path without recording raw content.

**Test scenarios:**
- A request containing PII in title, sender, preview, messages and custom wording reaches the fake Decisions RPC only in protected form; line keys and expected answer mapping remain intact.
- Repeated unchanged messages retain existing deduplication and score reuse; mute and notifications retain their established behavior.
- Detector error prevents the RPC and does not publish a new verdict or leak input through an error.

**Verification:** A boundary-level integration test captures the actual outbound RPC payload, not only a mocked helper call.

### U3. Protect agent outputs and preserve routing

**Goal:** Protect tool output text and make subsequent agent operations work without exposing source identifiers.

**Requirements:** R1–R4, R6.

**Dependencies:** U1.

**Files:** Modify `src/inbox-agent-tools.ts`, `server.ts` as needed; create `src/inbox-agent-references.ts` if needed; test `tests/inbox-agent-tools.test.ts` and `tests/inbox-agent-references.test.ts` if created.

**Approach:** Inventory all returned fields, including nested message metadata, errors, action results, account identifiers, paths, URLs, and attachment reference filenames. Explicitly classify safe structural fields, redact human-readable text, and replace sensitive routing fields with opaque handles; do not recursively rewrite a serialized response without respecting types. Resolve handles at every agent tool input boundary before gateway validation, including refresh, list filters, search, read, attachment, reply and reaction. Retain the gateway's original account, membership and send-policy checks after resolution; a handle is not authorization. Use unpredictable, collision-resistant handles scoped to the running plugin, with bounded storage and explicit expiry/eviction errors; never persist or log the mapping unnecessarily. Accept existing raw identifiers on input only where needed for compatibility with direct mentions, but never echo them in results. Adapt the agent-facing account and media schemas so opaque handles pass validation before being resolved; keep gateway schemas and validation unchanged. Check that account-level aliases and references remain usable across tool calls and that invalid or stale handles cannot target another conversation. Redact a complete message before slicing it and define text offsets against the redacted message, so page boundaries cannot expose a partial identifier. Consider the same boundary problem when constructing search excerpts.

**Test scenarios:**
- Synthetic WhatsApp phone-shaped conversation ID, Gmail account address and filename containing a name are absent from list, search and read outputs, including nested reactions and quotes.
- List → read → view attachment and read → reply/react resolve returned handles to the exact original account, conversation, message and attachment; existing capability and send gates still apply.
- Separate accounts and conversations with similar identifiers never share handles or resolve to each other; forged, expired and evicted handles fail without leaking source IDs or sending.
- Agent search and read pagination work across long messages and an identifier crossing a page boundary; search excerpts do not disclose the matched identifier.
- Refresh, action results, gateway errors, metadata, URLs and local paths do not echo sensitive values. Redaction failure returns no raw response.
- Original image, PDF and text attachment contents are still returned as requested; the attachment exception is explicit and no claim is made that bytes are safe.

**Verification:** Integration tests exercise the registered tools through the fake plugin host and verify both sanitized outputs and the gateway's exact resolved inputs.

### U4. Document and verify the privacy boundary

**Goal:** Make the guarantee, exceptions and operational behavior clear.

**Requirements:** R2, R4, R5, R6.

**Dependencies:** U1, U2, U3.

**Files:** Modify `README.md`, `docs/operator.md`, `src/CONTEXT.md`; update `docs/_index.md` if required; test `tests/inbox-agent-tools.test.ts`, `tests/attention.test.ts`.

**Approach:** Document local-only best-effort redaction, handle lifetime, search and name limitations, fail-closed behavior, and the original-attachment exception. Update tool descriptions so agents are not misled about protected data. Follow repository build and live-deployment rules; a worktree is not the live plugin.

**Test scenarios:**
- Agent-facing tool descriptions explicitly state that attachment contents may contain PII.
- End-to-end synthetic fixtures show the UI-facing gateway still returns original data while Decisions and agent text outputs receive redacted data.
- A redaction failure at each outbound boundary produces a safe error and no unredacted fallback.

**Verification:** Focused tests and type checking pass; the operator can distinguish protected text from unprotected files and pre-existing provider exposure.

---

## Risks & Deferred Details

- OpenRedaction is best effort: standalone names, other languages, unusual formats and unrecognized identifiers can remain. An agreed evaluation corpus is needed before claiming particular coverage.
- Original attachment bytes remain an intentional PII leak path. Filenames are redacted in metadata, but the contents can include names and other identifiers.
- Opaque handle expiry may require an agent to list or read again. Decide exact bounds during implementation and document them; do not permit a stale handle to resolve to a different target.
- Redacted names and identifiers can make search, summaries and replies less useful. A search query or message already supplied by an agent may itself contain sensitive data upstream of this plugin.
- Stored attention scores were calculated from original requests before this change. This plan does not reclassify history or remove previously disclosed data.
- Opaque handles do not stop an agent from including sensitive information in its own request, search query or reply text. The downstream model may already have seen that input; the plugin can protect only the output it controls.
- Confirm the exact source of custom Decisions wording and ensure no logging or SDK error path echoes unredacted state. Full transport coverage outside this plugin is not established by this plan.

---

## Sources & References

- [OpenRedaction source and limitations](https://github.com/sam247/openredaction)
- `src/CONTEXT.md`, `src/attention.ts`, `src/inbox-agent-tools.ts`, `server.ts`
- `tests/attention.test.ts`, `tests/inbox-agent-tools.test.ts`
