# 0002 — The draft's ceiling is the encoded message, not the raw bytes

- Status: accepted
- Date: 2026-11-03
- Supersedes: nothing. Amends the attachment limit introduced with the mail composer.

> **Current state (2026-11-03): still holds, checked against the code.** The encoded ceiling is
> `ATTACHMENT_ENCODED_LIMIT_BYTES = 25 * 1024 * 1024` and the count is `ATTACHMENT_LIMIT_COUNT = 20`,
> both in `src/inbox-session.ts` — the one file-bearing source is still the mail composer.

## Context

A draft may carry files. The first limit was 10 MB of raw bytes per draft, chosen as a round number
rather than measured against anything. Gmail's own limit is 25 MB for the message it receives, and a
message with an attachment is base64 in transit, which spends four bytes for every three. So a draft
of 18.75 MB of files arrives at Gmail as 25 MB, and a draft of 10 MB raw was refusing files the
service would have accepted — while the number the owner was told was a limit nobody enforced
downstream.

The failure that matters is the other direction: a draft the panel accepts, the gate approves, the
owner presses send, and Gmail rejects it after the fact with nothing to point at.

## Decision

`session.attach` measures what Gmail measures: the sum of `ceil(size / 3) * 4` over the draft's
files, plus the same encoding of the body, against 25 MB. The raw 10 MB cap is gone, because keeping
it would make the encoded rule unreachable — a check that can never fire is a check that lies about
what it protects.

The count limit (20 files) stays: it bounds the composer's own rendering, which is a different
concern from the transport's ceiling.

## Consequences

- A single file up to 18.75 MB is accepted where 10 MB was refused before. Nothing else about the
  draft changes: the same refusal shape (`false`, a sentence in `mailStatus`, nothing added).
- The refusal names 25 MB, the number Gmail enforces, so the sentence and the service agree.
- The body is part of the same message, so a long body leaves less room for files. This is now one
  rule rather than an attachment limit that quietly assumed an empty body.
- A page holding an 18.75 MB file also holds roughly 25 MB of base64 string. That is the cost of
  choosing an accurate limit over a comfortable one, and it is bounded by the ceiling itself.
- If a source with a different ceiling is added, the ceiling belongs beside that source's adapter —
  not folded into `attach`, which knows about Gmail only because mail is the only source with files.
