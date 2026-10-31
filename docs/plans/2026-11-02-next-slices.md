# Next slices: one toolbox, source adapters, and the writes we turned on

Owner decisions on 2026-11-02, taken from the outstanding list:

| # | Decision |
|---|---|
| 1 | Messages sending is **enabled** (overrides the earlier read-only stance). |
| 2 | LinkedIn writes: **go ahead** — reply, accept/ignore an invitation, mark read. |
| 3 | LinkedIn media as labels is not enough: add thumbnails and click-through. |
| 4 | LinkedIn full re-read per refresh: add a delta check. |
| 5 | Drafts for LinkedIn and Messages, in a **source-independent toolbox**. |
| 6 | UI tests for `app.tsx`, starting with the bubble work. |

The architecture note that comes with #5 is the constraint for all of the above:
**one toolbox of primitives — search, read, draft, update, send — and per-source
adapters behind it.** Callers and UI must not branch on `account` to decide what a
primitive means; they ask the toolbox, and the adapter decides how that source
implements it. Today `server.ts` and `app.tsx` branch on `account` in several
places, which is the drift this plan removes.

## Where things stand

- `src/adapters/types.ts` already describes the contract (adapter, capabilities,
  drafts, receipts) but nothing imports it yet: migration state 1 of 3.
- `server.ts` dispatches `action`/`send_gmail` per account inline.
- `app.tsx` renders one composer, WhatsApp-only, inline in a ternary, and hides
  read/unread buttons per account.

## Slice A — Messages send (done in this slice)

`imsg`'s one permitted mutation is `send`; `src/imsg-send.ts` owns validation and
outcome mapping, `server.ts` routes `action: 'reply'` for Messages, and the
composer serves WhatsApp and Messages from one box. Read/unread for Messages is
local-only, because the source has no read state to sync (this is a property of
Messages, not an omission).

Acceptance: validation refuses a non-chat id before the backend, an unconfirmed
send never reports success, and nothing else is enabled.

Verified live: one message sent to the Poke bot chat (id 50), reported `Sent.`,
and the follow-up read of that conversation shows it as an outgoing row. The
send to a person remains the owner's decision each time.

## Slice B — The toolbox and its adapters

1. Registry: `Account → Adapter` (`src/adapters/index.ts`), each adapter exposing
   `capabilities()`, `list`, `open`, `media`, `action`, and where supported `send`.
2. `server.ts` becomes the transport: it validates the RPC input, asks the
   registry, and owns caching, search, error isolation, and policy.
3. `app.tsx` asks for capabilities instead of testing `account ===`.
4. Capabilities drive the UI: a source that cannot send shows no composer; one
   that cannot mark read shows no read toggle.

Acceptance: no `account ===` branch decides behaviour in `server.ts` or
`app.tsx` except the policy layer; existing behaviour unchanged for all five
sources; one test per adapter proving its declared capabilities match what its
`action` actually accepts.

**Slice B is done** (`f7de939`, `d2a204d`, `f93bb73`): registry, capabilities,
frontend driven by declarations, parity tests. See
`docs/plans/2026-11-02-slice-b-work-units.md` for the units and the live parity
numbers.

## Slice C — Drafts as a toolbox primitive

Local-first: a draft is keyed by `(account, conversation id)` and never leaves the
host, so it works for every source including the read-only ones.

- Messages gains it for free once the composer is capability-driven.
- LinkedIn gains it because a draft is not a write to LinkedIn.
- `inbox-drafts.ts` already stores per-account drafts; extend it rather than
  adding a second store.

Acceptance: a draft survives a reload and a source switch, and clearing it is
explicit.

## Slice D — LinkedIn writes

Requires a mechanism decision, because guessing a GraphQL mutation against a real
account is unacceptable:

1. **Bootstrap by observation.** In the browser the plugin already owns, hook
   `window.fetch`/XHR, perform the action once by driving the visible UI
   (`/messaging/thread/<id>/`, type, send), and record the exact request the
   LinkedIn app itself made.
2. **Then call that request directly** from the in-page expression, with the
   session's own csrf token, and verify the effect in the payload before
   reporting success.

Actions and their risk:

| Action | Effect on the account | Gate |
|---|---|---|
| reply | Sends a real LinkedIn message | Explicit owner approval per send, first one verified by hand |
| accept / ignore invitation | Irreversible relationship state | Owner picks the invitation; never automatic |
| mark read | Clears an unread badge | Cheap, but still a write: needs its own opt-in |

Acceptance: one real action of each kind, verified against LinkedIn's own UI,
with the recorded request documented in `docs/research/linkedin/`.

## Slice E — LinkedIn media

- In-page read already sees `renderContent`: a photo or file carries a
  `vectorImage`, a shared post carries only `hostUrnData` (`FEED_UPDATE`).
- Photos and files: serve the CDN thumbnail through the existing media RPC path,
  with the same bounds as the other sources.
- Shared posts: no thumbnail exists in the message payload, so resolve the
  activity to its preview image only if the post payload returns one; otherwise
  show the label with a link that opens the post in the user's browser.

Acceptance: a photo message renders a thumbnail in the open conversation, a
shared post renders a link that resolves, and no request leaves the browser
without the session.

## Slice F — LinkedIn delta check

Today every refresh re-reads 20 conversations plus 20 profile lookups (3–7 s
warm, 10–11 s cold). Replace that with one cheap probe:

- Read the newest conversation's `lastActivityAt` and the unread total
  (`count=1`), compare with the value stored in `inbox_sync`, and skip the full
  read when neither moved.
- Keep the full read for a forced refresh.

Acceptance: an unchanged refresh issues one probe instead of the full read and
keeps the cached rows; a changed one behaves exactly as today.

## Slice G — UI tests and bubble standardisation

- Add a jsdom-based render test for the row and the chat bubble: same message,
  three sources, asserting the shared bubble class and the source accent.
- One bubble base (width, radius, padding, time placement, contrast) plus a
  per-source accent (tint, radius nudge, tail), so provenance is visible without
  three visual languages.

Acceptance: the render test fails if a source stops using the shared base, and
the three sources are visually comparable at the same width.

## Order and risk

A (done) → B (unblocks C–G) → F (cheap, read-only) → E (read-only) → C (local
only) → D (writes; needs a real target each time) → G.

D is last on purpose: it is the only slice that can change the owner's real
account state, and it should be built on the toolbox rather than inside the
branchy dispatch it is meant to replace.
