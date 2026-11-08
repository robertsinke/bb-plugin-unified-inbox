Gmail mailboxes, WhatsApp, Messages, and LinkedIn behind one inbox tab, beside
the thread you are already working in.

## How to read this repo

Four kinds of document, and they age at different speeds. Read the first for behaviour, the rest for reasons:

| document | answers | is it current? |
|---|---|---|
| this file, and `README.md` | how it works now | **yes — maintain it** |
| `decisions/` | why a choice was made | frozen; each opens with a `Verified against the code` date and a current-state note when a detail moved (`decisions/README.md`) |
| `specs/` | how a feature was scoped | historical once shipped; opens with a status block |
| `docs/plans/`, `docs/research/` | how work was planned, what was measured | historical; a finished plan says "Superseded", a closed research path says what closed it |

If a decision and the code disagree, the code wins and the decision needs a current-state note, not an edit.

## What you get

- An **Inbox** tab on the thread's right side panel: the sources in one list,
  the open conversation beside them, and `#` in any composer to tag one into
  a thread.
- Gmail: read, archive, read/unread, a reply / reply-all / forward / new-mail
  composer that sends, and the sender's Google contact photo in the list where
  the contacts grant allows it — initials otherwise, and `README.md` says how
  to re-consent. A Gmail account id is the mailbox address after a profile
  read publishes the email-named credential file. Until that file exists,
  `gmail-personal` and `gmail-business` still serve, with their existing From
  addresses.
- WhatsApp through the plugin's own socket: paired on this plugin's BB
  settings page by scanning a QR, not from the inbox tab. Replies to a person
  or a group, photos, stickers, video, documents, and mark-read.
- Local Messages through `imsg`: the latest conversations, their messages and
  attachments, a reply into an open conversation, and an inbox read dot. Marking
  a chat read clears that dot here. The Messages app still shows its own unread
  count.
- LinkedIn: DMs, InMail and pending invitations, with reply, read mark, and
  invitation accept or ignore.
- A new message asks the Decisions plugin one yes/no per recent line, then
  keeps the highest score: does that conversation need attention? The row shows
  Needed, None, or Unclear. The ask is the list snippet plus at most the last 32
  stored lines, and a line that already has a score is not asked again. A LinkedIn invitation is not asked. The conversations already in
  the inbox are judged once.
- An open chat message shows reactions and quote text when the source returned
  them. Heart, like, dislike, and laugh are the reactions where the source can
  set one. A reply can target that one message where the source can. Gmail
  keeps its mail composer.

## How it works

Connect happens on the BB settings page for this plugin. The installer supplies
one Desktop OAuth client id and secret there. A Gmail account id is the mailbox
address after a profile read publishes the email-named credential file. Until
that file exists, `gmail-personal` and `gmail-business` still serve, with their
existing From addresses. WhatsApp pairing is on the settings page, not the
inbox tab. The inbox tells a person to open BB Settings for Unified Inbox when
nothing is connected, and shows that same sentence above the rows when WhatsApp
is unpaired: "Open BB Settings for Unified Inbox to connect an account."
LinkedIn sign-in is a button on that page and still opens the plugin Chrome.
Messages shows status and the install and Full Disk Access instructions. The
plugin does not grant that permission. Refresh tokens stay in the per-mailbox
files. The send gate and the mail-approval settings are unchanged.

Each source is one adapter under `src/adapters/`, and each declares what it can
do — `send`, `markRead`, `archive`, `invitations`, `media`, `attachments`,
`threads`, `followsList`, `react`, `reactRemove`, `quoteReply`. The panel reads those declarations instead of asking
which account it is looking at, so a control appears only where the source
supports it.

The send gate (`src/adapters/policy.ts`) records attempts before delivery, without
storing message bodies. Chat sends and compatibility-mode legacy mail mint a new approval from the caller's
`allow: 'send'` flag on each request; this is not verified human approval and does
not prevent a caller requesting another send. Mail also accepts enrolled-key
envelopes through `send_gmail`: exact parameters and file bytes are bound, and a
unique spend plus audit commit before dispatch. Empty inbox pins reject all keys.
The default is compatibility, so the old mail panel still works; Require mode
must wait for the Home/panel signing handoff. Bad envelopes never fall back to
legacy consent. [Mail approval contract](docs/mail-approval.md) covers settings,
read-only readiness/status, error codes and recovery. LinkedIn page clicks and replays
use a recording-only path, with no approval id. Sends stay enabled pending the
isolated authority: [decision 0005](decisions/0005-keep-sends-enabled-until-verified-approval.md)
records the open enforcement gaps and reversal conditions. `npm run check` warns
on allowed attempts without an approval id or with an explicit legacy-mail marker
in the last seven days, with counts and audit row ids; it does not fail on history
or infer approval from unmarked historical UUIDs.
There is no push alert. `bb unified-inbox send-audit [limit]` and the inbox menu's
Send log show attempts, not proof of delivery.

