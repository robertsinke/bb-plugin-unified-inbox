# Unified Inbox

Unified Inbox lists Gmail, WhatsApp, Messages, and LinkedIn in one tab in BB. You read a conversation, reply where that source can send, and mute a conversation. A muted conversation stays in the list.

Open the inbox from the inbox icon on the right side of a thread.

## Connect

Open BB Settings and choose Unified Inbox.

Gmail uses a Desktop OAuth client that you create in your own Google Cloud project. Paste the client id and the client secret on the settings page. Enable the Gmail API and the People API, and add your Google account as a test user. A client that stays in Testing expires after 7 days. Google can show an unverified-app warning on the first sign-in. Choose Add. BB opens a sign-in in the system browser.

A Gmail row shows the sender's contact photo when that account can read contacts. Until then, the row shows initials. Google has no photo-only scope, so the contact scopes read the whole contact. The settings sign-in asks for those scopes. If you already sign in with `gws`, use the steps in [docs/operator.md](docs/operator.md).

WhatsApp connects from a QR code on the settings page. The phone treats that link as a linked device, in the same way as WhatsApp Web. A phone code is available when a scan is not. Pairing spends one of the account's linked-device slots. Remove the link from the settings page. If you delete the plugin's WhatsApp login files, WhatsApp forgets this device, and the next scan uses another slot. The file location is in [docs/operator.md](docs/operator.md).

LinkedIn sign-in opens a Chrome window that belongs to this plugin. Sign in there. A shared post in an open chat shows the post's words and picture. The list still says "Shared a post". In an open chat, hover a message to react with a heart, a like, a dislike, or a laugh, or to reply to that message.

Messages reads the local Messages database through imsg. Install imsg on the Mac, and grant BB Full Disk Access. This plugin does not install imsg, and it does not grant that permission.

When nothing is connected, the inbox tells you to open BB Settings.

## Use

You can search by name, preview, or sender. A match opens like any other conversation.

Type `#` in a BB composer, search, and pick a conversation. The tag gives the agent that conversation when you send. The tag does not allow the agent to send.

Before inbox text reaches an agent or the attention model, the plugin masks email addresses and phone numbers locally. This is best effort: it can miss values or mask unrelated text. Names remain visible. The inbox screen and stored messages stay unchanged. Original attachments can still contain personal data. An agent may need to reopen a conversation after a plugin restart because protected references expire.

A Gmail send asks you to confirm first. A WhatsApp reply sends from the panel as you.

A PNG, JPEG, GIF, or WebP image in a mail message is shown in that message. Other files stay download chips. A file that is too large to show is saved in your Downloads folder. The inbox menu has a Send log.

## Limits

The unread count in the Messages app stays in the Messages app. This inbox keeps its own unread mark.

WhatsApp does not list an archived chat. A PDF and an SVG stay download chips.

Install this plugin only on a BB server and on clients that you trust. The plugin stores conversation titles and previews on that machine.

People who change this plugin start from the file AGENTS.md. Commands for an existing `gws` login, the send log, and a cache clear are in [docs/operator.md](docs/operator.md).
