---
status: accepted
---

# 0005 — Keep sends enabled until a verified approval authority lands

- **Type:** policy
- **Description:** Keep existing owner-facing sends available, remove agent self-approval recipes, and leave enforcement gaps explicit until the isolated authority replaces caller assertions.
- **Status:** accepted
- **Date:** 2026-11-03
- **Deciders:** Robert, through the explicit choice “Keep sends; ship draft-first mentions”
- **Supersedes:** nothing; extends [0004](0004-linkedin-writes-are-recorded-not-approved.md)
- **Verified against the code:** 2026-11-03 — gateway registration, send gate, mention instructions, audit storage, and project automations checked; a harmless CLI call reached the LinkedIn UI handler without sending
- **Tags:** security, sending, approval, agents

## Context

The panel and agents reach the same [RPC handlers](../src/gateway.ts), registered in
[server.ts](../server.ts). There is no verified human caller identity at this boundary.
The plugin cannot accept a panel send while reliably rejecting the same request from an agent.
A harmless agent-side `linkedin_ui` describe request, with its control omitted, reached the
handler and returned its validation error; no browser action or message send was needed to prove reachability.

[Decision 0004](0004-linkedin-writes-are-recorded-not-approved.md) deliberately records LinkedIn
send clicks and message replays through `gate.observe`, without a minted approval.
The normal [send gate](../src/adapters/policy.ts) is not a human-approval authority either:
`approvalFor` creates a fresh UUID from the caller's `allow` flag on each request. Its single-use
check cannot prevent a second request from obtaining another approval. Gmail's approval names
only the thread or recipient string, not the complete recipients, subject, body or attachments.

The old [mention footer](../src/inbox-mention.ts) taught agents to construct that flag and call
send RPCs. Removing those instructions reduces accidental sends, but cannot prevent a caller
that already knows the RPC surface from sending. Disabling every send would close these plugin
routes immediately, but would also disable the owner's current panel and CLI sends.

## Decision

We keep existing owner-facing sends enabled and ship draft-first agent mention instructions.
Mentions identify conversation content as untrusted, ask for a draft for owner review, and state
that caller-supplied flags are not proof of owner approval. They contain no executable send or
self-approval recipe. Enforcement gaps remain open: **#1**, approval-free LinkedIn message clicks
and replays; **#3**, approvals minted afresh from caller assertions; and **#4**, incomplete Gmail
payload binding. This is an explicit temporary acceptance of risk, not an authorization fix.

We reject disabling all sends for now because the owner chose to retain that functionality.
We also reject minting `approvalFor` inside `observe` or replay: it would make the audit log claim
an approval decision nobody made, without adding a trusted authority or preventing another send.
Draft-first wording is guidance, not a substitute for enforcement.

The intended closure is the
[isolated send-approval authority implementation spec](/Users/robert/.bb/plugins/environment-personal-workspace/host-data/workspaces/thr_xxvwzzmuep/specs/001-send-approval-authority/spec.md).
It must bind approval to the exact reviewed payload, verify its issuer, and durably spend it
before dispatch. A spec or an unused verifier alone does not close these gaps: every applicable
message delivery route, including LinkedIn click/replay, must enforce the replacement authority.
The link names an external workspace document; it is not bundled with this repository.

## Consequences

Existing panel and explicitly requested sends keep working. Agents receive conversation context
without instructions to self-approve and send. The audit continues to distinguish observed
LinkedIn sends from requests carrying a locally minted approval id.

An agent can still drive a real send, recorded but without verified human approval. An approval
id minted from a caller flag does not prove human consent either. These changes do not contain a
same-user process with direct provider access, and do not establish at-most-once delivery.
Disabling these routes later is reversible; a message already delivered is not.

[`npm run check`](../package.json) now runs a
[read-only audit warning](../_tools/check-send-audit.ts): one query reports `allowed` rows with a
null, empty or whitespace-only approval id in the last **seven days**, with counts per account and
audit row ids. History never fails the build. If BB or its local plugin database is unavailable,
the check warns **NOT CHECKED**, rather than reporting a clean audit or creating a database.
The existing weekly check automation picks this up; no new automation, scheduler or panel is added.

This is a warning in check output, **not a push alert or a security boundary**. Someone must read
and investigate it. It does not detect a send carrying a caller-minted approval id, so it cannot
certify human approval or close gaps #1/#3/#4. An `allowed` row is written before dispatch: it proves
an attempt, not successful delivery or owner intent. Alerts must not claim confirmed delivery.
Rows outside the seven-day window are not examined by this detector; the full audit remains
available through the panel, CLI and RPC.

### Reversal conditions

Revisit and replace this decision when any of these occurs:

- The isolated authority is integrated into the live send paths; retire caller-asserted authorization rather than keeping an alternate bypass.
- Any real unapproved send is discovered through `inbox_send_audit`; an `allowed` row without an approval id is an investigation trigger, and confirmed unapproved delivery requires reconsidering continued sending immediately.
- BB gains a verified human principal that can actually distinguish the owner's authorization from an agent-controlled call.

Record the replacement in a new ADR and link it back here. Do not rewrite this acceptance of risk
as though the current system enforced human approval.
