// LinkedIn: the read mark is the one write, replayed from the request the page
// itself sent for the same menu item; every other write is refused at the adapter
// boundary — for a LinkedIn id and for ids from other sources alike.
// Media is true: a photo is fetched from LinkedIn's CDN, and a shared post answers
// with its link because it has no thumbnail.
import assert from 'node:assert/strict';
import test from 'node:test';
import { harness, refused, IMSG_ID, LINKEDIN_ID, WHATSAPP_ID } from './harness.ts';

const REFUSAL = /still need their own recorded actions/;
const CONVERSATION = LINKEDIN_ID;
const PHOTO_URN = 'urn:li:msg_message:(urn:li:msg_conversation:(urn:li:fsd_profile:ACoAAme,2-YWJj),2-cGhvdG8=)';
const POST_URN = 'urn:li:msg_message:(urn:li:msg_conversation:(urn:li:fsd_profile:ACoAAme,2-YWJj),2-cG9zdA==)';
const TEXT_URN = 'urn:li:msg_message:(urn:li:msg_conversation:(urn:li:fsd_profile:ACoAAme,2-YWJj),2-dGV4dA==)';
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
    assert.deepEqual(adapter.capabilities(), { send: true, markRead: true, archive: false, invitations: true, media: true, attachments: false, threads: true, followsList: false });

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
    await refused(h.calls, () => adapter.media('linkedin', PHOTO_URN, 0), /Open this LinkedIn conversation again/);
    await refused(h.calls, () => adapter.media('linkedin', 'not-a-message-urn', 0), /Open this LinkedIn conversation again/);

    // attachments: false — there is no attachment entry point.
    assert.equal(adapter.gmailAttachment, undefined);
    assert.equal(adapter.imsgMedia, undefined);

    // The boundary is the conversation id, not the source: a read mark asks the page only for a
    // conversation urn of LinkedIn's own shape, and every other id is refused without reaching it.
    for (const id of [WHATSAPP_ID, IMSG_ID, 't1']) {
      await refused(h.calls, () => adapter.action('read', id), /cannot be marked/);
      await refused(h.calls, () => adapter.action('archive', id), REFUSAL);
    }
  } finally { h.close(); }
});

test('LinkedIn: a photo is served from the CDN through the media path', async () => {
  const h = harness();
  const stub = cdn();
  try {
    cachedConversation(h);
    const payload = await h.registry.linkedin.media('linkedin', PHOTO_URN, 0);
    assert.equal(payload.mime, 'image/png');
    assert.match(payload.dataUrl, /^data:image\/png;base64,/);
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
    assert.deepEqual(await h.registry.linkedin.media('linkedin', POST_URN, 0), { dataUrl: '', mime: '', url: POST });
    assert.deepEqual(stub.urls, []);
  } finally { stub.restore(); h.close(); }
});

test('LinkedIn: a message with no picture and no post has no media to serve', async () => {
  const h = harness();
  const stub = cdn();
  try {
    cachedConversation(h);
    await assert.rejects(h.registry.linkedin.media('linkedin', TEXT_URN, 0), /carries no media/);
    assert.deepEqual(stub.urls, []);
  } finally { stub.restore(); h.close(); }
});
