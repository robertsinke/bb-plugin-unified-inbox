// WhatsApp, proved against a fake transport: no socket, no HTTP, no fixture server. What these
// tests pin is the adapter's side of plan U3 — that a read is answered from stored rows, that a
// group preview is `sender: body` without a second request, that media with no cached bytes is
// reported rather than thrown at the panel, and that no string the owner reads mentions the program
// this source used to depend on.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SAVE_LIMIT } from '../../src/adapters/media.ts';
import { approvalFor, createSendGate, type AuditRow } from '../../src/adapters/policy.ts';
import { WhatsAppDisconnectedError } from '../../src/whatsapp/send.ts';
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
    assert.deepEqual(await adapter.action('reply', WHATSAPP_ID, { text: '  On my way  ' }), { status: 'Sent.' });
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
    await assert.rejects(adapter.media({ kind: 'message', id: 'm1', index: 0 }), /no media/);
    assert.deepEqual(h.calls, ['whatsapp:mediaFacts'], 'a message with no media is answered before any bytes are asked for');

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

test('WhatsApp: media is served from cached bytes, refused from the declared size, and every miss is reported without throwing at the panel', async () => {
  const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const facts: Record<string, unknown> = {
    cached: { messageId: 'm1', kind: 'image', cached: true, available: true, mime: 'image/png' },
    unavailable: { messageId: 'm1', kind: 'image', cached: false, available: false },
    gone: { messageId: 'm1', kind: 'image', cached: false, available: true },
    // The envelope declares more than a frame will draw: refused without fetching a byte.
    huge: { messageId: 'm1', kind: 'video', cached: false, available: true, size: 30 * 1024 * 1024 + 1 },
    // The envelope declares little and 10 MB arrives: refused, and the bytes are taken back off disk.
    lying: { messageId: 'm1', kind: 'image', cached: true, available: true, mime: 'image/png', size: 10 },
  };
  const answers: Record<string, unknown> = {
    cached: { info: { messageId: 'm1', kind: 'image', cached: true, available: true, mime: 'image/png' }, bytes: PNG_BYTES },
    // A row that says available and served, with no bytes: the file the ref named is gone.
    gone: { info: { messageId: 'm1', kind: 'image', cached: false, available: true } },
    lying: { info: { messageId: 'm1', kind: 'image', cached: true, available: true, mime: 'image/png', size: 10 }, bytes: new Uint8Array(6 * 1024 * 1024 + 1) },
  };
  const discarded: string[] = [];
  const downloaded: string[] = [];
  const h = harness({
    whatsapp: {
      async mediaFacts(messageId) {
        return facts[messageId] as never;
      },
      async loadMedia(messageId) {
        downloaded.push(messageId);
        return (answers[messageId] ?? {}) as never;
      },
      async discardMedia(messageId) {
        discarded.push(messageId);
      },
    },
  });
  try {
    const adapter = h.registry.whatsapp;

    const image = await adapter.media({ kind: 'message', id: 'cached', index: 0 });
    assert.equal(image.mime, 'image/png');
    assert.equal(image.dataUrl, `data:image/png;base64,${Buffer.from(PNG_BYTES).toString('base64')}`);

    await assert.rejects(adapter.media({ kind: 'message', id: 'huge', index: 0 }), /too large to play/);
    assert.deepEqual(downloaded, ['cached'], 'a file the panel will not draw is never downloaded');

    await assert.rejects(adapter.media({ kind: 'message', id: 'lying', index: 0 }), /too large to show/);
    assert.deepEqual(downloaded, ['cached', 'lying'], 'a declared length is a hint, so what lands is checked');
    assert.deepEqual(discarded, ['lying'], 'and the bytes that landed over the ceiling are taken back');

    await assert.rejects(adapter.media({ kind: 'message', id: 'unavailable', index: 0 }), /no longer available/);
    await assert.rejects(adapter.media({ kind: 'message', id: 'gone', index: 0 }), /could not be loaded/);
    assert.deepEqual(discarded, ['lying'], 'a miss is a report, not an eviction');
  } finally {
    h.close();
  }
});

