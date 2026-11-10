---
title: "LinkedIn writes: what is recorded, and how a replay is allowed"
status: current
date: 2026-11-10
---

# LinkedIn writes: what is recorded, and how a replay is allowed

LinkedIn's GraphQL writes are unversioned and their shapes move. This plugin therefore never authors
a mutation. It records one real action performed through the visible UI, replays exactly that
request, and lets the effect be observed. Anything the recorded template does not explain is
refused, and the answer to a refusal is always "record the action again", never "guess".

## What a send click must prove

A driver-initiated send click requires `{ allow: 'send' }` plus a target the page itself confirms:
in a compose box, the approval names the recipient and the chips must be exactly that one person;
in an open thread, the approval names the conversation and the page's own URL must show it (either
the full urn or the short key). A page that disagrees refuses the click before anything is
dispatched.

This exists because of a concrete failure, 2026-11-02: a name search for the owner's own name
offered a relative with the same name, the first suggestion was clicked, and three "note to self"
messages went to that relative. Nothing in the code checked who the page said it was addressing;
only an assumption did. The owner deleted them. The first fix ringfenced sends to one allowlisted
person while the recorder was being proven; once testing ended the owner asked for the fence to go,
and what remains is the part that is correctness rather than ringfencing — the approval names the
target, and the page must agree. The composer path was never ringfenced: it is the owner's own
action, the same trust as Messages.

## Why the recorder reported "no writes" while it was recording

Two separate faults, both of which looked like an empty buffer:

1. **A bare-array dump.** `recordedWritesExpression()` returned `[...]` while the adapter read
   `answer.writes`, so every dump answered `undefined` and rendered as `writes: []`. The recorder
   had stored the request; the read-out dropped it. The page expressions now all answer with an
   object, and a test asserts the `writes` key because the value alone cannot show the shape.
2. **A backslash eaten by a template literal.** Page expressions are TypeScript template literals,
   so `\s` reached the page as `s`: `/^remove\s+(.+)$/` became `/^removes+(.+)$/`, and the recipient
   chips that gate a send were invisible. Patterns written for the page need `\\s`, and the emitted
   source is now asserted.

The counters that made this visible stay in place: a dump reports `pushed` and `stored` beside
`skipped`, so "the wrapper was never called", "the filters rejected it", and "it was stored but the
read-out lost it" are three different answers instead of one.

## Mark-read: a REST patch, not a mutation

Captured 2026-11-02 by opening a conversation's options menu and choosing "Mark as read" with the
recorder armed. Two requests went out; only the second is the mark-read template:

```
POST /voyager/api/voyagerMessagingDashMessengerConversations?ids=List(<urn>)
{ "entities": { "<urn>": { "patch": { "$set": { "read": true } } } } }
```

The first is `POST /voyager/api/voyagerMessagingDashMessagingBadge?action=markAllMessagesAsSeen` with
`{"until":<ms>}` — a global badge clear, not a conversation state change, so it is not replayed.

`markReadTarget(write)` accepts exactly the second shape: one entity, one changed field, `read: true`,
the same urn in the query string and in the body. Anything looser is refused rather than replayed.
The urn is compared, never interpolated — the replay re-sends the recorded url and body — so it is
checked for being a conversation id, not for a shape this code would build.

### The proof

1. The conversation's menu offered "Mark as unread", i.e. it was read.
2. Choosing "Mark as unread" changed that to unread — the menu then offered "Mark as read".
3. Replaying the recorded request (`linkedin_replay` with `confirm: true`, no click anywhere)
   returned `status: 200` and a normalized entity result for that urn, and the menu offered
   "Mark as unread" again.

Refusals on the same path: without `confirm` the schema rejects the call, and naming a different
conversation is refused with "The recorded action marks a different conversation as read".

Mark-read is enabled from this shape: `action('read'|'unread')` builds the request and replays it
with the session's own csrf token, and the builder is proven against the captured request byte for
byte. Verified live both directions through the inbox's own action path — the page's menu offered
the opposite action after each call, and the cached row followed.

