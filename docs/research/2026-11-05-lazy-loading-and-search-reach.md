---
title: "Lazy loading and search reach: what each source can page by, and what search can see"
description: "Measured: the panel sees 111 of 699 WhatsApp chats, and search indexes 111 conversations with 999 of 6,186 stored messages. What each source can page by, why the panel already needs no new request shape, what search could reach at what price, and what breaks first."
status: current
date: 2026-11-05
---

# Lazy loading and search reach

**Scope:** the owner's two asks — a way to walk further back in every source, and a search that reaches past
the newest page. This note answers what each source can page by, what the panel does with it, what search
should reach and at what price, and what breaks first. It changes no code.

**Evidence class:** measured on this machine against the live plugin's own database (`~/.bb/plugins/unified-inbox/data.db`,
copied read-only), the `imsg` binary on this disk, and the plugin's source. No message body, credential or
account-state byte is reproduced here; only counts, bytes and timing. No WhatsApp socket was opened (counts
come from the store file, not from the transport), nothing was sent, and the live plugin was not reloaded.

**Baseline:** `npm test` passes 595 tests in this worktree (580 at `42f027d`, plus the avatar work that is
uncommitted here). `main` is already merged into this branch.

## What the panel holds today

| what | measured |
|---|---|
| `inbox_cache` rows (what the list and search see) | gmail-personal 10, gmail-business 10, imessage 20, linkedin 21, whatsapp 50 — **111** |
| `inbox_search` documents | **111** — one per cached conversation, 131,542 bytes of terms |
| `inbox_thread` rows (cached bodies, incl. threads opened by hand) | 123 rows, 2.4 MB: gmail-personal 42, gmail-business 25, imessage 4, linkedin 12, whatsapp 40 |
| WhatsApp store | **699 chats, 6,186 messages**, 408,381 bytes of message text (avg 78 chars), ~1,101 bytes/row with envelopes, 9 chats with no stored message |
| WhatsApp messages indexed | **999** (the 40 cached threads' bodies) — 5,187 stored messages are invisible to search |
| whole plugin database | 13 MB, of which the WhatsApp store is most of it |

So the owner's sentence is exactly right twice over: a conversation outside the newest 20/20/20/50 is absent
from `inbox_cache`, and 6,186 stored WhatsApp messages are outside the index.

## 1. What each source can actually paginate by

### Gmail

- **Call:** `users.threads.list` with `labelIds: ['INBOX']`, `maxResults`, `pageToken`; then one
  `users.threads.get` per row with `format: 'metadata'` (a listing carries an id and a snippet and nothing a
  row can be drawn from).
- **Cursor:** the opaque `nextPageToken` (`src/adapters/gmail.ts`, `nextCursor`). It belongs to that query, it
  cannot be walked backwards, there is no offset, and `resultSizeEstimate` is not a count of pages.
- **Stable while new mail arrives?** No, in the weak sense that matters: a message landing in the inbox shifts
  the result set ahead of the token, so a page can repeat or skip a thread, and a token can be dropped by the
  provider. The gateway already handles the second case — a failed older page forgets the cursor
  (`src/gateway.ts`) so the next refresh reseeds from the newest page instead of retrying a dead token forever.
- **Cost:** one listing call plus **one thread read per row**. The adapter's own measurement is ~0.7 s per
  `metadata` read against ~1.35 s for `full`, run in parallel (that is why a page is 10, not 20: twenty
  sequential reads measured 11–20 s and lost the panel's 15 s deadline). The 15 s `OLDER_TIMEOUT_MS` in
  `src/inbox-session.ts` is the real ceiling, not the quota.
- **Also true:** an older Gmail page is deliberately **not cached** (comment in `listThreads`), because
  `cache.save` replaces an account's rows wholesale. So today a page walked back is invisible to search.

### WhatsApp

- **Call:** `transport.listChats({ cursor, limit })` → `store.listChats({ offset, limit + 1 })`, i.e.
  `ORDER BY last_msg_at IS NULL, last_msg_at DESC, jid ASC LIMIT ? OFFSET ?` plus one "newest message" read and
  one unread count per chat.
- **Cursor:** a decimal row offset, advanced by the page just returned; a page is asked for one row past its
  limit so a full page is never mistaken for "there is more".
- **Stable while new mail arrives?** **No.** `last_msg_at` is the sort key and it moves whenever a chat
  receives a message, so one arriving mid-walk pushes every later row down by one: the walk repeats a chat and
  skips another. The panel hides the repeat (it drops a row already on screen) and cannot hide the skip. The
  stable form is a watermark taken with page 1 (`last_msg_at <= :newest` as seen then) plus a keyset
  comparison, not a bare offset.
- **Cost:** local SQLite, three queries per row, no network and no socket — a page of 50 is well under a second
  with 699 chats, and the work scales with the page, not the store.

### Messages (`imsg`)

- **Call:** JSON-RPC `chats.list` over stdio (`src/imsg-client.ts`, `chats.list` is one of four read methods).
- **Cursor:** **there is none.** `chats.list` takes `limit` only — no offset, no "after" id (verified against
  `imsg 0.20.0`'s own help and the captured protocol doc at `docs/research/imessage/sources/imsg-rpc.md`).
  `messages.history` takes `start`, `end` and `limit` but no offset; `messages.after` does carry a real,
  resumable ROWID cursor with `has_more` and a next cursor — but it walks oldest-first, so it is a catch-up
  cursor, not a "show me older conversations" one.
- **What that means today:** the whole `chat.db` holds **105 chats**, and one `chats.list` at `limit: 200`
  returns all of them. Measured: `--limit 20` = 7,220 bytes in **4.6 s**; `--limit 200` = 37,239 bytes in
  **23.1 s**; `--limit 600` returns the same 37,239 bytes (the list is exhausted). With `--no-contacts` the same
  two calls take **0.11 s and 0.12 s** — so the cost is Contacts resolution per chat, not the database read,
  and the adapter's `sync` already pays that cost for the 20 rows it shows.
- **Therefore:** Messages can page exactly and completely by slicing one full listing, and a true source cursor
  would have to be added to `imsg` upstream. There is also a `messages.search` method (local, case-insensitive,
  limit ≤ 100) that searches the whole database regardless of what is cached.

### LinkedIn

- **Call today:** none for the list. `list` answers cached rows only and ignores a cursor; the live read is
  `sync` → one pinned GraphQL call `messengerConversations.<queryId>` whose only variable is `mailboxUrn`.
- **Cursor:** the `inbox_sync` column already holds a marker (newest activity, unread total, conversation and
  invitation counts, plus the mailbox) used to skip a full read. That is a **freshness** marker, not a page
  cursor: it says "nothing changed", never "the next 20 are behind this point". The invitations path does have
  `start`/`count`, and the inbox path does not — LinkedIn's own web app scrolls this list, so the query almost
  certainly accepts paging variables; which names it accepts is **not** established here.
- **Cost:** one payload plus about twenty profile lookups per full read (the comment in
  `src/adapters/linkedin.ts`), inside the page session that already costs seconds. A page older than the marker
  would be a second full read, because the delta check only covers the newest window.

## 2. What the panel does with it

**The shape already exists and needs no new one.** `list({ older: true, account })` →
`{ items, errors, more }`, and `src/gateway.ts` keeps one in-memory `olderCursor` per source:

- the newest-page read (`sync`) **seeds** the cursor and never advances it, so the 45-second poll cannot restart
  a walk the owner began;
- only `list({ older: true })` advances it, one page per source, `more` false when the source says there is
  nothing older;
- `session.more()` presses once and fans out to every source that promised more (`Promise.all`), merging rows
  as each answers, with a 15 s deadline, one error line per failure, and the shown rows untouched.

So Gmail and WhatsApp already walk, and the panel is already free of per-source shapes. What is missing is
one line per source: `pageSize` in the declaration (`src/adapters/source.ts` validates it, and
`tests/source-declaration.test.ts` requires that a source either declares one or does not). Messages and
LinkedIn declare none, so `olderCursor` stays undefined for them and `more` is false — the panel is not
refusing to page them, it has nothing to page by.

**One thing the panel does need to change.** `app.tsx` draws search results by looking each hit up in the rows
it already has:

    shown = hits.flatMap(hit => { const item = filtered.find(row => row.id === hit.id); return item ? [item] : []; })

A hit outside the loaded list is silently dropped. That is a second, panel-side reach limit that no amount of
indexing fixes: search can only *show* what the list already holds.

Also stale: the footer says "the newest 20 threads per Gmail and Messages account" while Gmail's declared
`pageSize` is 10.

## 3. What search should reach, and at what price

Today the index's membership **is** the cache's listing: `createSearchIndex` builds a document per
`cache.list()` row, and `warm()` / `replaceAccount()` *delete* every document that is not in that list. The
index is one BM25 corpus in memory, persisted to `inbox_search`, keyed `account\0id`, ranked with one global
average document length.

### Option A — index the store, not the cache (WhatsApp, Messages)

The data is already on this disk; only the index's membership rule stands in the way.

- **WhatsApp:** 699 chats / 6,186 messages. Measured density: the 50 cached WhatsApp documents hold 86,596
  bytes of terms for 999 messages, i.e. ~87 bytes per message. All 699 chats would be roughly **0.5 MB of terms
  and 700 documents**, built from SQLite with no socket, no network, and under a second of CPU.
- **Messages:** 105 chats, ~700 bytes of terms per conversation → **~75 KB**, and the one `chats.list` that
  feeds it costs 0.12 s without Contacts (the names `sync` already resolves can be reused).
- **Cannot find:** anything Gmail or LinkedIn — neither has a local store — and, on its own, cannot *show* a
  hit the panel never listed (section 2).
- **Risk:** the index would delete itself on the next `save()` unless its membership rule changes with it.

### Option B — ask the source (Gmail)

- **What it needs:** a `q` parameter on `GmailClient.threadsList` (one line in `src/adapters/types.ts` and one
  in `src/gmail-client.ts`), and one adapter method that turns hits into rows.
- **Price:** one listing call per settled query per account (the panel already debounces search at 150 ms), but
  a listing gives ids and snippets, so **each visible row costs one `threads.get(metadata)`** — ~0.7 s, run in
  parallel and capped (ten hits ≈ 1–3 s). Unbounded per-hit reads would turn one keystroke pause into a
  twenty-call burst.
- **Cannot find:** a phrase that exists only inside an attachment, and anything the mailbox's own search syntax
  does not match.
- **What makes it safe:** one in-flight search per account, the newest answer wins, and a search never writes
  the cache.

### Option C — backfill and cache a lot more (the owner's own suggestion)

| source | what "a lot more" costs |
|---|---|
| Gmail | 10 → 1,000 rows per account is ~600 KB of cache text (145 bytes/row measured), but ~700 s of quota-bound thread reads, and it collides with `cache.save`'s wholesale replace: the next 45 s sync erases the backfill unless the cache's contract changes. |
| LinkedIn | 21 → all: each page is a full read (~1 payload + ~20 profile lookups) with no delta for pages older than the marker — 3–4 s per page and no cheap "is it current" check. |
| WhatsApp | already fully stored: backfilling pays disk for data the store holds, and the store is already the thing that would have to grow. |
| Messages | already fully stored in `chat.db`: backfilling copies what a 0.12 s local read answers on demand. |

### Recommendation

**A first, B second, C not at all.** Index the local stores (that is where 6,186 messages and 105 chats already
live), then give Gmail one capped "ask the mailbox" path because it has no local store. Do not backfill into
`inbox_cache`: it costs network for Gmail, seconds per page for LinkedIn, and it breaks the one rule the cache
has — it holds the newest page as of the last refresh.

**What the recommendation cannot find:** a Gmail thread's body text beyond the cap of one search (the listing
snippet only), a LinkedIn conversation older than the newest ~20 until LinkedIn can page, and a message inside
a cached thread that was never in the index's document because the document is per-conversation, not
per-message.

## 4. What breaks first

1. **`cache.save` replaces an account's rows wholesale.** A cached older page is deleted by the next 8 s / 45 s
   sync. This is why the Gmail walk is read-only today, and it is a contract, not a bug: an older page must
   either be preserved by `sync` (a decision, and a change to what "cached" means) or stay out of the cache.
2. **The index's membership is `cache.list()`.** `warm()` and `replaceAccount()` drop documents that are not in
   it, so store-indexed documents would erase themselves on the first WhatsApp `items` change. This is the
   first thing to fix, and it is one function's rule.
3. **The panel drops a hit it never listed** (`app.tsx`). Search reach without this is invisible reach.
4. **WhatsApp's offset drifts** whenever a chat receives a message mid-walk: one row skipped per arrival.
5. **A walk and a poll are not serialised.** `src/inbox-refresh.ts` keeps one flight per source for `sync`, but
   `list({ older: true })` is outside that map, so a press during a refresh is two Gmail bursts at once.
6. **Unread.** An older Gmail row can be unread, so reaching further raises the badge for threads nobody has
   seen — correct, but it will look like a bug the first time it happens. WhatsApp's unread is derived from the
   per-chat read cursor, so it is consistent by construction.
7. **Nothing caps the cache.** 145 bytes a row is cheap; the refresh that produced it is not, and no eviction or
   ceiling exists today.

## What I could not answer

- **Whether LinkedIn's pinned `messengerConversations` query accepts a paging variable** (`count`, `start`, or a
  timestamp cursor), and which one. That needs a read-only probe of the signed-in page, and the browser profile
  is owned by `src/linkedin-chrome.ts` in the live plugin, which this task did not touch. The plan carries it as
  a unit with that unknown named, not as a settled fact.
- **Whether `imsg` will add an offset to `chats.list`.** Today the whole chat list is one call, so Messages does
  not need it; a `chat.db` with thousands of chats would.
- **Gmail's exact quota units per call, and whether a `nextPageToken` survives a thousand-row walk.** Both need
  a live walk on the owner's mailbox; this note only establishes the shape of the cost (one read per row) and
  the ceiling that binds first (the 15 s older-page deadline).
- **Search quality at 700+ documents.** I measured cost and membership, not ranking: one corpus with one global
  average length will change what ranks first once 699 WhatsApp chats outweigh 111 mixed rows.
