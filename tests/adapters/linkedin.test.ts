// LinkedIn: the read mark is the one write, replayed from the request the page
// itself sent for the same menu item; every other write is refused at the adapter
// boundary — for a LinkedIn id and for ids from other sources alike.
// Media is true: a photo is fetched from LinkedIn's CDN, and a shared post answers
// with its link because it has no thumbnail.
import assert from 'node:assert/strict';
import test from 'node:test';
import { harness, refused, IMSG_ID, LINKEDIN_ID, WHATSAPP_ID } from './harness.ts';
import { createSendGate, type AuditRow } from '../../src/adapters/policy.ts';
import { isMessageSend, linkedinReactWrite, linkedinReplyWrite, linkedinSendWrite, markReadWrite } from '../../src/linkedin-write.ts';
import { LINKEDIN_WALK_START } from '../../src/linkedin-page.ts';
import { message } from '../../src/rpc-contract.ts';

const REFUSAL = /still need their own recorded actions/;
const CONVERSATION = LINKEDIN_ID;
const PHOTO_URN = 'urn:li:msg_message:(urn:li:msg_conversation:(urn:li:fsd_profile:ACoAAme,2-YWJj),2-cGhvdG8=)';
const POST_URN = 'urn:li:msg_message:(urn:li:msg_conversation:(urn:li:fsd_profile:ACoAAme,2-YWJj),2-cG9zdA==)';
const TEXT_URN = 'urn:li:msg_message:(urn:li:msg_conversation:(urn:li:fsd_profile:ACoAAme,2-YWJj),2-dGV4dA==)';
const REACT_URN = 'urn:li:msg_message:(urn:li:fsd_profile:ACoAAAexampleProfileId0000000000000001,2-MTc5MzUwMDI5ODg3MmIyMjAzNi0xMDAmZDViYmEwOTQtNDlhNC00M2M0LTkyNTEtNjZlODQ0YTdmZDU4XzAxMg==)';
const PHOTO = 'https://media.licdn.com/dms/image/v2/D4E22AQphoto/900/0/1700000000000?e=1&v=beta&t=sig900';
const POST = 'https://www.linkedin.com/feed/update/urn:li:activity:7123456789012345678/';
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

/** The cache a conversation open leaves behind: rows from the list, messages from the thread. */
function cachedConversation(h: ReturnType<typeof harness>) {
  h.cache.save('linkedin', [{ account: 'linkedin', id: CONVERSATION, title: 'Ada', preview: 'Photo', date: 1_700_000_000_000, unread: false }]);
  h.cache.saveThread('linkedin', CONVERSATION, [
    { id: PHOTO_URN, sender: 'Ada', text: '', date: 1, fromMe: false, media: { messageId: PHOTO_URN, kind: 'image', cached: false, available: true, url: PHOTO } },
    { id: POST_URN, sender: 'Ada', text: '', date: 2, fromMe: false, link: POST },
    { id: TEXT_URN, sender: 'Ada', text: 'Hello', date: 3, fromMe: false },
  ]);
}

/** The CDN answer for one photo, and the URLs that were asked for. */
function cdn(body: Uint8Array = PNG, contentType = 'image/png') {
  const urls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    urls.push(String(url));
    return { ok: true, status: 200, headers: new Headers({ 'content-type': contentType, 'content-length': String(body.byteLength) }), arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) };
  }) as unknown as typeof fetch;
  return { urls, restore: () => { globalThis.fetch = original; } };
}

