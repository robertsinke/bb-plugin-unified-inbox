Five mail and chat sources behind one inbox tab, beside the thread you are
already working in.

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

- An **Inbox** page on the sidebar rail: the sources in one list, the open
  conversation on the right, and `#` in any composer to tag one into a thread.
- Personal and business Gmail: read, archive, read/unread, and a reply /
  reply-all / forward / new-mail composer that sends.
- WhatsApp through the plugin's own socket: paired from the tab by scanning a
  QR, replies to a person or a group, photos, stickers, video, documents, and
  mark-read.
- Local Messages through `imsg`: the latest conversations, their messages and
  attachments, and a reply into an open conversation.
- LinkedIn: DMs, InMail and pending invitations, with reply, read mark, and
  invitation accept or ignore.

## How it works

Each source is one adapter under `src/adapters/`, and each declares what it can
do — `send`, `markRead`, `archive`, `invitations`, `media`, `attachments`,
`threads`, `followsList`. The panel reads those declarations instead of asking
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
plugin reads and sends over HTTPS with a credential it owns — one file per account
in `~/.bb/plugins/unified-inbox/gmail-credentials`, named for the account, mode
0600, holding the OAuth client, the refresh token and the current access token with
its expiry. Only `src/gmail-oauth.ts` reads or writes those files: it renews the
token once per account, keeps a rejected grant's message on the record, and never
deletes a record because a grant failed. An account with no credential file is not a
crash: that mailbox's refresh fails with one scrubbed line naming the account, the
panel keeps the rows it has and marks them as possibly stale, and
`bb unified-inbox import-gws-account <account>` copies an existing `gws` config in
once — the one remaining use of that CLI. WhatsApp needs no second program: the
plugin opens its own Baileys socket in its own process and keeps the linked
account state in `~/.bb/plugins/unified-inbox/whatsapp-auth` — one 0700 directory
of 0600 files holding AES-256-GCM blobs under a key kept beside them, so the
directory's permissions are the protection rather than the encryption. The panel
never sees those bytes and no RPC returns them. One socket per state directory,
held by a pid lock and stopped when the plugin unloads; a socket opened for a QR
nobody scanned is stopped after ten minutes, while a linked one stays up because
it is how messages arrive. A start that fails says why to the pairing card
instead of leaving an account that only looks connected. Scanning a code counts
as a linked device, like WhatsApp Web: WhatsApp prohibits bulk and automated
messaging and has banned linked-device sessions, and the card says so before it
draws a code. Messages runs a
supervised `imsg rpc` child and needs Full Disk Access. LinkedIn
is read and written inside a Chrome the plugin starts with its own profile: no
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
the linked account alone.

## For agents

BB registers five read-only tools on the same gateway the panel uses: `inbox_list` browses the cached
conversation list, `inbox_search` requires a query and returns ranked cached excerpts, `inbox_refresh`
updates one source's newest page, `inbox_read` returns messages and media references, and
`inbox_view_image` returns a PNG, JPEG, WebP, or GIF from a reference in that cached conversation.
Stored Gmail account ids are `gmail-personal` and `gmail-business`. These tools do not send.

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