test('WhatsApp: a reply reports what actually happened, and a failure is never silent', async () => {
  // A Baileys failure carries its HTTP-space status in `output.statusCode`; the message text is a
  // payload the owner must never read, which is why the terminal case asserts it is not echoed.
  const boom = (statusCode: number) => Object.assign(new Error(`Baileys said: rejected ${statusCode}`), { output: { statusCode } });
  const seen: Array<{ id: string; text: string }> = [];
  const failures: unknown[] = [];
  const h = harness({
    whatsapp: {
      async sendText(input) {
        seen.push(input);
        const failure = failures.shift();
        if (failure) throw failure;
      },
    },
  });
  try {
    const adapter = h.registry.whatsapp;

    // Accepted: the status is what the transport's resolution earns, and the conversation id is
    // the one the message went to rather than something the panel guesses afterwards.
    assert.deepEqual(await adapter.action('reply', WHATSAPP_GROUP_ID, { text: '  Ship it  ' }), { status: 'Sent.' });
    assert.deepEqual(seen, [{ id: WHATSAPP_GROUP_ID, text: 'Ship it' }]);

    // No socket: nothing left the machine, so the panel must not hedge about the outcome.
    failures.push(new WhatsAppDisconnectedError());
    await assert.rejects(adapter.action('reply', WHATSAPP_ID, { text: 'hi' }), /Nothing was sent: WhatsApp is not connected/);

    // 428 is a connection closed mid-send, not a rejection: the text may have arrived. The panel
    // says the outcome is unknown, and one click stays one attempt.
    const before = seen.length;
    failures.push(boom(428));
    await assert.rejects(adapter.action('reply', WHATSAPP_ID, { text: 'hi' }), /outcome is unknown\. Check WhatsApp on your phone/);
    assert.equal(seen.length, before + 1, 'one click is one attempt: no retry, no queue, no second message');

    // An error nobody classified is transient on purpose: calling it a failure would claim a
    // message that may have arrived did not.
    failures.push(new Error('kaboom'));
    await assert.rejects(adapter.action('reply', WHATSAPP_ID, { text: 'hi' }), /outcome is unknown/);

    // A terminal rejection names the class and never echoes what the provider said.
    failures.push(boom(400));
    await assert.rejects(adapter.action('reply', WHATSAPP_ID, { text: 'hi' }), (error: Error) => {
      assert.match(error.message, /WhatsApp refused this message/);
      assert.doesNotMatch(error.message, /Baileys said|rejected 400/);
      return true;
    });

    // Past WhatsApp's own ceiling: refused before the socket, with the number to act on.
    const attempted = seen.length;
    await assert.rejects(adapter.action('reply', WHATSAPP_ID, { text: 'x'.repeat(65_537) }), /Nothing was sent: WhatsApp accepts a message up to 65536 characters/);
    assert.equal(seen.length, attempted, 'an over-long body never reaches the transport');
  } finally {
    h.close();
  }
});