What each source needs, and what stays local: Gmail needs no CLI on the machine. The
plugin reads and sends over HTTPS with a credential it owns — one file per mailbox
in `~/.bb/plugins/unified-inbox/gmail-credentials`, mode
0600, holding the OAuth client, the refresh token and the current access token with
its expiry. The file name is the mailbox address after that profile read, and
`gmail-personal.json` or `gmail-business.json` until then. Only `src/gmail-oauth.ts`
reads or writes those files: it renews the token once per account, keeps a rejected
grant's message on the record, and never deletes a record because a grant failed.
An account with no credential file is not a crash: that mailbox's refresh fails
with one scrubbed line naming the account, the panel keeps the rows it has and
marks them as possibly stale, and `bb unified-inbox import-gws-account <account>`
is the optional copy of an existing `gws` config. It is not the only door.
WhatsApp needs no second program: the
plugin opens its own Baileys socket in its own process and keeps the linked
account state in `~/.bb/plugins/unified-inbox/whatsapp-auth` — one 0700 directory
of 0600 files holding AES-256-GCM blobs under a key kept beside them, so the
directory's permissions are the protection rather than the encryption. The panel
never sees those bytes and no RPC returns them. One socket per state directory,
held by a pid lock and stopped when the plugin unloads; a socket opened for a QR
nobody scanned is stopped after ten minutes, while a linked one stays up because
it is how messages arrive. A start that fails says why on the settings page
instead of leaving an account that only looks connected. Scanning a code counts
as a linked device, like WhatsApp Web: WhatsApp prohibits bulk and automated
messaging and has banned linked-device sessions, and the settings page says so
before it draws a code. Messages runs a
supervised `imsg rpc` child and needs Full Disk Access. The settings row shows
that status. The plugin does not grant Full Disk Access and does not install
`imsg`. LinkedIn
is read and written inside a Chrome the plugin starts with its own profile. The
settings button opens that same Chrome. No
cookie store, Keychain entry or session export leaves that browser
(`decisions/0003`). Every source, including LinkedIn, refreshes in a backend
service while the plugin is loaded, even with the inbox closed. Manual refresh
shares the same per-source flight. The `freshness` RPC exposes persisted
`lastAttemptAt`, `lastSuccessAt`, `lastError`, and `cacheFallback`; only a
successful live read or live delta check advances success. Failed refreshes
retain previous rows; `cacheFallback` is true only if that source has cached rows.
Consecutive failures double the retry delay, but it stays near that source's own
cadence — four poll intervals at most, so a source that recovers is retried within
minutes rather than an hour; success restores the source's normal cadence. Manual
refresh does not wait for that retry delay.
The panel reads this state rather than owning sync.

LinkedIn list/probe reads are GET-only, share the browser's operation gate, and
have a 20-second evaluation timeout, so a slow read can delay a queued send by at
most that evaluation window when the browser is already warm. Read failures do
not stop or replace the interactive page or its recorder. Idle shutdown is paused
during operations. Healthy 45-second polling keeps the 90-second-idle Chrome
process running while the plugin is loaded; this is the power/memory cost of
unattended LinkedIn refresh. A failure costs the source one poll interval, and the
backoff above lets Chrome idle out after a few of them.

Opened bodies have independent `updatedAt` timestamps; legacy bodies have unknown
age. `cached_open` and failed Gmail/LinkedIn opens explicitly report
`cacheFallback: true`. A fresh list never certifies cached bodies as current.
Background list refresh never opens or marks conversations read. Refresh stops
when BB or the plugin stops; authentication and provider failures remain visible.
The inbox cache, freshness, unread marks, and send audit live in this plugin's
unencrypted SQLite storage on the BB server, and so do the `wa_*` tables: the
WhatsApp messages with their raw envelopes, chats with the read cursor, contacts
and reactions, written by the plugin's own socket. `clear_cache` empties those
copies along with the cached media — pictures, video and documents — and leaves
the linked account alone. A Gmail attachment or WhatsApp document is served inline
up to 5 MiB; a larger file is written to the owner's Downloads folder instead and
answered with `savedPath`, which the panel reports. The 100 MiB save ceiling exists
only to stop a runaway download, not to decide what the owner may receive.

## For agents

BB registers five read tools and two send tools on the same gateway the panel uses. `inbox_list` browses the cached
conversation list, `inbox_search` requires a query and returns ranked cached excerpts, `inbox_refresh`
updates one source's newest page, `inbox_read` returns messages and media references, and
`inbox_view_attachment` returns one file from that conversation plus its type. A picture comes back as
an image. Any other file comes back inline up to 5 MiB; a larger one comes back as its type, name and
size, without the bytes. The read tools do not send. `inbox_react` sets or removes one reaction
(heart, like, dislike, or laugh) on one message. `inbox_reply` replies to that one message when the
source can target it. Both send through the same action gate as the panel.
A Gmail account id is the mailbox address after a profile read publishes the
email-named credential file. Until that file exists, `gmail-personal` and
`gmail-business` still serve.

One RPC surface, declared once in `src/rpc-contract.ts` (the list is not repeated here, so it cannot fall
behind): reads and the cache, search, `media`, `capabilities` and `sources`, the `action`/`send_gmail` writes,
`send_audit`, and the LinkedIn page driver. Which module owns which of those is `src/CONTEXT.md`. A reply
without `allow: 'send'` is refused and recorded; a refusal is visible in the Send log, not only in a terminal.
Inbox mentions provide conversation context and draft-first instructions, not authorization to send.

Tagging is how a conversation reaches a thread: type `#` in a composer, search by
name or preview, and pick the row. The tag carries the conversation's latest
messages, its id, and the exact call to answer it — a WhatsApp or Messages reply
through `action` with `allow: 'send'`, a Gmail reply as a new `send_gmail` draft,
a LinkedIn reply through `action` against the page. The `+` on an inbox row
inserts the same tag into the thread beside it.
