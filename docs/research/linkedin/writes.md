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

## What is still uncaptured

One real write has been recorded and read back (a deliberate 404 probe), which proves the path.
No LinkedIn *send* request has been captured yet, so `reply` stays unwired and every LinkedIn write
capability other than `media` stays `false`. The next recording should be a real reply to the
allowlisted recipient with the recorder armed; the captured request then becomes the template shape
documented here for reply, accept/ignore, and mark-read.