## Reply: a REST createMessage

Captured 2026-11-02 through a real reply in the visible UI (search, open thread, type, send — each
step through the page driver, the send click approved by name *and* conversation):

```
POST /voyager/api/voyagerMessagingDashMessengerMessages?action=createMessage
{ "message": { "body": { "attributes": [], "text": "<text>" },
               "renderContentUnions": [],
               "conversationUrn": "<urn>",
               "originToken": "<fresh uuid per send>" },
  "mailboxUrn": "<the profile component of the conversation urn>",
  "trackingId": "<opaque blob, replayed as recorded>",
  "dedupeByClientGeneratedToken": false }
```

- The text is the single `text` field; the conversation is the urn; `dedupeByClientGeneratedToken`
  is false, so a fresh `originToken` identifies the send rather than deduplicating it. The builder
  pins a fresh UUID per message and may be pinned to repeat the same logical send.
- `mailboxUrn` is read out of the conversation urn's own profile component — they matched in the
  capture — so nothing about the account is hard-coded.
- `trackingId` is an opaque serialized blob. It is replayed byte for byte as captured, because
  regenerating it would mean guessing a serialization the capture does not explain; it identifies
  analytics, not the message.
- The builder reproduces the captured request byte for byte with the recorded originToken pinned,
  and the recogniser accepts the built send as a message send to its own conversation.

Reply is enabled from this shape: the composer sends through the generic `action` RPC with the
selected account, exactly as Messages does, and a failed answer reports uncertainty and is never
retried. The page driver's allowlist does not apply to the composer — it guards sends the *agent*
initiates through the page, while the composer is the owner's own hands on their own threads.

### How a thread is opened for a capture

A direct `/messaging/thread/<full urn>` URL does not load the conversation. The page's own thread URL
carries the short key — the `2-…` inside the full urn's parentheses — and the honest way in is the
visible one: search the name, open the row the search offers. The send guard compares the approval's
conversation against that key, read down from either form.

## Reaction: reactWithEmoji, and unreactWithEmoji

Captured 2026-11-10 in one open thread, on the owner's own "test message", through the message's
emoji control. Setting 👍 sent this. Removing that same 👍 sent the second request. The message
was left without the reaction.

```
POST /voyager/api/voyagerMessagingDashMessengerMessages?action=reactWithEmoji
{"messageUrn":"<urn:li:msg_message:(mailbox,key)>","emoji":"👍"}

POST /voyager/api/voyagerMessagingDashMessengerMessages?action=unreactWithEmoji
{"messageUrn":"<urn:li:msg_message:(mailbox,key)>","emoji":"👍"}
```

The message urn is `urn:li:msg_message:(<mailbox>,<key>)`. It is not a conversation urn. The body
has those two fields in that order and no origin token. The emoji field is the reaction, so the
four shared reactions fill that field. Heart, dislike, and laugh were not each clicked. A targeted
## Reply to one message: createMessage with repliedMessageContent

Captured 2026-11-10 by choosing Reply on one message and sending. The request is the same
`createMessage` as a conversation reply. The difference is one `repliedMessageContent`:

```
POST /voyager/api/voyagerMessagingDashMessengerMessages?action=createMessage
{ "message": { "body": { "attributes": [], "text": "<reply>" },
    "renderContentUnions": [{ "repliedMessageContent": {
      "originalSenderUrn": "urn:li:msg_messagingParticipant:<profile urn>",
      "originalSendAt": <ms>,
      "originalMessageUrn": "<message urn>",
      "messageBody": { "_type": "com.linkedin.pemberly.text.AttributedText",
        "attributes": [], "text": "<quoted text>",
        "_recipeType": "com.linkedin.1ea7e24db829a1347b841f2dd496da36" } } }],
    "conversationUrn": "<conversation urn>", "originToken": "<fresh uuid>" },
  "mailboxUrn": "<profile urn from the conversation>",
  "trackingId": "<opaque blob, replayed as recorded>",
  "dedupeByClientGeneratedToken": false }
```