test('LinkedIn: declared capabilities match what action and media accept', async () => {
  const h = harness();
  try {
    const adapter = h.registry.linkedin;
    assert.deepEqual(adapter.capabilities(), { send: true, markRead: true, archive: false, invitations: true, media: true, attachments: false, threads: true, followsList: false, react: true, reactRemove: true, quoteReply: true, pollVote: false });

    // send: true through the reply action — there is still no generic send method, because a
    // LinkedIn reply needs its conversation.
    assert.equal(adapter.send, undefined);
    assert.deepEqual(await adapter.action('reply', LINKEDIN_ID, { text: 'hi' }), { status: 'Sent.' });
    await refused(h.calls, () => adapter.action('reply', 'not-a-conversation', { text: 'hi' }), /cannot receive a reply/);

    // markRead: true — the read mark replays the recorded request the page itself sent for the
    // same menu item. archive: false still refuses, and the refusal names the boundary.
    assert.deepEqual(await adapter.action('read', LINKEDIN_ID), { status: 'Updated.' });
    assert.deepEqual(await adapter.action('unread', LINKEDIN_ID), { status: 'Updated.' });
    await refused(h.calls, () => adapter.action('archive', LINKEDIN_ID, { text: 'hi' }), REFUSAL);
    // An invitation answer needs the read's own params; a conversation id is not an invitation.
    await refused(h.calls, () => adapter.action('confirm', LINKEDIN_ID), /cannot be answered/);
    await refused(h.calls, () => adapter.action('reject', LINKEDIN_ID), /cannot be answered/);

    // media: true, but only for a message a cached conversation holds; nothing to
    // serve costs no source call either.
    await refused(h.calls, () => adapter.media({ kind: 'message', id: PHOTO_URN, index: 0 }), /Open this LinkedIn conversation again/);
    await refused(h.calls, () => adapter.media({ kind: 'message', id: 'not-a-message-urn', index: 0 }), /Open this LinkedIn conversation again/);

    // attachments: false — an attachment-shaped request is refused without a source call.
    await refused(h.calls, () => adapter.media({ kind: 'attachment', id: PHOTO_URN, filename: 'photo.png' }), /no attachments/);
    await refused(h.calls, () => adapter.media({ kind: 'imsg', chatId: CONVERSATION, messageId: '1', index: 0 }), /no attachments/);

    // The boundary is the conversation id, not the source: a read mark asks the page only for a
    // conversation urn of LinkedIn's own shape, and every other id is refused without reaching it.
    for (const id of [WHATSAPP_ID, IMSG_ID, 't1']) {
      await refused(h.calls, () => adapter.action('read', id), /cannot be marked/);
      await refused(h.calls, () => adapter.action('archive', id), REFUSAL);
    }
  } finally { h.close(); }
});

test('LinkedIn: a thread read keeps the parsed message id, a reaction replays the captured request, and a reply names that message', async () => {
  const h = harness({
    linkedInThread: async () => ({
      messages: [
        { id: TEXT_URN, sender: 'Ada', text: 'Hello', date: 1, fromMe: false },
        { id: REACT_URN, sender: 'Ada', senderUrn: 'urn:li:fsd_profile:ACoAAAexampleProfileId0000000000000001', text: 'Hello', date: 1_793_500_298_872, fromMe: false },
        { sender: 'Ada', text: 'No id', date: 1_793_500_298_873, fromMe: false },
      ],
    }),
  });
  try {
    const opened = await h.registry.linkedin.open(CONVERSATION);
    assert.equal(opened.messages[0].messageId, TEXT_URN);
    assert.equal(Object.hasOwn(opened.messages[0], 'reactions'), false);
    assert.equal(opened.messages[1].messageId, REACT_URN);
    assert.equal(Object.hasOwn(opened.messages[1], 'senderUrn'), false);
    assert.equal(Object.hasOwn(opened.messages[2], 'messageId'), false);
    assert.equal(Object.hasOwn(opened.messages[2], 'reactions'), false);
    const caps = h.registry.linkedin.capabilities();
    assert.equal(caps.react, true);
    assert.equal(caps.reactRemove, true);
    assert.equal(caps.quoteReply, true);
    h.calls.length = 0;
    assert.deepEqual(await h.registry.linkedin.action('react', CONVERSATION, { messageId: REACT_URN, emoji: '👍' }), { status: 'Sent.' });
    assert.deepEqual(await h.registry.linkedin.action('react', CONVERSATION, { messageId: REACT_URN, emoji: '👍', remove: true }), { status: 'Sent.' });
    assert.deepEqual(h.calls, ['linkedin:write:replay', 'linkedin:write:replay']);
    const set = linkedinReactWrite(REACT_URN, '👍');
    const removed = linkedinReactWrite(REACT_URN, '👍', true);
    assert.equal(set?.url.endsWith('reactWithEmoji'), true);
    assert.equal(removed?.url.endsWith('unreactWithEmoji'), true);
    await refused(h.calls, () => h.registry.linkedin.action('react', CONVERSATION, { messageId: TEXT_URN, emoji: '👍' }), /needs the message it reacts to/);
    await refused(h.calls, () => h.registry.linkedin.action('react', CONVERSATION, { messageId: REACT_URN, emoji: '‼️' }), /not one of the four reactions/);
    await refused(h.calls, () => h.registry.linkedin.action('react', 'not-a-conversation', { messageId: REACT_URN, emoji: '👍' }), /cannot take a reaction/);
    await refused(h.calls, () => h.registry.linkedin.action('reply', CONVERSATION, { text: 'hi', messageId: TEXT_URN }), /Open this LinkedIn conversation again/);
    h.calls.length = 0;
    assert.deepEqual(await h.registry.linkedin.action('reply', CONVERSATION, { text: 'reply test', messageId: REACT_URN }), { status: 'Sent.' });
    assert.deepEqual(h.calls, ['linkedin:write:replay']);
    const reply = linkedinReplyWrite({ conversationUrn: CONVERSATION, text: 'reply test', messageUrn: REACT_URN, sentAt: 1_793_500_298_872, senderUrn: 'urn:li:fsd_profile:ACoAAAexampleProfileId0000000000000001', quotedText: 'Hello' });
    assert.match(reply?.body ?? '', /repliedMessageContent/);
  } finally { h.close(); }
});

