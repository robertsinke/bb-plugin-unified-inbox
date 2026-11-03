---
title: A full recorder buffer read back as empty
date: 2026-11-02
category: logic-errors
module: LinkedIn write path (unified-inbox plugin)
problem_type: logic_error
component: tooling
symptoms:
  - "linkedin_record dump always answered 0 writes while the page's own counters said the wrappers were being called"
  - "three real sends left the recorder apparently empty, so no replay template could be built"
  - "the recipient-chip guard read no chips although a Remove-chip was on screen"
  - "a probe request the page had accepted (pushed 1, stored 1) still dumped as nothing"
root_cause: logic_error
resolution_type: code_fix
severity: high
tags: [linkedin, cdp, page-expressions, recorder, shape-assertions]
status: settled
---

# A full recorder buffer read back as empty

## Problem

The LinkedIn write recorder — a `fetch`/XHR wrapper installed in the plugin's own page that stores
same-origin `/voyager/api/` POSTs — was capturing requests correctly, but every dump answered
`writes: []`. Because the read-out dropped everything, real sends looked unrecorded, no replay
template could be built, and a guard that read the page saw nothing where the page had plenty.

## Symptoms

- `linkedin_record {op: "dump"}` returned `writes: []` after actions that certainly wrote.
- The `seen` counters (fetch/xhr/considered/skipped) grew, proving the wrappers ran — so the loss
  was invisible: "nothing recorded" and "recorded but lost" printed identically.
- The send guard reported the compose box was addressed to nobody while a `Remove <name>` chip was
  visibly present.
- A deliberate no-op probe (`pushed: 1, stored: 1`, a 404 answered by LinkedIn) still dumped empty —
  the decisive observation that capture worked and read-out lost it.

## What Didn't Work

- **Wrapping `fetch` after page load**: LinkedIn's app captures `fetch` at boot, so a later wrapper
  is never called. Added an XHR wrapper too, then a pre-boot install via
  `Page.addScriptToEvaluateOnNewDocument` + reload — the wrappers now ran (the counters proved
  it), yet the dump stayed empty. Each step fixed a real gap and none was the bug.
- **Counting only at the entry**: `seen.fetch/xhr/considered/skipped` told us calls arrived and which
  filters rejected them — but "considered, not skipped, not stored" still had two explanations left
  (store failed vs. read-out lost).
- **Trusting the test harness**: the adapter test stub answered `{ writes: [] }` by hand, which
  encoded the *fixed* shape the page never had. The test passed against the bug because the stub
  and the caller agreed with each other, not with the page.
- **Writing page-regex escapes as source**: `\s` inside a TypeScript template literal reaches the
  page as `s`, turning `/^remove\s+(.+)$/` into `/^removes+(.+)$/` — the chip reader found nothing.
  The same trap had already hit the probe envelope: a page read that skips `linkedinReadResult`
  parses as an empty inbox (auto memory). Shape bugs read as emptiness, never as errors.

## Solution

Three changes, each making one silent failure loud:

1. **Every page expression answers an object; both sides assert the shape.**
   `recordedWritesExpression()` returns `{ writes: [...] }` and the adapter reads that field. A
   test asserts the emitted source contains `return { writes: list.slice()` — because "the value is
   right" cannot show "the envelope is wrong".

   ```ts
   // page: answers an object, never a bare array
   return { writes: list.slice().reverse().map(/* ... */) };
   // adapter: reads the field the page names
   const dumped = await deps.runLinkedInWrite(recordedWritesExpression()) as { writes?: unknown };
   ```

2. **Patterns for the page are written escaped and asserted.** `/^remove\\s+(.+)$/` in the template
   literal, with a test that the emitted source still carries the backslash — a lone `\s` is eaten
   silently, so only the emitted bytes can be trusted.

3. **Counters on both sides of the push.** `pushed`, `stored`, `last`, `same` beside `skipped`:

   ```ts
   seen.pushed = (seen.pushed || 0) + 1;
   seen.last = method + ' ' + path;
   list.push({ method, url: path, body, capturedAt: Date.now() });
   seen.stored = list.length;
   ```

   Now "never called", "filtered out", "store failed", and "lost on the way out" are four different
   answers instead of one `writes: []`.

With these in place, the same build and the same page: probe → `pushed 1, stored 1` → dump →
`1 write`. The captured mark-read and send requests became the templates the adapter replays today.

## Why This Works

The failure lived at a seam: two sides agreeing on nothing but a bare value. The page returned an
array; the adapter read `.writes` off it; `undefined` rendered as `[]`, and every layer reported
that as "no writes". Making the envelope explicit, asserting the emitted source, and instrumenting
both sides of the buffer turns each silent drop into an observable, distinct answer — the same
principle as the envelope rule for page reads: shape mismatches never surface as errors, so the
shapes must be pinned by tests.

## Prevention

- **Generate test stubs from the same builders the code uses** (the harness detects expressions by
  comparing against `writeRecorderExpression()` et al.). A hand-written stub can encode a shape the
  page never had, and the test suite will green-light the bug.
- **Assert the emitted page source, not just the returned value**, for anything containing escapes
  or envelopes; template literals eat lone backslashes silently.
- **Instrument both sides of any buffer** whose emptiness is load-bearing: a counter after the
  filters says what arrived; a counter after the push says what was kept; the difference between
  them is exactly where the loss can hide.
- **Prove builders against captured bytes**: the send and mark-read builders are asserted to
  reproduce the recorded requests byte for byte (including LinkedIn's percent-encoding of
  parentheses), so code and observation cannot drift apart.

## Related Issues

- `docs/research/linkedin/writes.md` — the captured request shapes, the capture procedure, and the
  live proofs this learning produced; the plugin's LinkedIn reply and read-mark are built from them.
- `docs/plans/2026-11-02-next-slices.md` (slice D) — the observe-then-replay mechanism this
  recorder serves, and what remains uncaptured (invitation accept/ignore).
- Same family, same session: the probe envelope bug (a page read skipping `linkedinReadResult`
  parsed as an empty inbox and made the delta check silently skip) — both bugs are "a shape
  mismatch reads as nothing".
