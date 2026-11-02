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

**Slice C is done.** Drafts stay a toolbox primitive rather than a source
capability: the box appears for every conversation that is a sequence of
messages (WhatsApp, Messages, and now LinkedIn), the draft is kept in local
storage keyed by account and conversation, and only the send control depends on
the source's declaration. `canCompose` became `canSend`, because drafting never
needed the source. LinkedIn therefore gets a working draft box with the send
control absent and an explicit line saying so. Gmail keeps its own document
draft form.

**Slice E and F are done and wired.** `f7de939`-style units landed as
`ff2efd4` (media) and `09bea35` (delta probe); the wiring is `5ccd973`.

- Media: the thread read keeps a message's `renderContent`, so a photo travels
  as a `licdn.com` URL and a shared post as a link to its activity. The `media`
  RPC now takes an account (WhatsApp remains the default) and answers from the
  adapter that owns the message; images keep the inbox's 6 MiB bound, refuse
  redirects, and need no session. A shared post has no thumbnail in the payload,
  so the inbox shows "Open shared post" rather than an invented image.
- Delta: `sync` probes for `lastActivityAt`, unread totals, row counts, and
  invitations, and keeps the cached rows when nothing moved. Measured on the
  running plugin: a real read 3.85 s, a skip 1.53-1.62 s (2.1 s before the probe
  was trimmed).
- The probe is now one round: the marker remembers the signed-in mailbox, so the
  identity request is gone, and the invitation view starts before the conversation
  window and settles alongside it. Timed inside the page it is 1.25 s, all of it
  LinkedIn's own `messengerConversations` response; that is the floor for a check
  that still notices a new message. Dropping the invitation request would save
  little (it overlaps) and would let a new invitation wait for the next full read.
- The probe had been comparing zeros to zeros: its payload came back inside the
  page's `{ok, payload}` envelope, so every probe parsed as an empty inbox and
  every refresh skipped. It now unwraps through the same path as the other reads,
  which also makes a failed page throw instead of reading as empty. Verified by
  nudging the stored marker: the next refresh reads in full, then skips again.

Verified live: 21 LinkedIn rows, both shared posts in the Andrea thread now carry
their activity link. No inbox message currently carries a photo, so the photo
path is proven by unit tests against real payload shapes and awaits a live photo.

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

| Action | Effect on the account | Gate | Status |
|---|---|---|---|
| reply | Sends a real LinkedIn message | The composer is the owner's own action, like Messages; a failed send reports uncertainty and never retries | Done: captured from a real reply, builder byte-for-byte against the capture, composer wired |
| accept / ignore invitation | Irreversible relationship state | Owner picks the invitation; never automatic | Done: both captured, chip wired, token from the read payload |
| mark read | Clears an unread badge | The one cheap write; reversible | Done: captured, built, verified live both directions |

Acceptance: one real action of each kind, verified against LinkedIn's own UI,
with the recorded request documented in `docs/research/linkedin/`. Reply and mark
read are documented there; the send guard for *driver-initiated* clicks additionally
requires an allowlisted recipient and a conversation the page itself confirms.

What the capture taught that no plan survives: LinkedIn's writes are not GraphQL at
all but REST (`createMessage`, an entity patch for read state), and a thread URL
names the short conversation key, not the full urn.

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

### The last behavioural account branches (done)

`app.tsx` no longer decides behaviour by asking which source it is looking at. Three
declarations replace the last of it, each owned by the source that knows the answer:

| Branch that was there | Declaration | Who declares it |
|---|---|---|
| `threaded = chat \|\| account==='linkedin'` | `threads` | Gmail false (a document); the other four true |
| composer recognises `account==='whatsapp'` and its proposal | `confirmSend` | WhatsApp true (propose, then confirm) |
| re-open skips `account==='linkedin'` | `followsList` | LinkedIn false (a read costs seconds) |

The proposal also stopped carrying the name of its source: it carries the account it
belongs to, so cancelling it after switching conversations cannot address the wrong one.
What remains by name in `app.tsx` is presentation (which surface renders a name, which
icon a source gets); the last dispatch — `sync` picking `linkedin_sync` over `list_source` —
was absorbed by the registry (`fbf7bee`, one `sync` RPC, every adapter answers it).

### Group sends: the inbox was on the wrong endpoint (done)

Found while proving the WhatsApp path: the agent's `propose-send` tool refuses
`chat.kind !== '1:1'` (WhatsAgent R8 — the *drafting agent* stays out of groups; AE4 keeps
groups writable by the owner). So every group row offered a composer whose send the backend
denied, and the owner saw the transport string.