test('LinkedIn: a photo is served from the CDN through the media path', async () => {
  const h = harness();
  const stub = cdn();
  try {
    cachedConversation(h);
    const payload = await h.registry.linkedin.media({ kind: 'message', id: PHOTO_URN, index: 0 });
    assert.equal(payload.mime, 'image/png');
    assert.match(payload.dataUrl ?? '', /^data:image\/png;base64,/);
    // The browser read is never repeated for a thumbnail.
    assert.deepEqual(h.calls, []);
    assert.deepEqual(stub.urls, [PHOTO]);
  } finally { stub.restore(); h.close(); }
});

test('LinkedIn: a shared post answers with its link and fetches nothing', async () => {
  const h = harness();
  const stub = cdn();
  try {
    cachedConversation(h);
    assert.deepEqual(await h.registry.linkedin.media({ kind: 'message', id: POST_URN, index: 0 }), { dataUrl: '', mime: '', url: POST });
    assert.deepEqual(stub.urls, []);
  } finally { stub.restore(); h.close(); }
});

test('LinkedIn: a message with no picture and no post has no media to serve', async () => {
  const h = harness();
  const stub = cdn();
  try {
    cachedConversation(h);
    await assert.rejects(h.registry.linkedin.media({ kind: 'message', id: TEXT_URN, index: 0 }), /carries no media/);
    assert.deepEqual(stub.urls, []);
  } finally { stub.restore(); h.close(); }
});

// A recorded send is a delivery no approval authorised: the page confirmed the conversation and
// the caller confirmed the exact action. The gate records it — before delivering, with no
// approval id — so an agent-driven LinkedIn send is in the send log while a panel send is.
// server.ts composes exactly this: message sends go through `observe`, read marks do not.
test('LinkedIn: a replayed message send leaves one allowed row with no approval, before it delivers', async () => {
  const h = harness();
  const rows: AuditRow[] = [];
  const store = {
    spendChecks: 0,
    record(row: AuditRow) { rows.push(row); },
    hasSpent() { store.spendChecks += 1; return false; },
  };
  let delivered = 0;
  const replay = (write: ReturnType<typeof linkedinSendWrite>) => createSendGate({ now: () => 1_700_000_000_000, store }).observe(
    { account: 'linkedin', conversationId: CONVERSATION, reason: 'Delivered by a LinkedIn replay: the page confirmed the conversation and the caller confirmed it with confirm: true.' },
    async () => { delivered += 1; return h.registry.linkedin.replay!({ write: write!, conversationId: CONVERSATION, confirm: true }); },
  );
  try {
    const write = linkedinSendWrite(CONVERSATION, 'On my way');
    assert.ok(write && isMessageSend(write, CONVERSATION), 'the write the transport records is the message send it reads');
    assert.deepEqual(await replay(write), { ok: true, status: 200 });
    assert.equal(delivered, 1);
    assert.ok(h.calls.includes('linkedin:write:replay'), 'the adapter really replayed it');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].decision, 'allowed');
    assert.equal(rows[0].approvalId, undefined, 'a replay is delivered, never approved');
    assert.match(String(rows[0].reason), /confirm: true/);
    assert.equal(store.spendChecks, 0, 'and it never reads spend, so it cannot use an approval up');
    // A read mark is the other write `linkedin_replay` accepts, and it delivers no message: the
    // transport records only what `isMessageSend` claims, which is why this one leaves no row.
    const marking = markReadWrite(CONVERSATION, true);
    assert.ok(marking && !isMessageSend(marking, CONVERSATION), 'a read mark is not a send');
  } finally { h.close(); }
});

// --- walking back: one shape, no cache write ------------------------------------------------
// The newest page is the cache, and it says a walk exists without paying for its cursor. An older
// page is one live read. It is drawn, never saved: `cache.save` replaces an account's rows
// wholesale, so an older page stored that way would wipe the newest one it was walking behind.
const OLDER = 'urn:li:msg_conversation:(urn:li:fsd_profile:ACoAAme,2-older)';

