# 0007 — Keep signed-contract consumers strict; narrow the producer

- **Type:** policy
- **Description:** Reject unknown fields in signed claims and fix the producer instead of silently weakening verification.
- **Status:** accepted
- **Date:** 2026-11-03
- **Deciders:** coordinating thread; decision recorded at its request
- **Supersedes:** nothing; complements [0005](0005-keep-sends-enabled-until-verified-approval.md) and [0006](0006-the-inbox-owns-the-pin-list.md)
- **Verified against the code:** 2026-11-03 — envelope key checks in `src/send-approval/verify.ts`, exact payload/assertion fields in `src/send-approval/canonical.ts`, and Home's legacy-response refusal in its `src/dispatch.ts`
- **Tags:** security, contracts, approval, verification

## Context

During mail-approval integration, extra producer fields caused two refused requests. Both fixes
narrowed the producer rather than loosening the inbox verifier. The coordinating thread reported
an end-to-end approved mail succeeding afterward, with the earlier refusal retained separately.

The [verifier](../src/send-approval/verify.ts) accepts exactly five envelope fields: `v`, `payload`,
`assertion`, `publicKey`, and `signature`. The [canonicalizer](../src/send-approval/canonical.ts)
also rejects unknown fields inside the signed payload and assertion. These checks keep the
[mail approval contract](../docs/mail-approval.md) explicit about what verification means.

Ignoring an extra diagnostic field would avoid one refusal, but would establish a contract that
silently means less than its producer appears to claim. Compatibility is not permission to make
that security boundary ambiguous.

## Decision

We keep signed-contract consumers strict: unknown fields cause refusal. Producers emit exactly
the agreed claim shape, put diagnostics in a separate channel, and pin that shape with a test
whose failure names the offending key. Reviewers first ask **what the producer added**, not
whether the consumer should become looser.

We reject silently ignoring or stripping unknown fields as a convenience fix. A real protocol
extension needs an explicit reviewed contract/version change, not a permissive verifier.
Home also treats a `legacy_mail_allow` response as a refusal, never as an approved-send result.

The owner chooses to retain the inbox panel's legacy `allow` path without an extra click or Home
handoff; mail Require mode remains off. `legacy_mail_allow` records an action whose origin and human
presence are unproven, not proof that a human was present. A verified envelope is intended as a
presence marker bound to the exact payload; today Home is the supported producer. Any future action
that needs provable user origin needs an equivalently trustworthy marker, not a caller-provided flag.
The signature proves possession of a pinned key over the exact payload, not by itself its hardware
custody, the signing program, a fresh gesture, or that the person saw the payload. Those claims
depend on trusted key enrollment and custody, a presence gate, and a trusted review-to-signing path.

The coordinating thread reports a cross-process test of the enrolled persistent key on macOS: a second
binary with the same signing identity, entitlements, profile and bundle ID, but no explicit presence
gate, prompted before signing both about four seconds and more than 120 seconds after a helper gesture.
The dialog named the requesting binary, not the key. This supports a presence check for those tested
signing attempts; it does not prove a fresh check for every possible use or every pinned key. An earlier
same-key test found that the key ACL can cache authentication within an application. The current helper
adds a fresh explicit presence gate per process and does not sign if that gate is cancelled.

Pinning identifies the key, **not the program**: another authorized binary could request a signature,
and the dialog name is the person's indication of which binary asked. The inbox cannot independently
verify the helper's presence check, identify that program from the signature, or establish what the
person reviewed. A pinned software key need not have a presence check at all.

## Consequences

A producer mistake costs a refused request and coordinated correction. That cost is intentional:
accepting an unexplained field would make verification claims unreliable. Producers and reviewers
must maintain exact-shape regression tests and keep diagnostics outside the envelope.

A legacy response is a protocol/authorization failure, not proof that no message went out; inspect
the audit before another attempt. Home must never turn it into an approved-send success or retry
through legacy consent. The existing inbox panel deliberately remains on legacy consent; Require mode stays off. The panel
is not represented as providing a presence marker, and the compatibility decision does not weaken
envelope verification.

This policy is reversible only through a new explicit contract decision. It does not supersede
the recorded compatibility window, change pin ownership, or claim that signatures prove hardware
backing or human presence.
