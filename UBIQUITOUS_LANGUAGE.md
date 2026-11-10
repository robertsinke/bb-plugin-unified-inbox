---
title: Ubiquitous language
description: One word for each thing this inbox is. The code wins if this file disagrees with it.
status: current
date: 2026-11-09
---

# Ubiquitous Language

The words for the product. `src/CONTEXT.md` says which module owns a rule. This file says which word to use.

## The product

| Term | Definition | Aliases to avoid |
| --- | --- | --- |
| **Inbox** | The one list of conversations from every connected source. | Unified view, feed |
| **Owner** | The person who connects sources and reads the inbox. | User, client, installer |
| **Source** | One origin of conversations: Gmail, WhatsApp, Messages, or LinkedIn. | Channel, provider, account |
| **Account** | One connected login of one source. | Profile, identity, mailbox |
| **Settings** | The Unified Inbox page in BB Settings, where an account is connected. | Setup screen, connect page |

## Conversations

| Term | Definition | Aliases to avoid |
| --- | --- | --- |
| **Conversation** | One exchange with one counterpart, inside one account. | Thread, chat, row |
| **Message** | One item inside a conversation. | Text, bubble |
| **Preview** | The one line the list shows for a conversation. | Snippet, subject |
| **Unread** | This inbox's mark that a conversation has a message the owner has not opened here. | Badge, dot |
| **Messages unread** | The unread count that stays in the Messages app. | Unread |

## Attention

| Term | Definition | Aliases to avoid |
| --- | --- | --- |
| **Decision** | The choice that a conversation is Needed or None. It exists only when the Decisions plugin is installed. | Verdict, attention, score |
| **Needed** | The conversation is due a response. | Needs attention, important |
| **None** | The conversation is not due a response. | Clear, done, dismissed |
| **Mute** | The owner's mark on a conversation. The row stays in the list. The Decisions plugin is not asked. | Notification setting, archive, WhatsApp's mute |

## Sending

| Term | Definition | Aliases to avoid |
| --- | --- | --- |
| **Reply** | A send into a conversation that is already open. | Response, answer |
| **Send** | A delivery the send gate allowed. | Post, dispatch |
| **Send gate** | The one check a send must pass. A send without `allow: 'send'` is refused and recorded. | Policy, approval |

## Connection

| Term | Definition | Aliases to avoid |
| --- | --- | --- |
| **Gmail client** | The owner's own Google Desktop OAuth client, pasted into settings. | App, key |
| **Pairing** | The WhatsApp link from a QR code or a phone code. The phone treats it as a linked device. | Login, session |
| **LinkedIn window** | The Chrome window this plugin opens for the one LinkedIn profile. | Browser, cookie |
| **Full Disk Access** | The macOS permission BB needs before Messages can be read. This plugin does not grant it. | FDA, permission |

## Files in a message

| Term | Definition | Aliases to avoid |
| --- | --- | --- |
| **Picture** | A PNG, JPEG, GIF, or WebP shown inside the open message. | Image, attachment, media |
| **Chip** | The control for a file that is not drawn. A click downloads it or says it is in Downloads. | Button, link |
| **Content id** | The `cid:` name of a picture that belongs to the mail. The stored HTML keeps that name. | Inline image, src |

## Relationships

- An **Inbox** lists **Conversations** from up to four **Sources**.
- A **Source** has one **Account** in this plugin.
- A Gmail **Account** is one mailbox address. A WhatsApp **Account** is one number. A LinkedIn **Account** is one profile. A Messages **Account** is the local account on this Mac.
- An **Account** is connected on **Settings**. The inbox does not open **Settings**.
- A **Conversation** belongs to exactly one **Account**.
- A **Decision** says a **Conversation** is **Needed** or **None**.
- A **Mute** keeps that **Conversation** in the list. The Decisions plugin is not asked.
- With no Decisions plugin, the **Decision** does not exist. The menu hides **Needed** and **None**. Old saved choices stay hidden. The owner set this on 2026-11-09.
- A **Reply** is a **Send** into an existing **Conversation**.
- A **Send** on the WhatsApp **Account** can start a **Conversation** when the phone number is confirmed. That send is still a **Send**. It is not a separate kind of thing.
- A **Picture** is drawn in the **Message**. A **Chip** is the control for every other file.
- **Unread** belongs to this **Inbox**. **Messages unread** belongs to the Messages app.

## Example dialogue

> **Dev:** "The **Owner** has no **Account**. Does the **Inbox** show **Needed** and **None**?"
> **Domain expert:** "No. A **Decision** exists only when the Decisions plugin is installed. **Needed** means due a response. **None** means not due a response."
> **Dev:** "WhatsApp and Gmail are different **Sources**. Are they two **Accounts**?"
> **Domain expert:** "Yes. Each **Source** has one **Account**. A second WhatsApp number would be a second **Account**, and this plugin does not have one."
> **Dev:** "The **Owner** marks a mail **Picture** and a PDF. Which one is a **Chip**?"
> **Domain expert:** "The PDF is a **Chip**. The PNG, JPEG, GIF, or WebP is a **Picture**."
> **Dev:** "A **Reply** in Messages clears **Unread**. Does it clear **Messages unread**?"
> **Domain expert:** "No. **Unread** is this inbox. **Messages unread** stays in the Messages app."

## Flagged ambiguities

- **Account** means one connected login of one **Source**. The owner confirmed this on 2026-11-09. "The sources are different" means each **Source** has one **Account**.
- A WhatsApp send to a new phone number was named **New WhatsApp chat**. That name is a screen, not a term. The act is a **Send**. The result is a **Conversation**.
- **Thread** was used for a **Conversation** and for a BB thread. A **Conversation** is one exchange in the inbox. A BB thread is the page beside the inbox. Do not call a conversation a thread.
- **Verdict** is not a product word. Say **Decision**, **Needed**, or **None**.
- **Attention** is not a product word. The Decisions plugin makes the **Decision**. This inbox does not say that name on screen.
- **Unread** was used for this inbox and for the Messages app. **Unread** is this inbox. **Messages unread** is the app.
- **Channel** appears in the attention code for a **Source**. Say **Source**.
- The code field is `needsAttention`. The words on screen are **Needed** and **None**. Say the words.
