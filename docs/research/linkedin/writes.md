# LinkedIn writes: what is recorded, and how a replay is allowed

LinkedIn's GraphQL writes are unversioned and their shapes move. This plugin therefore never authors
a mutation. It records one real action performed through the visible UI, replays exactly that
request, and lets the effect be observed. Anything the recorded template does not explain is
refused, and the answer to a refusal is always "record the action again", never "guess".

## The one send that is allowed

`LINKEDIN_SEND_ALLOWLIST` (`src/linkedin-ui.ts`) holds the only people a driver-initiated send may
reach; today it is `andrea sophie stave lepsøe` and nothing else. A send click requires
`{ allow: 'send', recipient: '<name>' }`, the name must match an allowlist entry exactly, and the
compose box's own recipient chips must name that one person. Anything else is refused before a
click is dispatched.

This exists because of a concrete failure, 2026-11-02: a name search for the owner's own name
offered a relative with the same name, the first suggestion was clicked, and three "note to self"
messages went to that relative. Nothing in the code checked who the page said it was addressing;
only an assumption did. The owner deleted them.

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

## What is still uncaptured

One real write has been recorded and read back (a deliberate 404 probe), which proves the path.
What is still uncaptured: an invitation accept or ignore. That is the last LinkedIn write without a
recorded shape, so the invitation chip reports and does not act.
