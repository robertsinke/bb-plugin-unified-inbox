---
title: "Bug report — a permanent media failure is reported as a temporary one"
status: settled
date: 2026-11-04
---

# Bug report — a permanent media failure is reported as a temporary one

**Filed:** 2026-11-04 · **Owner:** WhatsAgent (the provider) · **Status:** measured, cause named, fixed in WhatsAgent `bfd0f2d` the same day, with one wording change here

**Fixed by:** WhatsAgent `bfd0f2d` — `classifyMediaFailure` takes the message's age, so a server-side refusal on media older than `MEDIA_SERVE_WINDOW_DAYS` (14) is stored `unavailable` instead of `transient`, and a connection error stays retriable at any age.

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
the words. This stays after the upstream fix: `502` still covers a recent message whose download
really did fail once, and no retry was added, because the measurement above says a retry inside the
session fails anyway.

## What was changed in WhatsAgent

`classifyMediaFailure` (`server/channels/whatsapp/media.ts`) returned `unavailable` only for `404`/`410`,
so an expired-media refusal (412/418/5xx) was stored `transient` forever. It now takes the message's
age: a server-side refusal past the window is terminal, a connection error (no status at all) stays
retriable. The window is a named constant inside the measured gap — 9 days worked, 19 days did not —
not a value WhatsApp publishes. Tests in `server/api/media.test.ts` pin both sides of the boundary and
the end-to-end row (`failed` + `unavailable` for a 2025 message that refuses with 418).

## Reproduce

```sh
sqlite3 ~/Library/Application\ Support/whatsagent-desktop/whatsagent.db \
  "select media_state, media_error, count(*) from messages where type in ('image','video','sticker') group by 1,2;"
sqlite3 ~/Library/Application\ Support/whatsagent-desktop/whatsagent.db \
  "select id, datetime(ts,'unixepoch') from messages where media_state='placeholder' order by ts asc limit 4;"
# then load-media on one of those ids, through the MCP runtime token in mcp-runtime.json
```

## Closed

Re-measured 2026-11-04 after the daemon rebuild and restart (PID 49510, commit `bfd0f2d`):

| probe | before | after |
|---|---|---|
| `load-media` on a 2026-10-05 video | `502`, `reason: transient` | `410`, `reason: unavailable` |
| `load-media` on a 2019 image | `502`, `reason: transient` | `410`, `reason: unavailable` |
| that message's row | `failed` / `transient` | `failed` / `unavailable` |
| the inbox's answer for it | `WhatsAgent: media download failed; …` | `WhatsAgent: media is no longer available.` |

The 61 rows already stored `transient` keep that verdict until each is asked for again — the
classifier runs on the next attempt, so a click on one of those media turns its row `unavailable` on
its own. Nothing in this plugin needed changing as a result: the terminal class now arrives as the
`410` it already mapped.