test('WhatsApp: a reply that never left still leaves the gate’s row', async () => {
  // The panel's own path, gate first: the record is written before delivery, so a send lost to a
  // dead socket is on the record rather than only in a line the owner might dismiss.
  const rows: AuditRow[] = [];
  const gate = createSendGate({ now: () => 1_700_000_000_000, store: { record(row) { rows.push(row); }, hasSpent() { return false; } } });
  const h = harness({ whatsapp: { async sendText() { throw new WhatsAppDisconnectedError(); } } });
  try {
    const adapter = h.registry.whatsapp;
    await assert.rejects(
      gate(
        { account: 'whatsapp', conversationId: WHATSAPP_ID, text: 'see you at six' },
        approvalFor('send', WHATSAPP_ID, 1_700_000_000_000),
        () => adapter.action('reply', WHATSAPP_ID, { text: 'see you at six' }),
      ),
      /Nothing was sent/,
    );
    assert.deepEqual(rows.map(row => [row.account, row.conversationId, row.decision]), [['whatsapp', WHATSAPP_ID, 'allowed']]);
    assert.ok(!JSON.stringify(rows).includes('see you at six'), 'the record names the conversation, never the text');
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

test('WhatsApp: an oversized document is refused before it is downloaded, a big one is saved to Downloads, and a small one saves under its own name', async () => {
  const pdf = Buffer.from('%PDF-1.4');
  const facts: Record<string, Record<string, unknown>> = {
    doc: { messageId: 'd1', kind: 'document', cached: false, available: true, mime: 'application/pdf', filename: 'Contract v2.pdf', size: pdf.byteLength },
    unnamed: { messageId: 'd2', kind: 'document', cached: false, available: true },
    huge: { messageId: 'd3', kind: 'document', cached: false, available: true, mime: 'application/zip', filename: 'dump.zip', size: SAVE_LIMIT + 1 },
    lying: { messageId: 'd5', kind: 'document', cached: false, available: true, mime: 'application/zip', filename: 'dump.zip', size: 10 },
    expired: { messageId: 'd4', kind: 'document', cached: false, available: false },
  };
  const answers: Record<string, Record<string, unknown>> = {
    doc: { info: { ...facts.doc, cached: true }, bytes: pdf },
    unnamed: { info: { ...facts.unnamed, cached: true }, bytes: pdf },
    // Declared 10 bytes and 5 MiB+1 arrives: over the inline ceiling, so it lands in Downloads.
    lying: { info: { ...facts.lying, cached: true }, bytes: new Uint8Array(5 * 1024 * 1024 + 1) },
  };
  const discarded: string[] = [];
  const downloaded: string[] = [];
  const downloads = mkdtempSync(join(tmpdir(), 'inbox-downloads-'));
  const downloadsBefore = process.env.UNIFIED_INBOX_DOWNLOADS_DIR;
  process.env.UNIFIED_INBOX_DOWNLOADS_DIR = downloads;
  const h = harness({
    whatsapp: {
      async mediaFacts(messageId) {
        return facts[messageId] as never;
      },
      async loadMedia(messageId) {
        downloaded.push(messageId);
        return (answers[messageId] ?? {}) as never;
      },
      async discardMedia(messageId) {
        discarded.push(messageId);
      },
    },
  });
  try {
    const adapter = h.registry.whatsapp;

    assert.deepEqual(await adapter.media({ kind: 'message', id: 'doc', index: 0 }), {
      dataUrl: `data:application/pdf;base64,${pdf.toString('base64')}`,
      mime: 'application/pdf',
      filename: 'Contract v2.pdf',
      size: pdf.byteLength,
    }, 'the chip saves the file it was sent as, under the name the sender chose');

    assert.deepEqual(
      await adapter.media({ kind: 'message', id: 'unnamed', index: 0 }),
      { dataUrl: `data:application/octet-stream;base64,${pdf.toString('base64')}`, mime: 'application/octet-stream', filename: 'WhatsApp document', size: pdf.byteLength },
      'a document with no name or type still saves, as an unnamed binary file',
    );

    await assert.rejects(adapter.media({ kind: 'message', id: 'huge', index: 0 }), /too large to save/);
    assert.deepEqual(downloaded, ['doc', 'unnamed'], 'a document over the save ceiling is never fetched: its declared size is enough');

    const saved = await adapter.media({ kind: 'message', id: 'lying', index: 0 });
    assert.equal(saved.savedPath?.startsWith(downloads), true, 'a document too large for a data URL is saved to the Downloads folder');
    assert.equal(saved.filename, 'dump.zip');
    assert.equal(existsSync(saved.savedPath ?? ''), true, 'and the file is really there');
    assert.deepEqual(downloaded, ['doc', 'unnamed', 'lying'], 'the declared length is a hint, so what lands is checked');
    assert.deepEqual(discarded, [], 'a saved file is kept, not taken back off the disk');

    await assert.rejects(adapter.media({ kind: 'message', id: 'expired', index: 0 }), /no longer available/);
  } finally {
    h.close();
    if (downloadsBefore === undefined) delete process.env.UNIFIED_INBOX_DOWNLOADS_DIR;
    else process.env.UNIFIED_INBOX_DOWNLOADS_DIR = downloadsBefore;
    rmSync(downloads, { recursive: true, force: true });
  }
});