The sender urn, the time, and the quoted text come from the message the thread read already holds.
A reply with no message id stays the plain send.

## Invitation ignore: an RSC action, not voyager

Captured 2026-11-02 by clicking "Ignore an invitation to connect from Grace Hopper" on
`/mynetwork/`, approved by name through the page driver. The page confirmed: "Invitation ignored —
I don't know Grace."

```
POST /flagship-web/rsc-action/actions/server-request
     ?sduiid=com.linkedin.sdui.requests.mynetwork.addaInvitationAction&parentSpanId=<tracing>
{ "requestId": "com.linkedin.sdui.requests.mynetwork.addaInvitationAction",
  "serverRequest": { "requestedArguments": { "payload": {
      "inviteeActionType": "InviteeActionType_IGNORE",
      "invitationType": "GenericInvitationType_CONNECTION",
      "invitationUrn": { "invitationId": "<numeric id>" },
      "validationToken": "<per-invitation token from the invitations payload>",
      "origin": "InvitationOrigin_INVITATION_PREVIEW",
      "restoreOnServerFailure": false,
      "postActionSentConfigs": [],
      "profileUrn": { "profileId": "<the inviter's profile>" } } } } }
```

What the capture taught:

- LinkedIn's writes are not all under `/voyager/api/`; the invitation actions go through the
  server-driven-UI action endpoint. The recorder's boundary is now the origin, not a path prefix —
  an earlier accept was lost to exactly that assumption (the counters said 22 path-skips and the
  click had visibly worked).
- `validationToken` is per-invitation, so an adapter action cannot synthesize this request from the
  id alone: the read path must keep what the invitations payload carries, or the action must replay
  a recorded request — which only reaches the one invitation that was recorded. The honest wiring
  is the read carrying the token; that design is still open.
- `parentSpanId` is tracing noise; `onClientRequestFailureAction` is the client's own failure toast.
- The accept is the same request with `InviteeActionType_ACCEPT` — captured 2026-11-02 too, from
  a real accept (Ada Lovelace, owner's pick), and the builder reproduces both captures byte for
  byte with the per-request randomness pinned.

## Opening a thread marks it read

`app.tsx` already did this for every source behind `canMarkRead`: opening a conversation whose row is
unread calls `action('read')` for it, and only then flips the row and the open conversation locally.
LinkedIn inherits it from the `markRead` capability, with no account branch anywhere.

Verified live 2026-11-02 on a real unread conversation: `action('read')` → `Updated.`, the inbox row
flipped to read, LinkedIn's own unread count fell 2 → 1, and the row stayed read across a full
re-read. The UI path adds nothing on top — it is the same call, gated by the same flag.

## The invitation chip, wired

The `validationToken` question settled the wiring: it is the `sharedSecret` field of the same
received-invitations payload the read path already fetches (confirmed by sampling the payload's
field names, nothing else). The read now keeps, per invitation, the sharedSecret, the inviter's
profile id, and the person's first name for the toast text; the adapter builds the same request the
page's own button sends, so any invitation the inbox shows can be answered — never a replay of one
recorded invitation. The `invitations` capability declares it, and the invitation chip answers itself: hovering it — or
focusing it from the keyboard — reveals a split Accept | Ignore pair, in the list row and in the open
invitation alike. The chip sits beside the row's open button rather than inside it, because buttons
cannot nest and the answer has to be a real control.

The replay validator followed the recorder: the origin is the boundary, not a path prefix, because
the invitation actions live outside voyager. Same-hostile checks stay — scheme, protocol-relative,
traversal, control characters.

Every LinkedIn write this inbox can make is now built from a real capture: reply, mark read,
invitation accept, invitation ignore, a reaction, removing a reaction, and a reply to one message. Slice D's
observation-first acceptance is met for all of them.
