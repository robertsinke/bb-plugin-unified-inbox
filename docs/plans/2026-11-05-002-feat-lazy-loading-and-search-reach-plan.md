---
title: "feat: lazy loading in every source, and a search that reaches past the newest page"
description: "Seven units: search membership stops being the cache's listing, WhatsApp and Messages index what they already store, the panel stops dropping a hit it never listed, Gmail answers one capped query, WhatsApp pages without drifting, LinkedIn pages or says it cannot. Status proposed."
status: accepted
date: 2026-11-05
---

# Lazy loading in every source, and a search that reaches past the newest page

**Target repository:** bb-plugin-unified-inbox. All paths are relative to this repository.
**Planning only:** no product code, no dependency, no live-plugin change. Evidence, measurements and the
per-source cost table are in [the research note](../research/2026-11-05-lazy-loading-and-search-reach.md).

## What is already true

- The walk exists: `list({ older: true, account })` → `{ items, errors, more }`, one `olderCursor` per source in
  `src/gateway.ts`, seeded by `sync` so the poll never restarts a walk, and one press in the panel
  (`session.more()`) fans out and merges as each source answers.
- Gmail (`pageSize: 10`) and WhatsApp (`pageSize: 50`) walk today. Messages and LinkedIn declare no `pageSize`,
  so they cannot.
- Search indexes exactly what `cache.list()` returns — 111 conversations, holding 999 of the store's 6,186
  WhatsApp messages — and deletes any document that is not in that listing.
- `app.tsx` draws a hit only if it is already in the loaded rows.

So this plan is not "add pagination". It is: give the two silent sources something to page by, change the one
rule that keeps search inside the cache, and let the panel draw what it found.

## Goals

- **G1** Every source can be walked further back, or says it has nothing older — no source is silent.
- **G2** The panel keeps one request shape and one "there is more" answer; it learns nothing per source.
- **G3** A search finds a conversation the list never loaded, and the panel can show it.
- **G4** No new network, socket or process for a source whose data is already on this disk.
- **G5** Nothing about sending, unread bookkeeping or freshness changes.

## Non-goals

- An FTS5 table or any external search dependency: BM25 in memory over 700 documents is measured cheap.
- Paging messages *inside* a thread (WhatsApp keeps 60, Gmail reads whole threads). Conversations only.
- Cache eviction or a size ceiling: no ceiling exists today and this plan does not invent one.
- Gmail history-API catch-up, or a change to the 8 s / 45 s poll cadences.
- Cross-source ranking work. One corpus, one global average, as today.
- LinkedIn search per keystroke: LinkedIn costs seconds per read and is capped by that, not by the query.

## Key decisions

**D1 — Search membership moves from the cache to the source.** `createSearchIndex` takes a corpus provider per
account instead of reading `cache.list()` as its universe; `warm()` and `replaceAccount()` stop dropping a
document for a conversation the source can still answer. This is the first unit because every later one depends
on it, and because without it a store-indexed document deletes itself on the next `items` change.

**D2 — The store is the source of truth for local sources.** WhatsApp answers from `wa_chats` / `wa_messages`
through `src/whatsapp/store.ts`; Messages answers from one full `chats.list`. Neither opens a socket and neither
adds a network call. `cache.save` keeps replacing an account's rows wholesale, so nothing here depends on an
older page being cached — which is exactly why the Gmail walk stays read-only.

**D3 — One adapter hook, not five shapes.** Both paging and search reach are declared, not branched: a source
declares `pageSize` (already the rule, enforced by `tests/source-declaration.test.ts`) and answers one optional
search-corpus method. No `account === …` in the gateway, the panel or the index.

**D4 — Gmail is the one source that must ask.** Its listing carries no text a row can be drawn from, so a hit
costs one `threads.get(metadata)` (~0.7 s). Capped, coalesced, one in-flight per account, newest answer wins,
never written to the cache.

