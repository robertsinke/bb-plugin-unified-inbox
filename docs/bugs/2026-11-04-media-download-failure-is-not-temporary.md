---
title: "Bug report — a permanent media failure is reported as a temporary one"
status: open
date: 2026-11-04
---

# Bug report — a permanent media failure is reported as a temporary one

**Filed:** 2026-11-04 · **Owner:** WhatsAgent (the provider), with one wording change here · **Status:** measured, cause named, wording fixed here, classification fix proposed upstream

## Symptom

The plugin's log carried 26 `rpc media failed: WhatsAgent rejected the request` entries between
2026-10-31 and 2026-11-03, and the panel showed
`WhatsAgent: media download temporarily failed.` for the same clicks. "Temporarily" invites the user
to click again, and they did: nine attempts in seven minutes on 2026-11-02 (13:06–13:13), fourteen
across that afternoon, each one a fresh request to the backend that failed the same way.

## What was measured

The backend keeps every media verdict in `messages.media_state` / `media_error`
(`~/Library/Application Support/whatsagent-desktop/whatsagent.db`):

| state | reason | count | message dates |
|---|---|---|---|
| `ready` | — | 115 | 2026-07-08 … 2026-11-03 |
| `failed` | `transient` | 61 | 2025-12-05 … 2026-10-16 |
| `failed` | `unavailable` | 3 | 2026-10-02 … 2026-10-16 |
| `placeholder` | — | 546 | never requested |

Retry does not help. Four `load-media` calls per id, 2 s apart, on three ids that had already failed:

```
1442384170179176-1   502 -> 502 -> 502 -> 502
2348265695618706-1   502 -> 502 -> 502 -> 502
1791374935103792-1   502 -> 502 -> 502 -> 502
```

The boundary is the age of the media, not the backend's health. Six messages that had never been
downloaded, chosen across age, one call each:

| message date | result |
|---|---|
| 2026-11-04 | ok |
| 2026-11-02 | ok |
| 2026-10-28 | ok |
| 2026-10-26 | ok |
| 2020-08-29 | `502 transient` |
| 2019-01-29 | `502 transient` |

The media directory agrees: 10 files were written **today**, so downloads work. Nothing in this
plugin is broken; the answer it repeats is.

## Root cause

WhatsApp serves media through URLs that expire. WhatsAgent classifies a download failure by the
Baileys status alone (`server/channels/whatsapp/media.ts`, `classifyMediaFailure`): `404`/`410` mean
the bytes are gone, **everything else is `transient`** — and an expired fetch comes back as something
else (412 decryption, 418 general, or a CDN 5xx). So an expired file is stored as
`failed/transient` and is retried forever.

This plugin then maps that status to words: `502` → `WhatsAgent: media download temporarily failed.`
The mapping is faithful to what the provider said, and wrong about what the user should do.

## What was changed here

`src/adapters/whatsagent.ts` now answers `502` with
`WhatsAgent: media download failed; WhatsApp may no longer serve it.` — the same status, described as
reachable-both-ways rather than promised-to-recover. `tests/adapters/whatsagent-error.test.ts` pins
the words. No retry was added: the measurement above says a retry inside the session always fails,
so it would only add seconds before the same answer.

## Proposed fix upstream

In WhatsAgent's `classifyMediaFailure`: a failed fetch carries no age, but the message does. Treat a
failure as `unavailable` when the message is older than the window WhatsApp serves media for
(practically: anything older than a few weeks), and keep `transient` for recent messages. That turns
"try again" into "this is gone" at the layer that knows the difference.

## Reproduce

```sh
sqlite3 ~/Library/Application\ Support/whatsagent-desktop/whatsagent.db \
  "select media_state, media_error, count(*) from messages where type in ('image','video','sticker') group by 1,2;"
sqlite3 ~/Library/Application\ Support/whatsagent-desktop/whatsagent.db \
  "select id, datetime(ts,'unixepoch') from messages where media_state='placeholder' order by ts asc limit 4;"
# then load-media on one of those ids, through the MCP runtime token in mcp-runtime.json
```
