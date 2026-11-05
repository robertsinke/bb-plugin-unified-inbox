// WhatsApp, proved against a fake transport: no socket, no HTTP, no fixture server. What these
// tests pin is the adapter's side of plan U3 — that a read is answered from stored rows, that a
// group preview is `sender: body` without a second request, that media with no cached bytes is
// reported rather than thrown at the panel, and that no string the owner reads mentions the program
// this source used to depend on.
import assert from 'node:assert/strict';
import test from 'node:test';
import { harness, refused, LINKEDIN_ID, WHATSAPP_GROUP_ID, WHATSAPP_ID } from './harness.ts';

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

test('WhatsApp: declared capabilities match what action and media accept', async () => {
  const h = harness();
  try {
    const adapter = h.registry.whatsapp;
    const caps = adapter.capabilities();
    assert.deepEqual(caps, { send: true, markRead: true, archive: false, invitations: false, media: true, attachments: false, threads: true, followsList: true });

    // send: true — one transport call, and a chat id is all it needs, so a group works the same way.
    h.calls.length = 0;
    assert.deepEqual(await adapter.action('reply', WHATSAPP_ID, { text: '  On my way  ' }), { status: 'Sending.' });
    assert.deepEqual(h.calls, ['whatsapp:sendText']);
    await assert.rejects(adapter.action('reply', WHATSAPP_ID, { text: ' ' }), /Sending needs the text to send/);

    // markRead: true — the read mark is recorded, and the panel's own kept-unread mark is cleared.
    h.calls.length = 0;
    assert.deepEqual(await adapter.action('read', WHATSAPP_ID), { status: 'Marked read.' });
    assert.deepEqual(h.calls, ['whatsapp:markRead']);
    h.calls.length = 0;
    assert.deepEqual(await adapter.action('unread', WHATSAPP_ID), { status: 'Marked unread.' });
    assert.deepEqual(h.calls, []);
    assert.equal(h.cache.keptUnread('whatsapp', WHATSAPP_ID), true);

    // archive: false — refused before any transport call, whatever the conversation id.
    for (const id of [WHATSAPP_ID, LINKEDIN_ID]) {
      await refused(h.calls, () => adapter.action('archive', id), /not supported for WhatsApp/);
    }

    // media: true — but nothing is fetched from WhatsApp, so an uncached row says so.
    h.calls.length = 0;
    await assert.rejects(adapter.media({ kind: 'message', id: 'm1', index: 0 }), /no image or video/);
    assert.deepEqual(h.calls, ['whatsapp:loadMedia']);

    // attachments: false — an attachment-shaped request is refused without a transport call.
    await refused(h.calls, () => adapter.media({ kind: 'attachment', id: 'm1', filename: 'photo.png' }), /no attachments/);
    await refused(h.calls, () => adapter.media({ kind: 'imsg', chatId: WHATSAPP_ID, messageId: '1', index: 0 }), /no attachments/);
  } finally {
    h.close();
  }
});

test('WhatsApp: list is newest-first from the store, with a group preview that names the sender', async () => {
  const page = (cursor?: string) => cursor
    ? { chats: [{ jid: WHATSAPP_GROUP_ID, name: 'Builders', kind: 'group' as const, lastMsgAt: 1_600_000_000_000, preview: { text: 'Ship it', fromMe: false, sender: 'Grace' }, unread: 0 }] }
    : {
      chats: [
        { jid: WHATSAPP_ID, name: 'Ada', kind: '1:1' as const, lastMsgAt: 1_700_000_000_000, preview: { text: 'See you', fromMe: true, sender: '' }, unread: 1 },
        { jid: WHATSAPP_GROUP_ID, name: 'Builders', kind: 'group' as const, lastMsgAt: 1_600_000_000_000, preview: { text: '[system]', fromMe: false, sender: '' }, unread: 0 },
      ],
      cursor: '2',
    };
  const asked: Array<{ cursor?: string; limit: number }> = [];
  const h = harness({
    whatsapp: {
      async listChats(input) {
        asked.push(input);
        return page(input.cursor);
      },
    },
  });
  try {
    const adapter = h.registry.whatsapp;

    const first = await adapter.list(undefined, { limit: 50 });
    assert.deepEqual(asked, [{ limit: 50 }]);
    assert.deepEqual(first.items.map(item => [item.id, item.title, item.preview, item.unread, item.date]), [
      [WHATSAPP_ID, 'Ada', 'See you', true, 1_700_000_000_000],
      // A group row is `sender: body` from the stored row itself, and a protocol stub is no preview.
      [WHATSAPP_GROUP_ID, 'Builders', '', false, 1_600_000_000_000],
    ]);
    assert.equal(first.cursor, '2', 'the store said another page exists, so the panel may offer it');
    assert.deepEqual(first.errors, []);

    const older = await adapter.list('2');
    assert.deepEqual(asked.at(-1), { cursor: '2', limit: 50 }, 'the cursor travels back as the store pages by it');
    assert.equal(older.items[0].preview, 'Grace: Ship it', 'a group preview names who wrote it, with no second request');
    assert.equal(older.cursor, undefined, 'the last page offers nothing older');
    assert.deepEqual(h.cache.list().map(item => item.id), [WHATSAPP_ID, WHATSAPP_GROUP_ID], 'an older page never rewrites the cache');
  } finally {
    h.close();
  }
});

