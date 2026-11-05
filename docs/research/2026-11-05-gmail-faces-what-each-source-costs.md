---
title: "Gmail faces: what each of the three sources costs, and which grants it needs"
description: "The two live Gmail credentials carry no contact scope; Google has no photo-only scope, so a face means read access to every field of every contact. Measured: 20 cached rows name 15 senders, 67 cached threads hold 41 From addresses. No decision is made here — the trade is the owner's."
type: research-note
status: current
date: 2026-11-05
tags: [research, gmail, avatars, oauth, privacy]
---

# Gmail faces: what each source costs

**Scope:** INBOX-35. Gmail rows draw initials; every other source draws a picture. This note prices the three
ways to change that. **It decides nothing.** Two of the three ask the owner for a privacy grant that nobody
else can give, so the choice is put to him rather than guessed. No code changed.

**Evidence class:** the two credential records' `scopes` field, `gws auth login --help`, `--help`-level facts
about Google's scopes, and the plugin's own database copied read-only from
`~/.bb/plugins/unified-inbox/data.db`. No token, client secret, message body or contact record is reproduced
here — only scope strings, counts, and paths in this repository. No network call to Google was made.

## What the panel already does

Nothing on the panel side needs changing for any of the three options. `ContactAvatar` (`app.tsx`) already
draws `<img>` when a row carries `avatarUrl`, initials when it does not, and `onError` turns a dead URL back
into initials. `avatarHue`/`avatarFace` already give every name a stable colour, so **Gmail rows today are
exactly option 3** — a deterministic face of our own is the status quo, not a change.

What is missing is only a picture for a Gmail row, which puts all the work on the source side: a cache with a
`fetched_at`, an ask behind the draw (as `src/whatsapp/avatars.ts` does), and one widened host in
`src/avatar-url.ts`.

## Option 1 — Google contacts (People API)

The face is real. The grant is not narrow.

| fact | evidence |
|---|---|
| neither credential carries a contact scope | both records list `gmail.modify`, `gmail.send`, `userinfo.email`, `userinfo.profile`, `openid`, `source: gws-import` |
| `people/me/connections` needs `https://www.googleapis.com/auth/contacts.readonly`; `people/me/otherContacts` needs `https://www.googleapis.com/auth/contacts.other.readonly` | Google's scope for the endpoint |
| **there is no photo-only scope** | the contacts scopes grant read of every field of every contact — names, addresses, phones, birthdays, notes |
| a re-login can request it | `gws auth login --scopes <list>` exists on this machine |
| `--scopes` replaces the requested set | so the re-login must re-include `gmail.modify` and `gmail.send`, or the whole mail source stops reading and sending |
| a re-import needs `--force` | `src/account-import.ts` refuses to replace a live record otherwise |
| the personal grant is re-consented anyway | consent screen in *Testing*: its refresh token died at exactly 7 days (`decisions/0008`) |

What leaves the machine: **nothing.** The People API is Google, and Google already holds the mail. This is the
only option that discloses nothing to a new third party.

What it costs the owner: a consent screen on both accounts that names his contacts, and a Cloud-console scope
change. Until he does it, every read answers `403` — an inert source, not a broken one.

Coverage: people he has saved, plus (with the second scope) people he has emailed but not saved. Newsletters,
receipts and strangers still draw initials.

## Option 2 — a hashed-email picture service (Gravatar)

No scope, no consent screen, no new credential.

What leaves the machine: `md5` of each correspondent's lowercased address, to `gravatar.com`, once per sender.
A hash of an email address is not a secret — addresses are enumerable, so this discloses **who writes to him**,
not merely a random digest. It is permanent and it cannot be taken back.

Coverage is low for ordinary mail; the service's population is developers and publishers.

## Request volume, whichever is chosen

| measured | |
|---|---|
| cached Gmail rows | 20 (10 per account) |
| distinct sender display names | 15 |
| cached threads | 67 (25 business, 42 personal) |
| distinct `From` addresses across those threads | **41** |

So a per-sender cache costs about 41 asks once, then one per new sender — and one request per sender is the
right shape, because a sender appears in many rows and a thread appears in none.

One detail for whoever builds it: `row()` in `src/adapters/gmail.ts` stores `sender` as the *display name*
(`mailSenderName`) and drops the address, so a picture keyed on the address has to be keyed where the raw
`From` header is still in hand.

## What the owner is being asked

1. **Contacts** — a face, and Google learns nothing it did not know; the price is a consent screen on two
   accounts that grants this machine's OAuth client lasting read access to his whole address book.
2. **Gravatar** — a face without asking him to click anything; the price is telling a third party who his
   correspondents are, for good.
3. **Draw nothing differently** — the initials and per-name colour he has today. Zero cost, always answers,
   never a broken image.

This note recommends no option because the trade is not technical: it is how much of his address book, or his
correspondent list, an avatar is worth.