The fix needed **no WhatsAgent change**: the owner's composer path already existed over
loopback as `POST /api/chats/:jid/messages`, dispatching `send` with `caller: 'frontend'`
to the single paced outbox, with no group restriction. The inbox had been reaching for the
agent's tool because that is the tool-shaped surface; the composer path is the right one
for text the owner typed. `confirmSend` is gone with it — nothing is approved but the
owner's own sentence, so the two-click "Review this message / Don't send" flow is retired
and every source in the inbox now sends on one click. Verified live with a message to the
owner's Test-bb group.

## Slice G — UI tests and bubble standardisation

- Add a jsdom-based render test for the row and the chat bubble: same message,
  three sources, asserting the shared bubble class and the source accent.
- One bubble base (width, radius, padding, time placement, contrast) plus a
  per-source accent (tint, radius nudge, tail), so provenance is visible without
  three visual languages.

Acceptance: the render test fails if a source stops using the shared base, and
the three sources are visually comparable at the same width.

**Shipped** (`0218814`, `3959843`, and the schema fix `fed43bd`). `src/inbox-appearance.ts` owns `BUBBLE_BASE` and `bubbleClass(account)`;
the base class in `chat.css` carries geometry only (max-width 440, radius 15px, padding 9/11/7, time
bottom-right) and each source sets one `--ui-accent`, which tints the outgoing background and the
sender name. The four claims in `tests/inbox-appearance.test.ts` are: the five sources share the
base and differ only in accent, every accent a bubble can carry has a rule in `chat.css` (so a new
source cannot render unaccented), no component holds a literal `ui-bubble` class, and no two
sources share an accent. Live at 1000px: WhatsApp 50 bubbles `#25d366`, Messages 37 `#007aff`,
LinkedIn 6 `#0a66c2`, all at width 381–384px with radius 15px and padding 9/11/7.

Two defects fell out of doing this, both older than the slice:

- **LinkedIn was drawn as mail documents.** It declares `threads: true` and has a composer, but the
  layout was decided by account name (`whatsapp || imessage`), so LinkedIn conversations used the
  document renderer — which is why "one bubble, three sources" could not have held. The layout now
  reads the capability (`3959843`), and the chat region is labelled from the account instead of a
  two-account ternary that called a LinkedIn thread "WhatsApp messages".
- **`send_audit` refused its own allowed rows.** The gate writes a reason only when it refuses, so
  an allowed row carries `reason: null`, which the output schema required to be a string. The
  plugin's error counter showed 273 failed calls. Only a real send triggers it, which is exactly
  when the log matters; the schema now says nullable and a contract test pins both shapes.

Not done, deliberately: the list row keeps its single `ui-row` base and no accent. It already names
its source with an icon and an account label, and a second accent system there would be a fourth
visual language rather than fewer.

## Order and risk

A (done) → B (unblocks C–G) → F (cheap, read-only) → E (read-only) → C (local
only) → D (writes; needs a real target each time) → G.

D is last on purpose: it is the only slice that can change the owner's real
account state, and it should be built on the toolbox rather than inside the
branchy dispatch it is meant to replace.

## Mail is written in the composer, not in a form above the thread

Reply, reply all, forward and new message all open one form in the slot a chat reply uses
(`cba1c51`): To, Cc, Bcc, Subject and the body, with the same Discard and send controls. Before this
there were two identical mail forms — one under the conversation header, one above the list — and a
new message floated a form over the inbox. Now a new message takes the panel: account choice, then
the composer.

A blind copy needed the whole chain to carry it: `MailDraft` → `send_gmail` → the gmail adapter →
`buildGmailMime`. Two things were easy to get wrong and are pinned by tests: nodemailer strips `Bcc`
from the generated headers unless its root MIME node is told to keep it (right for an SMTP envelope,
wrong for Gmail, which delivers to the headers of the raw message we hand it), and a draft stored
before bcc existed must still read — as an empty blind copy, not as a lost draft.

**The reason the compose view would not open, and why earlier checks looked flaky.** The bar's ⋯
took the whole menu down whenever a refresh was in flight, and the inbox refreshes on a heartbeat
every few seconds — so `New`, `Send log` and every row action were unreachable for most of the time
the panel was open (`e7d87e7`). What I had twice written off as a flaky test harness was this: the
menu opened, the item existed, and the item was `disabled`. The menu now stays openable and the
actions that must not run mid-flight guard themselves — the session refuses `mark` while busy, and
`refresh` skips a source it is already reading.