/** The cache's writer, counted, so "this page cached nothing" is proven rather than assumed. */
function countingSaves(h: ReturnType<typeof harness>) {
  const saved: string[] = [];
  const save = h.cache.save.bind(h.cache);
  h.cache.save = (account, items) => { saved.push(account); return save(account, items); };
  return saved;
}

test('LinkedIn: the newest page offers the walk without reading the page', async () => {
  const h = harness();
  try {
    h.cache.save('linkedin', [{ account: 'linkedin', id: CONVERSATION, title: 'Ada', preview: 'Hello', date: 1_700_000_000_000, unread: false }]);
    h.calls.length = 0;
    const page = await h.registry.linkedin.list();
    assert.deepEqual(page.items.map(row => row.id), [CONVERSATION]);
    assert.deepEqual(h.calls, [], 'the newest page is the cache: no browser, no GraphQL');
    assert.equal(page.cursor, LINKEDIN_WALK_START, 'and it promises a page behind it');
  } finally { h.close(); }
});

test('LinkedIn: an older page is one read, and it is not cached', async () => {
  const h = harness({ linkedInOlder: () => ({ conversations: [{ id: OLDER, title: 'Grace Hopper', preview: 'Older note', date: 1_600_000_000_000, unread: false }], nextCursor: 'NEXT+/=' }) });
  try {
    h.cache.save('linkedin', [{ account: 'linkedin', id: CONVERSATION, title: 'Ada', preview: 'Hello', date: 1_700_000_000_000, unread: false }]);
    const saved = countingSaves(h);
    h.calls.length = 0;
    const page = await h.registry.linkedin.list('CUR+/=');
    assert.deepEqual(h.calls, [`linkedin:older@CUR+/=/20`], 'one page, at the size the source declares');
    assert.deepEqual(page.items, [
      { account: 'linkedin', id: OLDER, title: 'Grace Hopper', preview: 'Older note', date: 1_600_000_000_000, unread: false },
    ]);
    assert.equal(page.cursor, 'NEXT+/=', 'the page hands back where the next one begins');
    assert.deepEqual(saved, [], 'an older page writes nothing: the newest page stays the newest page');
    assert.deepEqual(h.cache.list().map(row => row.id), [CONVERSATION], 'and the rows on screen are the newest page still');
  } finally { h.close(); }
});

test('LinkedIn: a page with no cursor ends the walk, and a source with nothing to show never starts one', async () => {
  const h = harness({ linkedInOlder: () => ({ conversations: [{ id: OLDER, title: 'Grace', preview: '', date: 1_600_000_000_000, unread: false }], nextCursor: '' }) });
  try {
    assert.equal((await h.registry.linkedin.list()).cursor, undefined, 'an empty cache has no page behind it to promise');
    h.cache.save('linkedin', [{ account: 'linkedin', id: CONVERSATION, title: 'Ada', preview: 'Hello', date: 1_700_000_000_000, unread: false }]);
    const page = await h.registry.linkedin.list(LINKEDIN_WALK_START);
    assert.equal(page.cursor, undefined, 'the last page answers no cursor, so `more` answers false');
    assert.deepEqual(page.items.map(row => row.id), [OLDER]);
  } finally { h.close(); }
});

test('LinkedIn: a sync answers where the walk starts too, so either read can seed it', async () => {
  const h = harness();
  try {
    const synced = await h.registry.linkedin.sync();
    assert.equal(synced.cursor, LINKEDIN_WALK_START);
  } finally { h.close(); }
});

const ACTIVITY = 'urn:li:activity:7123456789012345678';
const ACTIVITY_B = 'urn:li:activity:7123456789012345679';

function shareThread(messages: unknown[]) {
  return harness({
    linkedInThread: async () => ({ messages }),
    linkedInPost: async (urn: string) => ({ title: `Post ${urn}`, author: 'Ada', imageUrl: urn === ACTIVITY ? PHOTO : '' }),
  });
}

