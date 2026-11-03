# 0006 — The inbox owns the pin list; Home displays and instructs, never writes pins

- **Type:** architecture decision
- **Description:** The inbox's `mailApprovalKeyIds` is the only enforcement list for send approval; no RPC may write it, and Home shows the enrolled key and the instruction instead of offering a pin action.
- **Status:** accepted
- **Date:** 2026-11-03
- **Deciders:** Robert (owner), and the inbox owner, who refused a public apply-pin RPC
- **Supersedes:** nothing; extends [0005](0005-keep-sends-enabled-until-verified-approval.md)
- **Verified against the code:** 2026-11-03 — `createMailGate` verifies with `verifyApproval({ allowedKeyIds: policy.allowedKeyIds })`; `mail_approval_status` is published (`src/rpc-contract.ts`); `lastMailRefusal` is a SQL read over `inbox_send_audit`; no RPC writes a pin.
- **Tags:** security, sending, approval, pinning, home

## Context

The approval boundary has two key lists, and only one of them can enforce anything.

- **The inbox's list** — `mailApprovalKeyIds`, set by hand in inbox settings, read by
  `createMailGate` and passed to `verifyApproval({ allowedKeyIds })`. An envelope from any other key is
  refused `unknown_key`, before the spend and before delivery.
- **Home's list** — `approval_keys` in Home's own database, written by `send_enroll_key` when the owner
  pins the key that signed the envelope they are looking at. It is real, tested and useful, **but it
  enforces nothing**: Home verifies and stops (`send_verify`), and the inbox never reads Home's database.

That asymmetry is a trap. An owner who enrolls in Home sees "key enrolled", tries to send, and gets
`unknown_key` from the inbox until the same key is typed into settings. Two lists, one owner, no link
between them — the failure looks like the approval system is broken rather than unpinned.

The obvious convenience fix is the wrong one. A public `apply_pin`/`pin` RPC would let **any** caller pin
its own key: with no verified human principal at the RPC boundary (the premise of
[0005](0005-keep-sends-enabled-until-verified-approval.md), still true), a process that generates a
software P-256 key can pin it and then self-sign. That erases the `unknown_key` boundary the pinning
exists to create — the pin list would only prove "somebody asked twice". The inbox owner refused that
RPC for exactly this reason, and the refusal is correct.

At the time of this decision the inbox has published the shape Home needs,
`mail_approval_status` → `mode`, `pinnedKeyCount`, `keyPinned` (nullable), `legacyAllowed`,
`envelopeDeliveryEnabled`, `lastRefusalCode`, `lastRefusalAt`, `lastRefusalWasKeyMismatch`, and `spend`.
Two semantics decide what Home may claim about it, and both are answerable from the implementation:

- **Does the last refusal survive a plugin reload?** Yes — `lastMailRefusal()` is
  `SELECT reason, at FROM inbox_send_audit WHERE decision = 'refused' AND authorization_model = 'envelope_mail' ORDER BY id DESC LIMIT 1`.
  It is durable, so a refusal from yesterday is still "the last refusal".
- **Is it per-account or global?** Global. There is no account predicate in that query, so the field
  describes the last mail refusal anywhere, not the draft being looked at.

## Decision

**The inbox is the sole enforcement list for send approval, and nothing outside it writes a pin.**

- `mailApprovalKeyIds` continues to be set by hand in inbox settings. No RPC writes it — not from Home,
  not from the panel, not from an agent.
- **Home never writes pins.** It shows the **full** enrolled `keyId` (not a 12-character prefix, which
  cannot be compared or pasted) with a copy affordance, names the setting to change, and states plainly
  that *sends will be refused until this key is pinned in the inbox* whenever `pinnedKeyCount` is 0 or
  `keyPinned` is false for the key Home is holding.
- Home renders the readiness fields from `mail_approval_status` only: `mode`, `pinnedKeyCount`,
  `legacyAllowed`, `envelopeDeliveryEnabled`, `keyPinned` for the held key, and the last refusal as
  **history with its timestamp** — never as "current", because the field is global and durable.
- Home performs no inbox database reads and adds no polling beyond the helper probe it already runs; the
  status arrives over the existing RPC surface.

Rejected alternatives:

- **A Home apply-pin RPC** (or an inbox one): self-pin, and with no verified human principal the pin
  proves only that a caller asked. This is the option the inbox owner refused.
- **Home writing the settings value directly** (its own RPC, or editing settings storage): the same hole
  through a different door, and it makes two writers of an enforcement list.
- **Treating Home's `approval_keys` as the enforcement list**, e.g. having the inbox read it: a second
  authority, cross-plugin storage coupling, and a much larger blast radius for a compromised Home.

## Consequences

**What gets easier.** One list decides; one failure has one cause and one instruction. A software key
cannot pin itself, so `unknown_key` keeps meaning what it says. The owner reads "pin this key in the
inbox" instead of discovering a second, invisible list by failing a send.

**What gets harder.** The pin is a **manual step** in another application, and forgetting it is now the
most likely reason a correct approval is refused. Home can only instruct; the copy is load-bearing, and a
vague sentence here is the difference between a two-minute fix and another debugging session.

**New obligations.** Home must keep showing the *full* key id and the exact setting name. The
`lastRefusal*` fields must stay labelled as history: they are durable and global, so presenting them as
"the current state of this draft" would be a lie that survives restarts. If the inbox ever changes either
semantic (per-account, or in-memory), Home's copy must change with it — the shape's meaning is part of the
contract, not a detail.

**What this forecloses.** No "pin from the UI" convenience, ever, while there is no verified human
principal. If BB ships one (the open question in the send-approval spec), a pin action becomes safe and
this decision is the thing to revisit — it will be superseded, not quietly edited.

**Neutral.** Home's `approval_keys` table stays: a local record of what the owner enrolled, shown in
Home, useful for the approval view and its tests. It is explicitly *not* the enforcement list, and both
surfaces should say so.

### Reversal conditions

Reopen this decision if either becomes true:

1. BB exposes a **verified human principal** to plugins, making a pin action attributable to a person
   rather than to a caller. Then a pin RPC can be reconsidered (and the same adversarial tests applied:
   can an agent forge or replay it?).
2. The inbox publishes a **signed pin action** performed by the owner — for example a pin that carries
   the same presence evidence as an approval. That would keep one writer while removing the manual step.
