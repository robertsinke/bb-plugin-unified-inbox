# 0004 — A LinkedIn write is recorded, not approved

- Status: accepted
- Date: 2026-11-02
- Amends: the single-entry-point claim in `src/adapters/policy.ts`. OQ-1 still owns the token.

## Context

`createSendGate` is the one gate every send goes through, and its promise is exact: the row is
written to `inbox_send_audit` **before** delivery, so "refused" means the adapter was never
reached and "allowed" means something really went out. A panel reply holds that promise. Two
LinkedIn RPCs did not:

- `linkedin_replay` replays a recorded page request. A message send is one of them.
- `linkedin_ui` drives the page, and one click is LinkedIn's own Send button.

Neither minted an approval, so neither wrote a row. An agent-driven LinkedIn send left no trace
while the same send from the panel left one — the single place where the strongest promise in this
repo was fiction.

The obvious patch — mint an approval for a replay — was rejected. An approval in
`inbox_send_audit` means *the owner approved this exact action*. A replay is authorised by
something else: the page has already named the target (recipient chips, or the thread key in its
own URL) and the caller says `confirm: true` / `allow: 'send'` in the same request. Writing an
approval id for that would make the log claim a decision nobody made, and would put a row in the
spend accounting that no approval ever backed.

## Decision

The gate has two entry points, and the difference between them is the whole note:

- `sendGate(request, approval, deliver)` — the approving path. Unchanged: policy check, the
  5-minute window, one-use spend through `hasSpent`, the refusal row, the row before delivery.
- `sendGate.observe(request, deliver)` — the recording path. It writes one row with
  `decision: 'allowed'`, **no `approvalId`**, and a `reason` that names the authorisation model in
  words a person can read, then calls `deliver`. It performs no policy check, no window and no
  spend lookup: it cannot approve, and it cannot use an approval up. The row is written before
  delivery for the same reason the approving path writes one — a delivery that throws must still
  leave the record.

`approvalId: null` is the honest marker for *delivered, never approved*. Anyone reading the log
can tell a replay from a panel send without a second table.

`linkedin_replay` records only when the write is a message send (`isMessageSend`); a read mark is
the other write it accepts, and it delivers no message, so it leaves no row. The `linkedin_ui`
click records only when the step can deliver: `op: 'click'`, `allow: 'send'`, LinkedIn's own send
control, and a target the step declares. That is the same rule the page driver applies before it
clicks, exported as `sendClickRecord` in `src/linkedin-ui.ts` so the transport and the driver
cannot drift. Open, navigate, snapshot, describe, type and press steps never had a row to leave.

## Consequences

- An agent-driven LinkedIn send now appears in `bb unified-inbox send-audit` and in
  `inbox_send_audit`, before delivery, exactly like a panel send — with no approval id, which is
  what happened.
- A click the page driver then refuses still leaves an `allowed` row: the row is written before
  the click, so a target mismatch is recorded as a delivery the page did not confirm. The existing
  approving path has the same shape for a delivery that throws. This is the price of writing the
  row before the act rather than after it.
- A `linkedin_ui` send click records the step's declared target. An in-thread reply carries a
  thread key; a compose click carries the recipient's name, because that is the only target the
  step names. The conversation column therefore holds "who" for one shape and "which" for the
  other.
- Nothing else about the gate moved. Refusals, the window, spend, and row-before-delivery are
  unchanged and pinned by their existing tests.

## Still open

- **OQ-1**: a host-issued approval token per send. When it lands, `approvalFor` is replaced and
  the approving path is unchanged; `observe` should then carry the page's own confirmation as a
  token too, rather than a caller's word, and this note should be superseded.
- `linkedin_ui` steps are classified by the same name rule the driver uses. When a step can say
  more about itself — the recipient chips it read, the thread key in the URL — the row should
  carry that instead of the recipient name.
- Invitation answers (`accept`, `ignore`) are irreversible account changes that `linkedin_replay`
  never sees and `linkedin_ui` never records. They are outside this note; recording them would
  need an operation that is not `send`.
