---
title: "Next slices: one toolbox, source adapters, and the writes we turned on"
status: current
date: 2026-11-02
---

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

**Attachments in the draft** (`15990d6`). Two ways in, one of them the existing primitive: a file the
owner picks lives only in the page (base64, never through the server until a send), and a file
already in the conversation is pulled through `media` — the same RPC the message renderer uses — so a
forward stops silently dropping what it forwards. The session owns the limit (20 files, 10 MB per
draft) and refuses with a reason in the composer instead of a silent no-op. A draft with a file and
no words is worth sending, so `sendMail` now requires words *or* an attachment. The bytes travel
`MailDraft` → `send_gmail` → the gmail adapter → the MIME builder as multipart parts; the contract
bounds the array and refuses a filename with a line break. A stored draft keeps the words and never
the bytes, which a test states outright.

Two things fell out of it: forward starts a draft with no thread id, and the composer only accepted
a draft whose thread id matched the open conversation — so **Forward opened nothing at all** from
inside a thread (`c9d…` → `fix(inbox): a forward is written in the conversation it came from`). And
`formatBytes` called a five-byte file "1 KB".

## A render test, and Gmail sending enabled

**The jsdom render test that kept being deferred** (`8e2c464`). The blocker was never jsdom, it was
JSX: the runner strips types but not JSX. `tests/jsdom-harness.ts` transpiles TSX with the TypeScript
that was already a dev dependency — no bundler — resolves the component's own imports, and stubs the
plugin SDK, because the question is what the owner sees. The composer moved to
`src/mail-composer.tsx` as a controlled form (the panel supplies the callbacks), and
`src/composer-mode.ts` holds the decision the forward bug lived in. Four render tests describe the
form; four more describe `composerMode` and `draftForConversation`, including the exact case that
answered "none" and rendered a forward nowhere.

**Gmail sending** (`6cbe4b5`). One line of policy, plus the three things that had to be true first:
`sendMail` states `allow: 'send'` the way a chat reply does, the gate still demands an approval per
conversation and spends it before delivery, and the composer's send control is live exactly when
there is a recipient and a message or file. The two tests that said "Gmail is refused by policy" now
say what every enabled source owes the gate. Live: the control reads "Add a recipient and a message
or file first" on an empty draft, and "Send from Personal Gmail" once the draft can go.

What is *not* proven: no real email has been sent through this path yet. The gate's allowance is
covered by tests, and the last step — one message through Gmail's API — is the owner's to authorise.

## Files dropped on the draft, and the ceiling Gmail actually sets

A child thread (`thr_ii293ud9hj`, commit `4886d6a`) did the drag: `dragover` and `drop` are both
prevented on the form — a browser that is not told otherwise opens the dropped file and the panel is
gone — and a drop arrives through the same `read()` the picker uses, so bytes become base64 in one
place. `is-dropping` tints the border, `dragleave` clears it only when the pointer actually leaves,
and the hidden file input stays the keyboard path with an off-screen hint naming both.

Its second half found the limit that matters: Gmail measures the **encoded** message, so the old
10 MB raw cap refused files the service would take while telling the owner a number nobody enforced.
`session.attach` now sums `ceil(size / 3) * 4` over the draft against 25 MB — see
`decisions/0002-the-ceiling-is-the-encoded-message.md`. Two edges were closed on merge (`e1f5412`):
the panel claims a drag for itself, so a file dropped *beside* the composer no longer navigates away,
and the body is encoded into the same sum because the words travel in the same message.

Proved live on the running panel: a dropped `plan.txt` became a chip, `dragover`/`drop` defaulted
prevented on both the composer and the panel, and the page never navigated. The tint at the instant
of a drag is a batched render, so it is proved in jsdom (`7ef3ff2`) rather than by chasing a browser
under load — the machine was at load 30–86 and sessions kept expiring mid-run.

## The first real Gmail send

Owner-authorised, sent to himself, through the product's own path rather than a test harness: the
`send_gmail` RPC with `allow: 'send'`, which mints the approval, writes the `allowed` row, builds the
MIME and hands it to Gmail.

| step | evidence |
|---|---|
| gate approved | audit row `2026-11-02T16:11:53Z allowed personal personal@example.com` |
| Gmail accepted | RPC returned `Sent.` |
| Gmail delivered | the plugin's own IMAP reader synced the message back, unread, as `1a19d0812bb336e0` |

So the chain is closed end to end: policy, approval, spend-before-delivery, MIME, delivery, and reading
what was delivered. Nothing was special-cased for the test.

What the send corrected afterwards (`c1a3813`): the mention footer still told agents a Gmail thread was
read-only, and two comments still claimed the build keeps mail sending off. The footer now documents the
real call, with the same approval word — the prose had outlived the policy by a day.

## The audit row learns to say who was blind-copied

A send's row named the conversation, the decision and the approval, and nothing about its audience. For
a reply that is enough — the conversation is the audience. For a bcc it is not: a message to yourself
with a blind copy has the same conversation id as one without, so the hidden recipient was the one fact
a send could carry that the log could not explain.

