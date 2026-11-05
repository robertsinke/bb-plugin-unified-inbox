---
title: "LinkedIn conversations beyond the newest page: what the messenger path accepts"
description: "Measured read-only on the signed-in page: the newest-page query ignores every paging variable, and the web app pages its conversation list with a second pinned query whose nextCursor is the only thing that moves the window. What one page costs, and what the plugin now does with it."
status: settled
date: 2026-11-05
tags:
  - research
  - linkedin
  - unified-inbox
  - paging
---

# LinkedIn conversations beyond the newest page

**Question:** can the LinkedIn read walk further back than its newest page — and if so, by what
cursor, at what cost?

**Answer:** yes, but not through the query the inbox reads. The newest-page read
(`messengerConversations.0d5e6781bbee71c3e51c8843c6519f48`) is a *by-sync-token* feed that answers
its newest 20 conversations and ignores every paging variable. The web app pages the list with a
**second pinned query**, `messengerConversations.9501074288a12f3ae9e3c7ea243bccbf`, whose only
working paging variable is the opaque `nextCursor` it hands back. One page is one request, about
1.5–2 s warm. That is the walk the plugin takes (`INBOX-37`, plan U7).

**Evidence class:** measured on this machine against the signed-in page in the plugin's own headless
Chrome profile (adopted, not launched; the live plugin's browser). Every request was a GET that the
LinkedIn web app itself sends. No conversation was clicked open from this work, no invitation was
answered, nothing was sent and no read mark was replayed. The one app navigation used to see the
app's own requests (below) is reported with its side effect instead of being glossed over.

## 1. The newest-page read takes no paging variable

Seven variants of the pinned query were sent, in the same page, in one read:

| variables | status | bytes | conversations |
|---|---|---|---|
| `mailboxUrn` (baseline) | 200 | 229,448 | 20 |
| `+ start:20` | 200 | 229,448 | 20 |
| `+ count:20` | 200 | 229,448 | 20 |
| `+ start:20,count:20` | 200 | 229,448 | 20 |
| `+ paginationStart:20` | 200 | 229,448 | 20 |
| `+ nextPageStart:20` | 200 | 229,448 | 20 |
| `+ start:0,count:40` | 200 | 229,448 | 20 |

A second round tried `syncToken`, `newSyncToken`, `offset`, `limit`, `pageStart`, `pageSize`,
`first`, `after`, `before` and `lastActivityBefore` (with the real token value where one exists).
Every one answered status 200 with the same 20 rows and the same byte length. **A 200 here is not
consent:** this endpoint ignores an unknown variable instead of refusing it, so the only evidence
that a name works is that the rows change, and none did.

The same payload says what it is: `data.data.messengerConversationsBySyncToken` with
`metadata.newSyncToken` and `*elements` — a delta feed (which is exactly what the plugin's change
probe uses it as), not a pageable collection.

## 2. The web app pages with a second query, and only its cursor moves the window

Navigating the plugin's own page to `/messaging/` and reading `performance.getEntriesByType('resource')`
shows the app's own calls. Scrolling the rendered conversation list (`ul.msg-conversations-container__conversations-list`)
three times produced four new requests, and the first of them names the paged query:

```
queryId=messengerConversations.9501074288a12f3ae9e3c7ea243bccbf
variables=(query:(predicateUnions:List((conversationCategoryPredicate:(category:PRIMARY_INBOX)))),
           count:20, mailboxUrn:urn:li:fsd_profile:…, lastUpdatedBefore:1792403247497)
… then the same query with  nextCursor:REVTQ0VORElORyYxNzkxMzc3MjYxNjk3JjItTXpVNVpUTTRNV0V0WmpSbE55MDBZelJsTFRsak16Y3RPR1ExWW1Zek5UUmtaRE15WHp…
```

The list grew 19 → 42 → 62 → 82 rows over those three scrolls: three pages of 20.

Replayed without any scrolling, in one read:

- The query with **no** cursor answers the newest 20 rows plus `metadata.nextCursor`
  (`{nextCursor, $type: com.linkedin.messenger.ConversationCursorMetadata}`).
- Passing that cursor answers the **next** 20 rows, with **zero** overlap with the first page, plus a
  cursor for the page after it. A third page follows the same way.
- The cursor is base64 of `DESCENDING&<lastActivityAt>&<conversation key>` — a keyset cursor, so a new
  message arriving mid-walk pushes nothing and skips nothing (unlike an offset walk).
- `lastUpdatedBefore` is a real variable but **not** a usable bound: `lastUpdatedBefore` set to the
  oldest `lastActivityAt` of page 1 returned page 1 again, all 20 rows of it. It is ignored too.
- `count` is honoured up to a ceiling: 20, 21, 22 and 25 answered that many rows; **29 and 30 answered
  an empty collection with status 200** (510 bytes). A too-large page therefore reads as "there is
  nothing older" unless the count is bounded, which is why the plugin caps it at 25 and asks for 20.

Each page inlines its conversations, their participants and their newest message — the same shape the
newest-page read returns, so a walked-back row is drawn by the same row builder. Names and avatars are
still one profile lookup per counterpart, exactly as for the newest page.

## 3. What a page costs

Warm page, through the shipped expression, 20 rows:

| read | requests | measured |
|---|---|---|
| first press: the newest page for its cursor, then the page behind it | 2 + identity | **2.2–2.3 s** |
| every later press | 1 + identity | **1.5–2.0 s** |

Both are inside the panel's 15 s older-page deadline and the plugin's 20 s browser-command cap, and
neither scrolls, clicks or marks anything read: an older page is a GET whose answer is parsed.

## 4. What this changed in the plugin

- `src/linkedin-page.ts` gains an `older` read: the pinned query above, one page, with the row builder
  the newest page uses. `LINKEDIN_WALK_START` is the cursor for a walk nobody has started — the first
  press asks the newest page for its own cursor and then reads the page behind it, which is why that
  one press costs two requests. A cursor and a page size are validated before the page is asked, so
  what the page evaluates is always a well-formed request.
- `src/adapters/linkedin.ts` declares `pageSize: 20` and takes a cursor back. The newest page is still
  the cache and still costs nothing; `sync` and `list` both answer where the walk starts. An older page
  is **drawn, never saved** — `cache.save` replaces an account's rows wholesale, so storing an older
  page would wipe the newest one it was walking behind.
- No gateway or panel branch: the existing `olderCursor` shape carries LinkedIn's cursor like Gmail's
  token and WhatsApp's offset. `more` answers false when a page hands back no cursor, and the failure
  path is the one every source has: one phrased error line, the cursor forgotten, the next refresh
  re-seeding the walk.

## 5. What this could not verify, and one side effect

- The ceiling's exact value: 25 answered and 29 did not; 26–28 were not tried. The plugin asks for 20.
- Whether the cursor stays valid after the inbox changes are large enough to matter (a page was walked
  three deep in one sitting, not across days). A cursor the server has dropped would answer with an
  error or an empty page; the adapter treats the empty page as the end of the walk, which is the safe
  reading, and a dropped cursor cannot corrupt anything because nothing is cached.
- **Side effect observed, and not repeated:** navigating the plugin's own tab to `/messaging/` to see
  the app's requests made LinkedIn's own web app issue its `markAllMessagesAsSeen` call (badge clear)
  and restore the last open thread. That was the app's behaviour on load, not this work's request — the
  plugin's reads stay on `/feed/` and never navigate — but it is recorded here because a diagnostic is
  not allowed to change account state quietly.
