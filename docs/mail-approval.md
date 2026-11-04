---
status: current
date: 2026-11-03
description: "Mail approval RPC, rollout settings, pinning, refusal codes, and remaining panel integration limits."
---

# Mail approval contract

Gmail only: `personal` and `business`. Chat `action`, LinkedIn UI/replay and their existing consent/recording behavior are unchanged. No hardware origin or human presence is inferred from a signature or claimed in audit.

## Rollout and enrollment

Server settings are the only enforcement policy, read on each call:

| Setting | Values | Default |
| --- | --- | --- |
| `mailApprovalMode` | `prepare`, `compatibility`, `require` | `compatibility` |
| `mailApprovalKeyIds` | Full lowercase SHA-256 key ids, separated by whitespace or commas | Empty: no signing key authorized |

`prepare` keeps legacy sends enabled but verifies and refuses envelope delivery without spending.
`compatibility` accepts either explicit legacy `allow: "send"` or an enrolled-key envelope.
`require` refuses all legacy mail, including the current inbox panel. **A bad envelope NEVER falls back to `allow`; mixed envelope+allow is always refused.**

Pin only after deliberate review of the signer/enrollment policy. Example administration command:

```sh
bb plugin config unified-inbox set mailApprovalKeyIds '<full reviewed keyId>'
```

There is no RPC that writes pins, and no automatic Home enrollment/synchronization. Home must show the full enrolled key id, the setting name `mailApprovalKeyIds`, and “sends will be refused until this key is pinned in the inbox” when its requested key is not pinned or the list is empty. This statement describes envelope sends; legacy mail remains available during compatibility. A status read failure means readiness is unknown, not that the key is unpinned. Do not pin an arbitrary key merely because it signed a payload.

Transient keys change between helper launches. Every new transient key needs its own deliberate pin before dispatch; there is no automatic authorization of the next key. A stable enrolled issuer/key or a separately reviewed attestation policy is needed for a usable repeated-approval flow. The gate does not spawn helpers or cache their signatures/contexts.

## Home → inbox delivery call

Call plugin `unified-inbox`, method **`send_gmail`**, with this exact field set (the existing mail fields plus `draft` and `envelope`):

| Field | Meaning |
| --- | --- |
| `account`, `to`, `subject`, `text` | Required. Account is `personal` or `business`; exact header/body strings are bound. |
| `cc`, `bcc`, `threadId`, `inReplyTo`, `references` | Optional; omitted cc/bcc become empty strings, omitted threading fields become null in the payload. |
| `attachments` | Optional ordered array of `{name,mimeType,size,data}`. `data` is canonical padded base64 of the actual file; `size` must equal decoded byte length. Names, types, byte digests and order are bound. |
| `draft` | Required for envelopes: `{draftId,revision,sourceVersion}` from the reviewed Home draft. Revision is a positive integer. This is signed provenance, not an inbox lookup of the current Home draft. |
| `envelope` | The complete Home envelope object: `{v,payload,assertion,publicKey,signature}`; no other top-level fields are accepted. Home must use `transport: "gmail"`, `route: "send_gmail"`, and the matching account. |

Do not include `allow`, `resourceId`, `allowedKeyIds`, or a caller-selected mode with an envelope. Do not use `action:reply` as the signed mail route, even for a threaded Gmail reply. The copied shared vectors contain non-mail/other-route cases for conformance, not permission to dispatch those routes.

The inbox freezes the input before asynchronous policy reads, verifies signature/time and pin membership, then rebuilds the payload from the actual mail fields and decoded file bytes. It compares that hash with the signed commitment. A unique approval-id insert and the allowed audit row commit in **one `BEGIN IMMEDIATE` transaction before transport invocation**. Expiry is checked again after obtaining the write lock. Home must not spend first or keep a second authoritative spend ledger.

Successful envelope response: `{status, authorizationModel:"envelope_mail", approvalId, state:"accepted"}`. `accepted` means the Gmail adapter obtained provider acceptance, not that the recipient received/read it. A compatibility response includes `authorizationModel:"legacy_mail_allow"` and a deprecation `warning`; legacy sends do not use the new spend ledger. Home treats that response as a refusal, not an approved-send success; it does not establish that no message was delivered. See [the strict-consumer decision](../decisions/0007-reject-unknown-fields-in-signed-contracts.md).

## Errors and recovery

Expected mail errors reject the RPC. The BB error category is `forbidden`, or `conflict` for `already_spent`, `spend_commit_failed` and `delivery_uncertain`. The exact mail code is in `error.issues[0].message` with path `["envelope"]`, and the human message begins `[mail:<code>]`. Existing UI catches the error and preserves its draft. Input-schema violations use BB's **invalid_input** transport error and occur before the gate audit.

