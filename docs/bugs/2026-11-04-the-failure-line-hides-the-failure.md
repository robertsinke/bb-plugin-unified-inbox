---
title: "Bug report — the failure line hides the failure, and names the source twice"
status: fixed
date: 2026-11-04
---

# Bug report — the failure line hides the failure, and names the source twice

**Filed:** 2026-11-04 · **Owner:** this plugin · **Status:** reproduced, measured, three changes made

## Symptom

The panel showed, occasionally and together:

```
Inhouse Gmail Inhouse Gmail unavailable. Check its connection. Previously loaded messages may be stale.
LinkedIn LinkedIn did not answer in time. Previously loaded messages may be stale.
```

Two complaints in one line. The source is named twice, and the Gmail half names no failure at all: it
is the gateway's fallback sentence, which means whatever the CLI actually said was thrown away.

## What was measured

Both lines are the cache's, not the panel's: `inbox_freshness.last_error` holds the sentence, and
`errorLine` prepends the source label to it (`src/inbox-errors.tsx`). The stored Gmail sentence is the
gateway's fallback, so the real message failed this test (`src/gateway.ts`):

```
DESCRIBED_FAILURE = /… (?:gmail|whatsapp|imsg|linkedin) \w+ request failed \(/
```

The provider-error factory writes `<source> <account> request failed (<code>)`, and a Gmail account
key is `gmail-personal` / `gmail-business`. `\w+` cannot span the hyphen, so **every** Gmail failure —
timeouts, 403s, keychain errors — was replaced by "unavailable. Check its connection.". The unit test
that covered this fallback used `'Gmail thread list request failed (403).'`, a shape the factory no
longer produces.

The LinkedIn half is real and correctly worded: `evaluate` gives up after `LIST_READ_TIMEOUT`. What
that cap has to clear was measured against the live profile, with the stored marker made stale so the
next sync took the full path instead of the probe:

| read | wall time | rows |
|---|---|---|
| probe only (`reason: skip`) | 1.78 s | 0 read |
| full list read (`reason: read`) | 4.16 s | 21 |

4.16 s against a 10 s cap is 2.4× headroom: a read a little slower than this machine's failed, and one
failed read costs the whole source until its next poll — and doubles that poll's delay
(`runInboxRefresh`, which grew to an hour), while the LinkedIn browser idle-stops at 90 s, so the
retry was a cold page. The tightest cap in the system sat on the path most likely to run cold.

For Gmail the same measurement says the transport is healthy (`gws gmail users getProfile` 0.51 s,
`sync` 1.58 s, `token_cache.json` rewritten that day), so the cause of that failure is not a slow
read. It is not yet known, because the line that would have said so was the one being overwritten.
The keyring is the leading candidate: `gws` reports `Using keyring backend: keyring` and decrypts
`credentials.enc` on every call, so a locked login keychain fails the source until it is unlocked.
That stays a hypothesis until a failure is recorded with its code.

## What was changed

| change | file |
|---|---|
| the account token is `\S+`, so a hyphenated key matches and the reason survives | `src/gateway.ts` |
| the label goes in once: a stored sentence that already opens with it is not prefixed again | `src/inbox-errors.tsx` |
| `LIST_READ_TIMEOUT` 10 s → 20 s, with the measurement above beside it | `src/linkedin-chrome.ts` |
| the retry delay is capped at four poll intervals instead of an hour, so a source that recovers is retried within minutes | `src/inbox-refresh.ts` |

Two tests hold the first two: the provider shape for `gmail-business` reaches `lastError` unchanged,
and the two cached sentences above render once through `errorLine`. A third holds the backoff ceiling.

## What this does not fix

- The Gmail failure itself. The next occurrence now stores its code (`ETIMEDOUT`, `keychain`, `403`,
  …), which is what decides the fix. Nothing retries a failed CLI call today, so a one-off stall still
  costs one poll interval.
- A timed-out `Runtime.evaluate` is not cancelled: the page keeps running the read while the gate has
  moved on, so a second poll can start on top of it. With more headroom this should be rare; cancelling
  an in-page evaluation is not a thing CDP does safely (`Runtime.terminateExecution` aborts the tab's
  own scripts too).