test('WhatsApp: open returns stored messages oldest-first, and an empty thread is not an error', async () => {
  const opened: Array<{ id: string; limit: number }> = [];
  const rows = [
    { id: 'm1', chatJid: WHATSAPP_ID, fromMe: false, ts: 1_700_000_000_000, type: 'text', text: 'See you', sender: 'Ada', edited: false },
    { id: 'm2', chatJid: WHATSAPP_ID, fromMe: true, ts: 1_700_000_001_000, type: 'text', text: 'On my way', sender: '', edited: true },
    { id: 'm3', chatJid: WHATSAPP_ID, fromMe: false, ts: 1_700_000_002_000, type: 'image', text: '', sender: 'Ada', edited: false, media: { messageId: 'm3', kind: 'image' as const, cached: false, available: true } },
    { id: 'm4', chatJid: WHATSAPP_ID, fromMe: false, ts: 1_700_000_003_000, type: 'system', text: 'You joined', sender: 'Ada', edited: false },
  ];
  const h = harness({
    whatsapp: {
      async openChat(input) {
        opened.push(input);
        return input.id === WHATSAPP_ID ? rows : [];
      },
    },
  });
  try {
    const adapter = h.registry.whatsapp;

    const opened1 = await adapter.open(WHATSAPP_ID);
    assert.deepEqual(opened, [{ id: WHATSAPP_ID, limit: 60 }], 'a thread is the newest sixty stored rows');
    assert.deepEqual(opened1.messages.map(m => [m.sender, m.text, m.fromMe, m.edited]), [
      ['Ada', 'See you', false, undefined],
      ['You', 'On my way', true, true],
      ['Ada', '', false, undefined],
    ], 'a protocol stub is filtered, and a picture with no caption is an empty bubble, not a type label');
    assert.deepEqual(opened1.messages[2].media, { messageId: 'm3', kind: 'image', cached: false, available: true });
    assert.deepEqual(h.cache.readThread('whatsapp', WHATSAPP_ID)?.length, 3, 'the panel cache keeps what the open returned');

    const empty = await adapter.open('nobody@s.whatsapp.net');
    assert.deepEqual(empty.messages, [], 'a conversation with no stored rows answers an empty list');
  } finally {
    h.close();
  }
});

test('WhatsApp: media is served from cached bytes, and every miss is reported without throwing at the panel', async () => {
  const answers: Record<string, unknown> = {
    cached: { info: { messageId: 'm1', kind: 'image', cached: true, available: true, mime: 'image/png' }, bytes: PNG_BYTES },
    unavailable: { info: { messageId: 'm1', kind: 'image', cached: false, available: false } },
    gone: { info: { messageId: 'm1', kind: 'image', cached: false, available: true } },
    huge: { info: { messageId: 'm1', kind: 'video', cached: true, available: true, mime: 'video/mp4' }, bytes: new Uint8Array(30 * 1024 * 1024 + 1) },
  };
  const h = harness({
    whatsapp: {
      async loadMedia(messageId) {
        return answers[messageId] as never;
      },
    },
  });
  try {
    const adapter = h.registry.whatsapp;

    const image = await adapter.media({ kind: 'message', id: 'cached', index: 0 });
    assert.equal(image.mime, 'image/png');
    assert.equal(image.dataUrl, `data:image/png;base64,${Buffer.from(PNG_BYTES).toString('base64')}`);

    await assert.rejects(adapter.media({ kind: 'message', id: 'unavailable', index: 0 }), /no longer available/);
    await assert.rejects(adapter.media({ kind: 'message', id: 'gone', index: 0 }), /could not be loaded/);
    await assert.rejects(adapter.media({ kind: 'message', id: 'huge', index: 0 }), /too large to play/);
  } finally {
    h.close();
  }
});

test('WhatsApp: no message the owner reads names the program this source used to need', async () => {
  // The panel shows whatever an adapter throws as the source's error line, so a stale name here is
  // a bug the owner sees: it points at a program that no longer has anything to do with WhatsApp.
  const h = harness({
    whatsapp: {
      async listChats() { throw new Error('This is not a transport failure.'); },
      async openChat() { throw new Error('This is not a transport failure.'); },
      async loadMedia() { throw new Error('This is not a transport failure.'); },
      async markRead() { throw new Error('This is not a transport failure.'); },
      async sendText() { throw new Error('This is not a transport failure.'); },
    },
  });
  try {
    const adapter = h.registry.whatsapp;
    const messages: string[] = [];
    for (const run of [
      () => adapter.list(),
      () => adapter.open(WHATSAPP_ID),
      () => adapter.media({ kind: 'message', id: 'm1', index: 0 }),
      () => adapter.action('read', WHATSAPP_ID),
      () => adapter.action('reply', WHATSAPP_ID, { text: 'hi' }),
      () => adapter.action('archive', WHATSAPP_ID),
      () => adapter.media({ kind: 'attachment', id: 'm1', filename: 'x' }),
    ]) {
      try { await run(); } catch (error) { messages.push((error as Error).message); }
    }
    assert.ok(messages.length >= 3, 'the refusals are what carry text a person reads');
    for (const message of messages) assert.doesNotMatch(message, /whatsagent|mcp|127\.0\.0\.1|loopback/i);
  } finally {
    h.close();
  }
});