`AuditRow` gains `bcc`, written by the gate (it is the gate's row) from a new `SendRequest.bcc`, and only
when there is one: no blind copy leaves the column empty rather than guessing. The table gains the
column through the same in-place migration that added `approval_id`, the schema allows null so a row
written before today reads as "no copy", and the CLI prints `bcc …` only when it has something to say.

Two tests had to change shape first: the policy test carried **its own copy of the row type**, which is
precisely how a new column goes unnoticed — it imports the gate's type now.

Proved live, not only in tests: a send to `personal@example.com` with `bcc work@example.com`
produced the row `… allowed personal personal@example.com bcc work@example.com`, and the
business account's own sync shows the blind copy arrived there, unread.

## Three children, one assessment

An assessment against the record (specs, plans, decisions, the INBOX tracker, and the code) found the
feature backlog empty and three things left: a trust boundary we knowingly left open, prose that
described a plugin we no longer ship, and no paging. Each went to a child on its own worktree; the
parent merged, and verified live.

**1. The send log sees the LinkedIn writes** (`0ad6e59` merge). `linkin_replay` and a `linkedin_ui` send
click reached the page without passing the gate — no approval, no row — so an agent-driven LinkedIn send
left no trace while a panel send did. The gate now has a second entry point, `observe`, which records
`allowed` with **no `approvalId`** and a reason naming the real authorisation (the page-confirmed target
and the caller's `confirm`), then delivers. No policy, no window, no spend. A read-only `linkedin_ui`
step records nothing — proved live: 11 rows before a snapshot step, 11 after. Recorded in
`decisions/0004-linkin-writes-are-recorded-not-approved.md`.

**2. The docs match the product** (`742c6b7`). `README.md` claimed Gmail reply/compose, group replies
and WhatsApp playback were missing (all shipped) and that LinkedIn never sends (it does). The brief
itself was wrong twice and the child said so: audio/document playback really is missing, and WhatsApp
*unread* really does work. `PLUGIN_OVERVIEW.md` was still the BB "Example todos" template; it now
describes five sources, one gate, and what stays on this machine.

**3. Show older** (`abb5411`, fixed in the merge of `e9a833b`). Gmail's `pageToken`, WhatsAgent's offset,
one `list` call that takes `{older, account}`, a session `more()` that lands each source as it answers,
and a 15-second ceiling so a slow source becomes a line rather than a control that never stops loading.

The first version was correct and unusable: 41 s for an older page, because Gmail fetched the **full body**
of 20 threads per account through a serialized runner. Reading `format: metadata` instead (a row shows
headers, labels, dates, a snippet — never a body), overlapping the reads through a 6-slot pool, and asking
for ten mail rows per press took it to ~3.4 s for both accounts. A page that returns nothing new while the
source still says more now says so, so no press is silent.

Proved live, in the panel, after a reload: 131 rows → **201** on one press (WhatsApp 50, personal 10,
business 10), no error marker. Two things this cost me to learn: the panel renders session errors only as
a marker on the ⋯ menu, and a browser script that polls every 500 ms starves the page it is measuring —
read once after a sleep, not in a tight loop.

### The lesson the audit column taught, one day after it shipped

`bcc` was in the table, printed by the CLI, and invisible in the panel: the `send_audit` output schema
never declared it, and a zod object strips a key it does not know. The test that should have caught it
asserted only that `safeParse` succeeded — which is precisely what a schema that drops the field does.

The schema declares `bcc` and `approvalId` now, and the test **parses and reads the values back**, so a
schema that loses a field fails. `approvalId: null` is the panel's way of saying "delivered, never
approved", which is the whole point of `observe`.

### Two things the children taught the parent

A child that reports "all green, 315/315" has **not necessarily committed anything**: the fourth child's
five files sat uncommitted in its worktree while its branch still pointed at `main`'s parent. The merge
said "Already up to date" and that was almost the end of it. Read `git log <branch> -1` before believing a
report, and if the tip is not the child's work, look for it in the worktree — nothing was lost, because
nothing had been thrown away.

And a bug report about the harness needs the number that moved: the handler counter went from 31 to 44
errors across one working hour in which nothing failed visibly (`docs/bugs/2026-11-03-handler-error-counter-conflates-timeouts.md`).

## 2026-11-03 — the architecture pass, four cards

The review (`architecture-review-20261103-000616.html`, written outside the repo) ranked five deepenings.
Four were implemented by child threads, each proved by `tsc --noEmit` and the suite, each green on its own
branch before the parent merged it onto a settled `main`:

| card | landed as | what it bought |
|---|---|---|
| the handler table behind one seam | `createGateway(deps)` in `src/gateway.ts`, `server.ts` reduced to wiring | 25 handlers now callable in-process; six gateway tests where the only earlier assertion was a regex over `server.ts` as text |
| the panel↔gateway seam typed by the contract | `rpc: Pick<PluginRpcClient<typeof rpcContract>, 'call'>` | a renamed method is a compile error; the hand-written list of two dead method names deleted |
| one conversation identity for LinkedIn | `src/linkedin-conversation.ts` | five regexes for one urn became one; `linkedin-ui` and `linkedin-write` can no longer disagree about the id the gate compares |
| one declaration says what a source is | `Adapter.source` (`label`, `icon`, `pollIntervalMs`, `watchIntervalMs`, `pageSize`), a `sources` RPC, `InboxSnapshot.errors: { account?, kind, message }[]` | four label tables became one per adapter; `Inhouse Gmail` is now the only spelling; clearing an error stops matching text against a label |

Two cards were ranked but not taken, and remain open:

- **The panel decides render facts inside a 116-line JSX return** (`app.tsx`): `filtered`, `chat`,
  `sendable`, `composer`, `group` are only testable by grepping. ADR-0001 named this as its own follow-up.
- **`Message` is a union of five sources' optionals**, so the panel renders by sniffing which are set.
  A contract change, not a refactor; speculative until a sixth source exists.

Measured after the merges: 335/335 tests, `tsc` clean, the live plugin reloaded, `sources` answering with
the five declarations and `sync`/`send_audit` unchanged. The panel was **not** pixel-checked — its render
path is covered by jsdom tests and the data path was proved against the live plugin.