**D5 — An older page is not cached, and search does not need it to be.** If a later decision wants cache growth,
it changes what "cached" means and belongs in `decisions/`, not in a unit here.

## Units

Each unit is shippable alone, in this order, with its own test. `npm run check` must be green after each: typecheck,
the patched WhatsApp client, the suite (595 tests in this worktree, 580 at `42f027d`), and the send audit.

### U1 — Search membership comes from the source, not from the cache

`src/search-index.ts` takes, per account, the rows it should hold; the gateway supplies `cache.list()` for a
source that offers nothing better. `warm()` and `replaceAccount()` keep a document that a source still answers
for, and still drop one whose source no longer lists it. `clear_cache` keeps emptying the index because it
empties every source's corpus too.

- **Test:** `tests/search-index.test.ts` — a document for a conversation absent from `cache.list()` survives
  `warm()` and a `save()` of that account; a conversation the corpus dropped is removed; `status().size` counts
  it.
- **Must not break:** the `account\u0000id` key shape and the gateway's `truncated`/score contract; `warm()`
  stays a no-op after the first call; the index is still rebuilt from `inbox_search` on start.

### U2 — WhatsApp: the store answers search, the socket stays shut

`WhatsAppTransport` gains one store read (all chats with their stored messages, noise and protocol rows
filtered by the same `isWhatsAppNoise` rule the panel uses); `src/adapters/whatsapp.ts` offers it as the search
corpus. ~0.5 MB of terms for 699 chats, no socket, no lifecycle `ensure()`.

- **Test:** `tests/whatsapp/transport.test.ts` and `tests/adapters/whatsapp.test.ts` — a chat older than the
  newest 50 is found by a query from its stored messages; a protocol row and a noise row are not indexed; a
  group's own name is; the store read calls no lifecycle method.
- **Must not break:** never open a second socket (`connectionReplaced` spends a device slot); an unpaired
  account answers an empty corpus rather than an error.

### U3 — Messages: the whole chat database, in one page

The adapter declares a `pageSize`, asks `chats.list` once for the full list (measured: 105 chats, 0.12 s without
Contacts), slices it into pages, and hands the same rows to the search corpus. The names `sync` already resolves
are reused rather than resolved again.

- **Test:** a new `tests/adapters/imessage.test.ts` — page 1 of N, page 2 holds what page 1 did not, `more`
  false at the end, a second press adds nothing; a chat outside the newest 20 is found by search.
- **Must not break:** `imsg`'s read-method allowlist; a failure still becomes the Messages hint with
  `REFRESH_SUFFIX`; no cursor is invented where the source has none.

### U4 — The panel draws a hit it never listed

`search` answers with the row it matched (or the session resolves it through `cached`), and `app.tsx` stops
filtering hits through the loaded rows. The stale footer sentence ("newest 20 threads per Gmail") is corrected to
what each source declares.

- **Test:** `tests/inbox-session.test.ts` — a hit absent from `items` is shown and can be opened; and a jsdom
  render test that the row appears with its title from the hit, not a placeholder.
- **Must not break:** `hits === null` still means "no search"; one request shape; no per-source branch; a search
  still writes nothing.

### U5 — Gmail: one capped question per settled query

`GmailClient.threadsList` gains `q` (one line in `src/adapters/types.ts`, one in `src/gmail-client.ts`);
`src/adapters/gmail.ts` turns the hits into rows with one `metadata` read each, capped; the gateway keeps one
in-flight search per account and drops a stale answer.

- **Test:** `tests/gmail-client.test.ts` (the query is sent, escaped, and an absent `q` sends nothing) and
  `tests/adapters/gmail.test.ts` (the cap holds, one read per hit, a rejection becomes a scrubbed
  `ProviderError`, the cache is untouched).
- **Must not break:** a mailbox failure is one `ProviderError`, not five; no search writes `inbox_cache`.

