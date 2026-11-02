# Bug report — the plugin handler counter cannot tell a contract break from a timeout

**Filed:** 2026-11-03 · **Owner:** BB host (not this plugin) · **Status:** evidence + proposed fix, no workaround added here

## Symptom

`bb plugin list` reports one aggregate line per plugin:

```
handlers: 6933 calls / 22517182.3s total / 161.9s max, 44 errors
```

`handlerStats` carries `count`, `errorCount`, `maxMs`, … and nothing else. During a working session on
this plugin the counter moved **31 → 44 errors in about an hour**, while nothing failed visibly: the
plugin answered every call I made, and the panel showed no error. I could not say which 13 calls
failed, when, which method they were, or whether they threw or were abandoned.

`maxMs` is **161 930 ms** — one handler ran for 2 min 42 s. The counter does not say which handler, at
what time, or whether anything enforced a deadline on it. A 2.7-minute RPC from a panel is a frozen UI;
if a deadline exists it did not bound that call.

## Why this is worth fixing

The counter is the only signal an operator has that a plugin is misbehaving, and it answers a question
nobody asks ("how many errors, ever?") instead of the one they do ("what is failing now, and is it the
same thing I fixed?").

Concretely, this is how a real break hides: an earlier schema bug in this plugin produced **273
consecutive handler failures** — found only because someone thought to compare the counter against a
`bb plugin rpc` call that returned an error. A single contract break, a timeout caused by a slow
upstream, and a client that hung up mid-call all count as `1` on the same dial.

## What it should expose

Smallest useful change, keeping the same one-line summary:

1. **Split the count by cause**: `thrown` (the handler raised), `timedOut` (the host gave up),
   `abandoned` (the caller went away). One number cannot mean three fates.
2. **Name the last error**: method, ISO timestamp, and a truncated, redacted message — the same
   discipline plugins are held to. A secret must not reach this line; a method name and an error code
   must.
3. **Attribute `maxMs` to a method**, and mark whether it exceeded a deadline. "161.9s max" is a number;
   "`send_gmail` took 161.9s and the deadline is 30s" is a bug report.
4. If a deadline exists, say what it is in the summary line, so an operator can tell a slow call from an
   unbounded one.
5. Optional but cheap: keep the last N errors per method, not per plugin. Twelve errors on one method
   is a different event from twelve errors across twelve methods, and today they are indistinguishable.

## How to read it today, and what it hides

```
bb plugin list | grep -A 3 unified-inbox
```

- `calls` and `total`/`calls` give a mean latency — 3.2 s here, which is dominated by handlers that
  legitimately wait on Gmail's API or a LinkedIn page.
- `max` is the only tail signal, and it is unattributed.
- `errors` is unattributed and unclassified, so it can be neither trusted nor dismissed.

Measured across this session (same plugin, same machine): the summary moved from
`5653 calls / 161.9s max / 31 errors` to `6933 calls / 161.9s max / 44 errors` with no user-visible
failure. Whatever those 13 were, they are now invisible history.

## Proposed shape of the line

```
handlers: 6933 calls, 3.2s mean / 161.9s max (send_gmail, over the 30s deadline), 44 errors — 41 thrown, 3 timed out; last: linkedin_ui 2026-11-03T14:02:11Z E_TIMEOUT
```

Everything an operator needs to decide whether to open the logs, without opening the logs.
