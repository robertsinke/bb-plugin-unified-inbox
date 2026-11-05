---
status: current
date: 2026-11-05
---

# A sender's name only arrives with live traffic

## What it looked like

Group bubbles read "Unknown" for people the owner knows, in a plugin that had just replaced a program
where the same group read correctly. Measured on the live account: **120 of 1,673** incoming group
messages had no name anywhere on the machine — not in `wa_contacts`, not as `pushName` inside the stored
envelope, not as a phone alias.

## Why

A name reaches `wa_contacts` by exactly two roads, and neither replays:

1. **The live envelope.** A message received while the socket is open carries `pushName` — the name the
   sender chose for themselves. `harvestPushName` writes it (`src/whatsapp/ingest.ts`).
2. **A contact sync.** `contacts.upsert` / `contact.update` when the owner's address book changes.

A device that syncs history into a fresh store keeps every message and loses every name: the history
dump carries no `pushName`, and WhatsApp never re-sends a name for a chat that is not active. So a
sender is a LID with nothing to be called, and `whatsappSender` says "Unknown".

`WhatsAgent` did not have a better mechanism — it had the same two roads and months of traffic on them.
Its store still held 4,969 contacts with a name, ours 3,637. The messages were imported; the names were
not.

Two things that look like a fix and are not:

- **The group roster.** `groupFetchAllParticipating()` — 434 groups on this account answered, and **0 of
  their people were named**. Participant lists carry ids, not names. (The ingest still binds
  `groups.upsert` / `groups.update`, because a name in a roster is the right thing to record if one ever
  appears.)
- **A lookup by LID.** Baileys offers `onWhatsApp(...)`, which refuses LIDs outright, and `USyncContact`
  answers only whether a jid exists. There is no name query by LID.

## What to do

`_tools/import-chat-names.mjs` fills what is missing from a previous store, once:

```sh
node _tools/import-chat-names.mjs --dry-run          # what it would add
node _tools/import-chat-names.mjs                    # ~/.bb/plugins/... and the WhatsAgent db
```

It reads only `contacts` (never a message body), never overwrites a name this store already has, and
counts what it changed. It recovered **2,329 contacts with a name** and **2,090 lid/phone aliases** here,
which took the unnamed group messages from 120 to 77. The remaining 77 belong to 56 people who are in
neither store: only live traffic will ever name them.

A fresh install has no previous store to read. That is the honest state of a source whose history is
synced rather than lived: names fill in as people speak.
