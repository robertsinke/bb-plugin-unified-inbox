---
title: A profile picture fetched where the row is drawn blocks every list
date: 2026-11-05
category: logic-errors
module: WhatsApp transport (unified-inbox plugin)
problem_type: design_error
component: transport
symptoms:
  - "no WhatsApp row ever had an avatarUrl, so every row and every group drew initials"
  - "the obvious fix — ask profilePictureUrl while building the row — turns an 8 s poll into a page of network waits"
  - "asking for a socket to fetch a face spends a device slot against the live account state, and re-pairing is the ban lever"
root_cause: design_error
resolution_type: code_fix
severity: medium
tags: [whatsapp, avatars, transport-seam, read-path, cache-ttl, baileys]
status: settled
---

# A profile picture fetched where the row is drawn blocks every list

## Problem

LinkedIn rows had pictures and WhatsApp rows never did: no code path ever set `avatarUrl`. The panel
side was already finished — `ContactAvatar` in `app.tsx` draws `<img>` when a URL is present and
initials (or a group mosaic) when it is not — so the defect was entirely on the source side.

## What Didn't Work

- **Asking `profilePictureUrl` inside `listChats`.** The list is a store read on purpose: it answers
  with the socket down, and the panel polls WhatsApp every 8 seconds. A network call per row inside
  that read makes a fast local read as slow as the slowest IQ, and a failure becomes an error line
  per poll.
- **Letting the picture path call `lifecycle.ensure()`.** That is what a download and a send do, and
  it is right for them. For a face it can open a socket the owner did not ask for, and every open is
  a device-slot risk. `getAvatarSocket()` therefore hands out the socket only while it is already
  open.
- **Treating "no picture" as an error.** Baileys answers `undefined` for a person who never set one
  and throws for one whose picture the account may not see. The panel needs the same thing from both:
  initials. What it must not do is ask again on every redraw.

## What Worked

Split the read in two, in `src/whatsapp/avatars.ts`:

1. `url(jid)` answers from `wa_avatars` synchronously — the row draws what is known, now. A row with
   no answer draws initials, as it did before.
2. Anything unknown, or older than `AVATAR_TTL_MS`, is queued and asked in the background through the
   open socket, **one jid at a time**. A page of fifty rows is a queue, not fifty concurrent IQs.

The answer is stored with `fetched_at`, which is what makes both halves work: a `ready` URL is
trusted for a day, a `failed` answer (`undefined` or a throw) for an hour. A stale URL is still
returned while it refreshes — it usually loads, and if it does not, the panel's `onError` turns it
back into initials, so blanking the picture to refresh it is strictly worse.

The URL still passes `src/avatar-url.ts` before the panel sees it, and that allowlist already
admitted `*.whatsapp.net` (`pps.whatsapp.net` is where Baileys' picture links live), so no widening
was needed.

## Pitfalls worth keeping

- A row's picture is **cached state**, so `clear_cache` removes it — it is re-asked, unlike the
  account state, which a clear may not touch.
- A LID → phone merge carries the fresher picture to the surviving jid and deletes the loser, or the
  dead jid is asked about forever.
- `decorate(item)` in the adapter is the one place a WhatsApp row becomes the panel's shape, so it is
  where the picture is attached and where the allowlist is applied — not in the transport, which
  keeps exactly what WhatsApp said.