test('LinkedIn: opening a share reads the post once and keeps the card on the next open', async () => {
  const h = shareThread([{ id: POST_URN, sender: 'Ada', text: 'See this', date: 2, fromMe: false, activityUrn: ACTIVITY }]);
  const stub = cdn();
  try {
    const opened = await h.registry.linkedin.open(CONVERSATION);
    const card = opened.messages[0];
    assert.equal(card.text, 'See this');
    assert.equal(card.link, POST);
    assert.deepEqual(card.share, { title: `Post ${ACTIVITY}`, author: 'Ada', hasImage: true });
    const stored = h.cache.readThread('linkedin', CONVERSATION) as Array<{ imageUrl?: string }>;
    assert.equal(stored[0]?.imageUrl, PHOTO);
    const parsed = message.parse({ ...card, imageUrl: PHOTO });
    assert.equal('imageUrl' in parsed, false);
    assert.equal(parsed.share?.title, `Post ${ACTIVITY}`);
    h.calls.length = 0;
    const again = await h.registry.linkedin.open(CONVERSATION);
    assert.equal(again.messages[0].share?.title, `Post ${ACTIVITY}`);
    assert.deepEqual(h.calls.filter(call => call.startsWith('linkedin:post')), []);
    h.cache.save('linkedin', [{ account: 'linkedin', id: CONVERSATION, title: 'Ada', preview: 'See this', date: 2, unread: false }]);
    const shown = await h.registry.linkedin.media({ kind: 'message', id: POST_URN, index: 0 });
    assert.match(shown.dataUrl ?? '', /^data:image\/png;base64,/);
    assert.equal(shown.url, undefined);
    assert.deepEqual(stub.urls, [PHOTO]);
  } finally { stub.restore(); h.close(); }
});

test('LinkedIn: two shares are read one after the other', async () => {
  const order: string[] = [];
  const h = harness({
    linkedInThread: async () => ({ messages: [
      { id: POST_URN, sender: 'Ada', text: '', date: 1, activityUrn: ACTIVITY },
      { id: TEXT_URN, sender: 'Ada', text: '', date: 2, activityUrn: ACTIVITY_B },
    ] }),
    linkedInPost: async (urn: string) => {
      order.push(`start:${urn}`);
      await Promise.resolve();
      order.push(`end:${urn}`);
      return { title: 'One', author: '', imageUrl: '' };
    },
  });
  try {
    const opened = await h.registry.linkedin.open(CONVERSATION);
    assert.deepEqual(order, [`start:${ACTIVITY}`, `end:${ACTIVITY}`, `start:${ACTIVITY_B}`, `end:${ACTIVITY_B}`]);
    assert.equal(opened.messages[1].share?.hasImage, false);
    assert.equal(opened.messages[1].link?.includes(ACTIVITY_B), true);
  } finally { h.close(); }
});

test('LinkedIn: a failed post read still returns the thread and is not asked again at once', async () => {
  let reads = 0;
  const h = harness({
    linkedInThread: async () => ({ messages: [{ id: POST_URN, sender: 'Ada', text: '', date: 1, activityUrn: ACTIVITY }] }),
    linkedInPost: async () => { reads += 1; throw new Error('LinkedIn 404 for /voyager/api/feed/updates/'); },
  });
  try {
    const opened = await h.registry.linkedin.open(CONVERSATION);
    assert.equal(opened.messages[0].link, POST);
    assert.equal(opened.messages[0].share, undefined);
    await h.registry.linkedin.open(CONVERSATION);
    assert.equal(reads, 1);
  } finally { h.close(); }
});

test('LinkedIn: a list sync does not read posts', async () => {
  const h = harness();
  try {
    await h.registry.linkedin.sync();
    assert.equal(h.calls.some(call => call.startsWith('linkedin:post')), false);
  } finally { h.close(); }
});

test('LinkedIn: a share with no stored image still answers with its link', async () => {
  const h = harness();
  const stub = cdn();
  try {
    cachedConversation(h);
    assert.deepEqual(await h.registry.linkedin.media({ kind: 'message', id: POST_URN, index: 0 }), { dataUrl: '', mime: '', url: POST });
    assert.deepEqual(stub.urls, []);
  } finally { stub.restore(); h.close(); }
});

test('LinkedIn: a page that fails is one phrased failure, and nothing is half-kept', async () => {
  const h = harness({ linkedInOlder: () => { throw new Error('LinkedIn needs you to sign in again. Run `bb unified-inbox linkedin-signin` to sign in to LinkedIn once.'); } });
  try {
    h.cache.save('linkedin', [{ account: 'linkedin', id: CONVERSATION, title: 'Ada', preview: 'Hello', date: 1_700_000_000_000, unread: false }]);
    const saved = countingSaves(h);
    await assert.rejects(h.registry.linkedin.list(LINKEDIN_WALK_START), /sign in again/);
    assert.deepEqual(saved, []);
  } finally { h.close(); }
});
