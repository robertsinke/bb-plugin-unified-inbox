Five mail and chat sources behind one inbox tab, beside the thread you are
already working in.

## What you get

- An **Inbox** page on the sidebar rail: the sources in one list, the open
  conversation on the right, and `#` in any composer to tag one into a thread.
- Personal and business Gmail: read, archive, read/unread, and a reply /
  reply-all / forward / new-mail composer that sends.
- WhatsApp through the running WhatsAgent backend: replies to a person or a
  group, photos, stickers, video, and mark-read.
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

One send gate sits in front of every send (`src/adapters/policy.ts`). The caller
states `allow: 'send'`; the approval covers one conversation, lasts five minutes
and is spent by its first attempt; the gate writes the row before delivery and
never stores a body. `bb unified-inbox send-audit [limit]` prints those rows,
newest first, and the inbox menu's Send log shows the same list.

What each source needs, and what stays local: Gmail calls the `gws` CLI with
credentials in `~/.config/gws` and `~/.config/gws-inhouse`. WhatsApp attaches to
the WhatsAgent backend on loopback — this plugin never starts or restarts it,
and fails closed when discovery fails rather than opening a second connection.
Messages runs a supervised `imsg rpc` child and needs Full Disk Access. LinkedIn
is read and written inside a Chrome the plugin starts with its own profile: no
cookie store, Keychain entry or session export leaves that browser
(`decisions/0003`), and it refreshes only when asked. The inbox cache — list
rows, opened threads, unread marks, and the send audit — is this plugin's own
unencrypted SQLite storage on the BB server.

## For agents

One RPC surface: `list`, `cached`, `sync`, `open`, `cached_open`, `search`,
`media`, `capabilities`, `sources`, `action`, `send_gmail`, `send_audit`, plus the LinkedIn
page driver (`linkedin_ui`, `linkedin_record`, `linkedin_writes`,
`linkedin_replay`, `linkedin_signin`). A reply without `allow: 'send'` is refused
and recorded; a refusal is visible in the Send log, not only in a terminal.

Tagging is how a conversation reaches a thread: type `#` in a composer, search by
name or preview, and pick the row. The tag carries the conversation's latest
messages, its id, and the exact call to answer it — a WhatsApp or Messages reply
through `action` with `allow: 'send'`, a Gmail reply as a new `send_gmail` draft,
a LinkedIn reply through `action` against the page. The `+` on an inbox row
inserts the same tag into the thread beside it.