### U6 — WhatsApp pages without drifting

The offset is replaced by a watermark taken with the first page plus a keyset comparison, so a chat receiving a
message mid-walk neither duplicates nor disappears. If the team decides drift is acceptable, the unit is instead
a test that names the behaviour and the panel's dedupe covers it — one or the other, not silence.

- **Test:** `tests/whatsapp/store.test.ts` — a message arriving between page 1 and page 2 does not hide a chat;
  `more` is false only when the source says so; an empty next page is never read as "the end".
- **Must not break:** the store's ordering contract (newest activity first); unread counts computed from the
  per-chat read cursor.

### U7 — LinkedIn pages, or says it cannot

Resolve the one open question in the research note: probe the pinned `messengerConversations` query for a paging
variable, read-only, on the signed-in page, and record the answer in `docs/research/linkedin/`. If it pages, the
adapter takes a cursor and returns the next page without pretending the delta marker covers it. If it does not,
LinkedIn declares no `pageSize` and the footer stops promising more — a source that cannot page says so.

- **Test:** `tests/linkedin-page.test.ts` (the expression builds the paged URL, and the unpaged URL byte for
  byte when there is no cursor) and a `src/adapters/linkedin.ts` test that a cursored list does not call
  `cache.save`.
- **Must not break:** the whole-cache replace in `sync` (an older page must not be silently wiped and must not
  claim to be fresh); `src/linkedin-conversation.ts` stays the one spelling of a conversation's identity.

## Invariants this plan must not break

1. `npm run check` green after every unit: typecheck, the patched WhatsApp client, the suite, the send audit.
2. One send gate. `src/adapters/policy.ts`, `src/mail-approval.ts` and `src/send-audit.ts` are untouched.
3. **No second WhatsApp socket, ever.** Every WhatsApp read here goes to SQLite.
4. `cache.save` stays "an account's rows, newest page, replaced wholesale" unless D5 is reopened.
5. The panel learns no per-source shape: `source` declaration and `capabilities()` remain the only per-source
   facts, and `tests/source-declaration.test.ts` still decides who may declare `pageSize`.
6. The RPC surface grows only where a unit says so; `search` keeps its ranked-ids shape or gains the row, and
   `src/rpc-contract.ts` is the one place that says which.
7. `src/CONTEXT.md` is updated where this plan settles an owner: search membership, and the "who owns the list
   and where the next page starts" row that is listed as unsettled today.
8. `docs/_index.md` is regenerated before every commit.

## What stays out of scope

