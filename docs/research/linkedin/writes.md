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

Mark-read stays `false` in `capabilities()` anyway: the replay surface needs a recorded write, which
a user action cannot supply, so the inbox UI still has no path to it.

## What is still uncaptured

One real write has been recorded and read back (a deliberate 404 probe), which proves the path.
No LinkedIn *send* request has been captured yet — the three recorded sends left the buffer empty
because of the read-out fault above, and they went to a recipient nobody meant to message — so
`reply` stays unwired and every LinkedIn write capability other than `media` stays `false`. A reply
to the allowlisted recipient with the recorder armed would settle the send template; accept/ignore
still needs its own recording.