| Code | Meaning / action |
| --- | --- |
| `mixed_authorization`, `approval_required`, `envelope_delivery_disabled` | Select one protocol, acquire an approval, or complete the rollout. No new spend or dispatch. |
| `unknown_key` | Key is not in inbox pins; empty pins reject all keys. No spend or dispatch. |
| `missing_field`, `unsupported_version`, `invalid_assertion`, `payload_mismatch`, `bad_signature`, `expired`, `invalid_mail` | Refused before spending. Fix/review the draft or acquire a valid assertion; never retry via legacy. |
| `send_disabled`, `configuration_error`, `spend_unavailable`, `spend_commit_failed` | Gate/source/storage not ready. No dispatch. Inspect status and configuration; do not assume a failed storage response proves an id is reusable. |
| `already_spent` | Approval id has already committed. No second dispatch; read its durable status. |
| `delivery_uncertain` | Spend committed, but transport or outcome persistence failed. **Never automatically retry or refund the approval.** Inspect Gmail and durable status before any new owner-approved attempt. |

Audit stores approval id, payload/assertion hashes, key id, decision and authorization model, never message bodies or file bytes. Audit `assertionTrust` explicitly labels presented-but-unverified claims as `unverified`, and successfully verified signatures as `signature_verified`. Neither label claims hardware backing or human presence. Refused rows may retain presented assertion claims; that does not make those claims trusted. Legacy mail is explicitly marked even though its old gate mints a UUID. The existing warning-only check includes these legacy markers as well as allowed rows with missing approval ids.

## Read-only readiness and spend state

- **`mail_approval_policy`**, input `null`: `{mode,allowedKeyIds}` from current server settings.
- **`mail_approval_status`**, input `{approvalId?,keyId?}` (or `{}`): returns the fields below. No pin write or send occurs.

| Field | Semantics |
| --- | --- |
| `mode`, `pinnedKeyCount` | Current policy on this call. |
| `keyPinned` | Current membership for the requested full `keyId`; null if none was requested. |
| `legacyAllowed`, `envelopeDeliveryEnabled` | Current mode permits legacy; current mode/pins/ledger permit the envelope path. This is not approval of an arbitrary payload or proof of helper availability. Use `keyPinned` for the particular held key. |
| `lastRefusalCode`, `lastRefusalAt`, `lastRefusalAccount`, `lastRefusalWasKeyMismatch` | Historical latest mail-envelope refusal, persisted in the audit and surviving reload. Global across both Gmail accounts; successes and pin changes do not clear it. It can be stale while current readiness is good. |
| `lastRefusalScope` | Always `"mail_global"`; not chat/LinkedIn and not filtered by the requested approval id. |
| `spend` | Null when no matching spend exists or no id was requested. Otherwise `{approvalId,payloadHash,keyId,account,state,spentAt}`. |

Spend states are `spent` (committed, no recorded outcome yet), `accepted` (provider accepted), or `uncertain`. **Every state is non-reusable.** A crash after commit may leave `spent` forever; treat it as an unknown outcome, not permission to resend. No background retry runs.

## What is not yet integrated

The owner chose to keep the existing inbox composer on legacy `allow`, without an extra click or a Home handoff; mail Require mode stays off. The `legacy_mail_allow` label means the action's origin and human presence are unproven, not that a human was present. Today Home is the supported producer of the intended user-presence marker. A signature proves a pinned key signed the exact payload; proof of a fresh human gesture and meaningful review additionally depends on trusted key custody, the helper's presence gate, and a trusted review-to-signing path. An action requiring provable user origin needs that trusted marker, not a caller flag. The backend does not invent a revision, sign a draft, or claim that a key-id pin proves hardware backing/presence. Home must send actual attachment bytes in the call, not just signed digests. The canonicalizer's intentionally restricted email parser may refuse headers accepted by nodemailer (such as RFC 5322 comments); review such a draft rather than silently normalizing it.

`src/send-approval/canonical.ts` is copied from Home and tested against the frozen shared vectors in `tests/fixtures/send-approval-vectors.json`. Its only local typing adjustment is a function declaration for the never-returning failure helper; encoding is unchanged. The verifier is adapted to require an allowlist even when empty. The inbox owns its SQLite ledger rather than calling Home's spend store.

The standalone gate tests use generated fixture keys deliberately enrolled in test policy and fake provider transport. No real helper or message send is required to test or deploy this contract. Signature/key custody and the one-context/one-process presence chain remain the authority's responsibility.

## Post-deploy validation

For this compatibility release, the inbox owner checks `mail_approval_status` after reload and again during Home's read-only readiness capture: mode must be `compatibility`, pin count zero, requested `keyPinned` false, legacy allowed and envelope delivery disabled. No send is needed. Inspect the existing check output for legacy-mail row counts or `audit NOT CHECKED`; after the schema migration the latter must not occur for a reachable local database. A wrong mode/pin list or failed status schema blocks Home readiness verification. Do not enable Require or add a test key as a deployment smoke test. Investigate `delivery_uncertain` using spend state and Gmail before any new explicit approval; never roll back to a bypass-capable backend after enforcement.