FTS5 or any external search engine; message-level paging inside a thread; a cache ceiling or eviction;
backfilling `inbox_cache` with older pages; Gmail history synchronisation; LinkedIn search per keystroke; any
change to poll cadences; any live-plugin reload (the parent verifies live, per the repository's rule 1).

## Open questions

- **Is one BM25 corpus still the right shape once 699 WhatsApp chats outweigh 111 mixed rows?** Cheap to keep,
  but the ranking changes. A per-source cap or a per-source normalisation is the likely answer, and it is a
  follow-on decision once U2 lands and someone can read the results.
- **Should `session.more()` press once per source or once for all?** Today one press advances every source that
  promised more; with Messages holding 105 chats a single press could add a whole second page of chat rows while
  Gmail is still reading its ten threads.

## What shipped (INBOX-33: U1–U4)

Landed as one change; U5, U6 and U7 are the later child and are untouched here.

- **U1** — `src/search-index.ts` takes one corpus per account (`Adapter.searchCorpus`), not `cache.list()` as
  its universe: a row whose source still answers for it survives a `save()`, a row the source dropped is
  removed, and `warm()` is isolated per account so a source that cannot answer keeps its documents. The index
  also keeps the row behind each document, which is what lets a hit be drawn. `src/gateway.ts` still answers
  ranked ids and now answers their rows with them; the cache's row wins where it exists, so a listed row keeps
  its decorations and its unread mark.
- **U2** — `WhatsAppTransport.listCorpus()` reads every chat with every stored message straight from `wa_*`
  (2 statements, no envelope), the adapter filters the same noise rule the list uses, and `searchCorpus` is
  that read. Measured against the live plugin's database, copied read-only: 699 chats / 6,191 messages become
  **699 documents and 318 KB of persisted terms in 0.46 s**, built with no socket — a test proves `connection`
  and `ensure` are never called. The whole index after this unit is 845 documents (WhatsApp 699, Messages 105,
  Gmail 20, LinkedIn 21) where it was 111.
- **U3** — Messages declares `pageSize: 20`; `sync` asks `chats.list` for one row past its page so a cursor is
  offered only when a row really exists, and an older page is a slice of one full `chats.list` (memoized per
  adapter, shared with the corpus). The same rows are the search corpus, so a chat past the newest 20 is a hit.
- **U4** — `search` answers `items`; `InboxSnapshot.hits` is rows, and `app.tsx` draws `(hits ?? items)` through
  the owner's filter instead of looking each hit up in the loaded list. The footnote is derived from the
  declarations (`src/inbox-footnote.ts`), so Gmail's ten and Messages' twenty are no longer described as twenty.

Measured again for U3, because the plan's 0.12 s is the `--no-contacts` CLI read and the RPC has no such flag:
`chats.list` answers all 105 chats in **10.0 s** over JSON-RPC on this machine (Contacts unavailable, ~95 ms per
chat; 2.1 s for the 21-row newest page). Under the panel's 15 s older-page deadline but not comfortably: the
first press or the first query after a start pays that one read, and every later page of the session is a slice
of the memo.

### Execution log

- **2026-11-05, batch 1 (U1 + U4 wiring)** — `src/adapters/types.ts` (`SearchRow`, `searchCorpus?`),
  `src/search-index.ts`, `src/gateway.ts`, `src/rpc-contract.ts`, `server.ts`, `src/inbox-session.ts`,
  `app.tsx`, `src/inbox-footnote.ts`, `src/inbox-agent-tools.ts`. Tests: `tests/search-index.test.ts` (9),
  `tests/inbox-session.test.ts` (a hit absent from `items`), `tests/inbox-list.render.test.ts` (the panel
  draws the hit's own title, and the footnote's numbers come from the declarations).
- **2026-11-05, batch 2 (U2 + U3)** — `src/whatsapp/store.ts` (`listCorpus`), `src/whatsapp/transport.ts`,
  `src/adapters/whatsapp.ts`, `src/adapters/imessage.ts`, `src/imsg-mapping.ts` (`IMSG_CHAT_LIMIT`). Tests:
  `tests/whatsapp/transport.test.ts` (the corpus, with no socket asked), `tests/adapters/whatsapp.test.ts`
  (a chat past the newest page found by a word inside it; protocol and system rows not indexed; a group's own
  name indexed), `tests/adapters/imessage.test.ts` (page 1 of N, page 2 holds what page 1 did not, the end
  says so, a second press adds nothing, a chat past the newest page is a hit).
- **2026-11-05, batch 3 (docs)** — `src/CONTEXT.md` (search membership; the paging-cursor row moved out of
  "unsettled"), this note, `docs/_index.md` regenerated.

### What this does not settle

- **One BM25 corpus over 700 WhatsApp chats and ~100 mixed rows** ranks differently than before: WhatsApp now
  outweighs every other source. Named as an open question above; a per-source cap is the likely answer.
- **The first Messages read of a session is 10 s here** (see above), and the corpus warm is on the panel's
  first sync, so a search typed in the first seconds after a start waits for it.
- **An older Messages page is a snapshot.** `chats.list` has no offset, so the memo is the ordering; a chat
  arriving later is in the newest page from `sync` and not in the slice. Same class as U6's drift, unfixed here.
