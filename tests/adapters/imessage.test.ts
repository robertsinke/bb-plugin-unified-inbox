// Messages: send and local read state are enabled; archive is refused. Media
// and attachments open through the Messages-specific entry point. The imsg
// client is stubbed and the attachment is a temporary file, never a real one.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { harness, refused, IMSG_ID, WHATSAPP_ID } from './harness.ts';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lK3Q6wAAAABJRU5ErkJggg==', 'base64');

test('Messages: declared capabilities match what action and its attachment entry point accept', async () => {
  const home = await mkdtemp(join(tmpdir(), 'inbox-imsg-'));
  const attachments = join(home, 'Library/Messages/Attachments', 'a');
  await mkdir(attachments, { recursive: true });
  const photo = join(attachments, 'photo.png');
  await writeFile(photo, PNG);

  const previousHome = process.env.HOME;
  process.env.HOME = home;
  const h = harness({
    imsgHistory: () => ({
      messages: [{
        id: 1, guid: 'g-1', sender: '+15551234567', sender_name: 'Ada', text: 'Hello',
        created_at: '2024-01-01T00:00:00Z', is_from_me: false,
        attachments: [{ filename: photo, mime_type: 'image/png', total_bytes: PNG.length }],
      }],
    }),
  });
  try {
    const adapter = h.registry.imessage;
    const caps = adapter.capabilities();
    assert.deepEqual(caps, { send: true, markRead: true, archive: false, invitations: false, media: true, attachments: true, threads: true, followsList: true });

    // send: true — a reply reaches the stubbed imsg send method.
    h.calls.length = 0;
    assert.deepEqual(await adapter.action('reply', IMSG_ID, { text: 'On my way' }), { status: 'Sent.' });
    assert.deepEqual(h.calls, ['imsg:send']);

    // markRead: true — both directions are local, because Messages has no read state.
    h.calls.length = 0;
    assert.deepEqual(await adapter.action('read', IMSG_ID), { status: 'Marked read.' });
    assert.equal(h.cache.keptUnread('imessage', IMSG_ID), false);
    assert.deepEqual(await adapter.action('unread', IMSG_ID), { status: 'Marked unread.' });
    assert.equal(h.cache.keptUnread('imessage', IMSG_ID), true);
    assert.deepEqual(h.calls, []);

    // archive: false, refused before any source call, whatever the conversation id.
    for (const id of [IMSG_ID, WHATSAPP_ID]) {
      await refused(h.calls, () => adapter.action('archive', id), /not supported for Messages/);
    }

    // media: true and attachments: true — served through the Messages branch of the media request.
    h.calls.length = 0;
    const image = await adapter.media({ kind: 'imsg', chatId: IMSG_ID, messageId: '1', index: 0 });
    assert.deepEqual(h.calls, ['imsg:messages.history']);
    assert.equal(image.mime, 'image/png');
    assert.equal(image.dataUrl, `data:image/png;base64,${PNG.toString('base64')}`);

    // A media request addressed by message id is refused before any source call.
    await refused(h.calls, () => adapter.media({ kind: 'message', id: IMSG_ID, index: 0 }), /opens through its conversation/);

    // Actions outside the declaration are refused.
    await refused(h.calls, () => adapter.action('confirm', IMSG_ID, { text: 'hi' }), /not supported for Messages/);
    await refused(h.calls, () => adapter.action('reject', IMSG_ID, {}), /not supported for Messages/);
  } finally {
    process.env.HOME = previousHome;
    h.close();
    await rm(home, { recursive: true, force: true });
  }
});

/** A chat as `chats.list` answers it: two digits, because one-character tokens are not indexed. */
function chat(index: number) {
  return {
    id: 100 + index,
    name: `Person ${String(index).padStart(2, '0')}`,
    display_name: null,
    identifier: null,
    service: 'iMessage',
    last_message_at: new Date(Date.UTC(2024, 0, 1, 0, 0, index)).toISOString(),
    unread_count: 0,
  };
}

/** `chats.list` as imsg really answers it: the newest `limit` chats, and nothing older. */
function chatsPage(total: number) {
  const all = Array.from({ length: total }, (_, index) => chat(total - 1 - index));
  return (params?: Record<string, unknown>) => {
    const limit = Number(params?.limit ?? 20);
    return { chats: all.slice(0, limit) };
  };
}

test('Messages: an older page is a slice of the whole chat database, and the end says so', async () => {
  const asked: Array<Record<string, unknown> | undefined> = [];
  const h = harness({ imsgChats: params => { asked.push(params); return chatsPage(45)(params); } });
  try {
    const adapter = h.registry.imessage;
    assert.equal(adapter.source.pageSize, 20, 'Messages pages, so it declares how many rows a page is');

    // The newest page asks one row past its own size: a cursor is only offered when a row exists.
    const newest = await adapter.sync({ limit: 20 });
    assert.deepEqual(asked, [{ limit: 21 }]);
    assert.equal(newest.items.length, 20);
    assert.equal(newest.cursor, '20', 'the twenty-first chat really came back, so there is older to show');

    const second = await adapter.list(newest.cursor, { limit: 20 });
    assert.equal(second.items.length, 20);
    const firstPageIds = new Set(newest.items.map(item => item.id));
    assert.deepEqual(second.items.filter(item => firstPageIds.has(item.id)), [], 'page two holds what page one did not');
    assert.equal(second.cursor, '40');

    const last = await adapter.list(second.cursor, { limit: 20 });
    assert.equal(last.items.length, 5);
    assert.equal(last.cursor, undefined, 'the end of the chat database offers nothing older');

    // A second press at the end adds no row at all, rather than repeating the last page.
    const again = await adapter.list('45', { limit: 20 });
    assert.deepEqual(again.items, []);
    assert.equal(again.cursor, undefined);

    // And an older page never rewrites the cache: that is the newest page's, replaced wholesale.
    assert.deepEqual(h.cache.list().map(item => item.id).sort(), newest.items.map(item => item.id).sort());

    // One chat list read for the pages, not one per press: the whole list is what `chats.list` answers.
    const lists = asked.filter(params => params?.limit === 500);
    assert.equal(lists.length, 1, 'page two and page three share one full read');
  } finally {
    h.close();
  }
});

test('Messages: a short chat database offers no cursor, so nothing invents a page', async () => {
  const h = harness({ imsgChats: params => chatsPage(3)(params) });
  try {
    const newest = await h.registry.imessage.sync({ limit: 20 });
    assert.equal(newest.items.length, 3);
    assert.equal(newest.cursor, undefined, 'a page shorter than its limit is the last page');
  } finally {
    h.close();
  }
});

test('Messages: a chat outside the newest page is found by search', async () => {
  const h = harness({ imsgChats: params => chatsPage(45)(params) });
  try {
    const adapter = h.registry.imessage;
    await adapter.sync({ limit: 20 });
    const corpus = await adapter.searchCorpus!();
    assert.equal(corpus.length, 45, 'the corpus is the whole chat database, not the newest page');
    assert.equal(corpus.at(-1)!.item.title, 'Person 00', 'and the oldest chat is in it');

    const { createSearchIndex } = await import('../../src/search-index.ts');
    const index = createSearchIndex({ corpus: async () => corpus, readThread: () => null, onChange: () => {} });
    const found = await index.search('04');
    assert.deepEqual(found.map(row => row.id), ['imessage\u0000104'], 'a chat forty rows past the newest page is a hit');
    assert.equal(index.row('imessage', '104')?.title, 'Person 04');
  } finally {
    h.close();
  }
});
