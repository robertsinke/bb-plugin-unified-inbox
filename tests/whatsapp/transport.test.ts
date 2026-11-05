// U3 — what answers a WhatsApp read. The transport is proved here against the real store and a
// fake socket: no Baileys socket, no network, no account state.
//
// What these tests pin: a read works with the socket down (the point of the store), the list is
// newest-first and pages by offset, unread counts only messages newer than the read cursor, history
// that was synced is not news, and a send with no socket refuses rather than pretending.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import type { WAMessage } from 'baileys';
import type { WhatsAppConnection } from '../../src/whatsapp/connection.ts';
import { handleMessagesUpsert } from '../../src/whatsapp/ingest.ts';
import type { MediaDownloader } from '../../src/whatsapp/media.ts';
import { WhatsAppDisconnectedError, type WhatsAppSendSocket } from '../../src/whatsapp/send.ts';
import { createWhatsAppStore, type MessageInput, type WhatsAppStore } from '../../src/whatsapp/store.ts';
import { createWhatsAppTransport } from '../../src/whatsapp/transport.ts';

const DM = '15551234567@s.whatsapp.net';
const GROUP = '120363000000000003@g.us';

// `status()` counts the account state in the plugin data dir, so this file points that at an empty
// directory: the answer being pinned is "unpaired", not whether the machine happening to run these
// tests has a live account. No test here writes a byte of real account state.
process.env.UNIFIED_INBOX_WHATSAPP_AUTH = mkdtempSync(join(tmpdir(), 'wa-transport-auth-'));

function fixture() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  const store = createWhatsAppStore(db);
  return { db, store };
}

function message(overrides: Partial<MessageInput> & Pick<MessageInput, 'id' | 'chat_jid' | 'ts'>): MessageInput {
  return { from_me: false, type: 'text', ...overrides };
}

/** A connection that never opened a socket: the state a read finds on a cold plugin. */
const down = () => undefined;

function up(socket: Partial<WhatsAppSendSocket>) {
  const connection = {
    getSendSocket: () => socket as WhatsAppSendSocket,
    status: () => 'connected',
  };
  return () => connection as unknown as WhatsAppConnection;
}

/** A socket that can answer the one media call: asking the phone to upload again. */
function withReupload(updateMediaMessage: (message: WAMessage) => Promise<WAMessage>) {
  const connection = {
    getSendSocket: () => undefined,
    getMediaSocket: () => ({ updateMediaMessage }),
    status: () => 'connected',
  };
  return () => connection as unknown as WhatsAppConnection;
}

/** One stored image with the envelope a download reads, as a live ingest would leave it. */
function storedPicture(store: WhatsAppStore, id = 'IMG1', messageTimestamp = Math.floor(Date.now() / 1000)) {
  handleMessagesUpsert(store, {
    type: 'notify',
    messages: [{
      key: { id, remoteJid: DM, fromMe: false },
      messageTimestamp,
      message: { imageMessage: { mimetype: 'image/jpeg' } },
    } as unknown as WAMessage],
  });
}

test('a read answers with no socket at all: chats newest first, with previews the store already has', async () => {
  const { db, store } = fixture();
  try {
    store.upsertChat({ jid: DM, name: 'Ada', kind: '1:1', last_msg_at: 1_700_000_000_000 });
    store.upsertContact({ jid: '255700000001@s.whatsapp.net', push_name: 'Grace' });
    store.upsertChat({ jid: GROUP, name: 'Builders', kind: 'group', last_msg_at: 1_600_000_000_000 });
    store.upsertChat({ jid: '15559999999@s.whatsapp.net', name: null, kind: '1:1', last_msg_at: null });
    store.upsertMessage(message({ id: 'a1', chat_jid: DM, ts: 1_700_000_000_000, text: 'See you' }));
    store.upsertMessage(message({ id: 'g1', chat_jid: GROUP, ts: 1_600_000_000_000, sender: '255700000001@s.whatsapp.net', text: 'Ship it' }));

    const transport = createWhatsAppTransport({ store, connection: down });
    const page = await transport.listChats({ limit: 50 });

    assert.deepEqual(
      page.chats.map(chat => chat.jid),
      [DM, GROUP, '15559999999@s.whatsapp.net'],
      'newest activity first, and a chat with nothing stored last',
    );
    assert.deepEqual(page.chats[0], {
      jid: DM,
      name: 'Ada',
      kind: '1:1',
      lastMsgAt: 1_700_000_000_000,
      unread: 0,
      preview: { text: 'See you', fromMe: false, sender: '' },
    });
    assert.deepEqual(page.chats[1].preview, { text: 'Ship it', fromMe: false, sender: 'Grace' }, 'a group preview names the sender from the stored contact');
    assert.equal(page.chats[2].preview, undefined, 'a chat with no stored message has no preview to give');
    assert.equal(page.cursor, undefined, 'a short page is the last page');
  } finally {
    db.close();
  }
});

test('the list pages by row offset and offers a cursor only when another page exists', async () => {
  const { db, store } = fixture();
  try {
    for (let index = 0; index < 3; index += 1) {
      store.upsertChat({ jid: `1555123456${index}@s.whatsapp.net`, name: `Person ${index}`, kind: '1:1', last_msg_at: 1_700_000_000_000 - index * 1_000 });
    }
    const transport = createWhatsAppTransport({ store, connection: down });

    const first = await transport.listChats({ limit: 2 });
    assert.deepEqual(first.chats.map(chat => chat.name), ['Person 0', 'Person 1']);
    assert.equal(first.cursor, '2');

    const second = await transport.listChats({ cursor: first.cursor, limit: 2 });
    assert.deepEqual(second.chats.map(chat => chat.name), ['Person 2']);
    assert.equal(second.cursor, undefined, 'a last page does not offer an empty one');
  } finally {
    db.close();
  }
});

test('unread counts only messages newer than the read cursor, and history sync is not news', async () => {
  const { db, store } = fixture();
  try {
    store.upsertChat({ jid: DM, name: 'Ada', kind: '1:1', last_msg_at: 1_700_000_000_000 });
    store.upsertMessage(message({ id: 'm1', chat_jid: DM, ts: 1_000, text: 'older' }));
    // What `handleHistorySet` does for a batch: a chat with no cursor starts read up to its newest.
    store.markChatsRead([DM]);
    store.upsertMessage(message({ id: 'm2', chat_jid: DM, ts: 2_000, text: 'also seen' }));
    const transport = createWhatsAppTransport({ store, connection: down });

    const unread = async () => (await transport.listChats({ limit: 50 })).chats[0].unread;
    assert.equal(await unread(), 1, 'a live message after the cursor is unread');

    store.upsertMessage(message({ id: 'm3', chat_jid: DM, ts: 3_000, text: 'newest' }));
    assert.equal(await unread(), 2);

    // Reading up to the middle leaves the newer one unread; reading the newest clears both.
    store.markRead(DM, 'm2');
    assert.equal(await unread(), 1);
    store.markRead(DM, 'm3');
    assert.equal(await unread(), 0);

    // The cursor only moves forward: an older id is refused, so a re-read cannot resurrect a badge.
    assert.equal(store.markRead(DM, 'm1'), false);
    assert.equal(store.markRead(DM, 'm3'), false, 'marking the same message twice is a no-op');
    assert.equal(store.markRead(DM, 'not-in-this-chat'), false);
    // A message from the owner is never unread.
    store.upsertMessage(message({ id: 'm4', chat_jid: DM, ts: 4_000, from_me: true, text: 'mine' }));
    assert.equal(await unread(), 0);
    assert.equal(store.newestMessageId(DM), 'm4');
  } finally {
    db.close();
  }
});

test('open answers the newest rows of one chat, oldest first, and an unknown chat answers nothing', async () => {
  const { db, store } = fixture();
  try {
    store.upsertChat({ jid: DM, name: 'Ada', kind: '1:1', last_msg_at: 71_000 });
    for (let index = 1; index <= 70; index += 1) {
      store.upsertMessage(message({ id: `m${String(index).padStart(2, '0')}`, chat_jid: DM, ts: index * 1_000, text: `body ${index}` }));
    }
    store.upsertMessage(message({ id: 'stub', chat_jid: DM, ts: 71_000, type: 'system', text: 'You joined' }));
    const transport = createWhatsAppTransport({ store, connection: down });

    const rows = await transport.openChat({ id: DM, limit: 60 });
    assert.equal(rows.length, 60, 'the limit is what a read asks for, not everything ever stored');
    assert.equal(rows.at(-1)!.id, 'stub', 'the newest row is last, the way a thread reads');
    assert.equal(rows.at(-1)!.type, 'system', 'the transport reports the type; the adapter decides what is noise');

    assert.deepEqual(await transport.openChat({ id: 'nobody@s.whatsapp.net', limit: 60 }), [], 'no stored rows is an empty thread, not an error');
  } finally {
    db.close();
  }
});

test('media is served from cached bytes, and a ref whose file is gone answers no bytes', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'wa-media-'));
  const { db, store } = fixture();
  try {
    store.upsertChat({ jid: DM, name: 'Ada', kind: '1:1', last_msg_at: 1_000 });
    store.upsertMessage(message({ id: 'img', chat_jid: DM, ts: 1_000, type: 'image' }));
    store.upsertMessage(message({ id: 'gone', chat_jid: DM, ts: 2_000, type: 'image' }));
    mkdirSync(join(dataDir, 'media'), { recursive: true });
    writeFileSync(join(dataDir, 'media', 'img.jpg'), new Uint8Array([1, 2, 3]));
    store.setMediaRef('img', join('media', 'img.jpg'));
    store.setMediaRef('gone', join('media', 'gone.jpg'));
    const transport = createWhatsAppTransport({ store, connection: down, dataDir });

    const cached = await transport.loadMedia('img');
    assert.equal(cached.info?.cached, true);
    assert.equal(cached.info?.mime, 'image/jpeg', 'the type comes from the extension the downloader wrote');
    assert.deepEqual([...(cached.bytes ?? [])], [1, 2, 3]);

    const missing = await transport.loadMedia('gone');
    assert.equal(missing.info?.cached, true, 'the row says ready; the file is what is missing');
    assert.equal(missing.bytes, undefined);

    // A ref that walks out of the cache directory is not a file this plugin serves.
    writeFileSync(join(dataDir, 'outside.jpg'), new Uint8Array([9]));
    store.setMediaRef('gone', join('..', 'outside.jpg'));
    assert.equal((await transport.loadMedia('gone')).bytes, undefined);

    assert.deepEqual(await transport.loadMedia('no-such-message'), {}, 'an unknown message has no media');
  } finally {
    db.close();
  }
});

test('a send needs the socket; a read mark does not, and neither needs another program', async () => {
  const { db, store } = fixture();
  try {
    store.upsertChat({ jid: DM, name: 'Ada', kind: '1:1', last_msg_at: 1_000 });
    store.upsertMessage(message({ id: 'm1', chat_jid: DM, ts: 1_000, text: 'hi' }));

    const offline = createWhatsAppTransport({ store, connection: down });
    await assert.rejects(offline.sendText({ id: DM, text: 'hello' }), WhatsAppDisconnectedError);
    await offline.markRead({ id: DM });
    assert.equal(store.getChat(DM)?.last_read_msg_id, 'm1', 'a read is recorded with the socket down');
    assert.deepEqual(await offline.status(), { connection: 'disconnected', paired: false }, 'and the status says both facts plainly');

    const sent: Array<{ jid: string; content: unknown; options: { messageId: string } }> = [];
    const online = createWhatsAppTransport({
      store,
      connection: up({
        async sendMessage(jid: string, content: unknown, options: unknown) {
          sent.push({ jid, content, options: options as { messageId: string } });
          return {};
        },
        async readMessages(_keys: unknown[]) {
          throw new Error('receipt refused');
        },
      } as unknown as Partial<WhatsAppSendSocket>),
    });
    await online.sendText({ id: DM, text: '  hello  ' });
    assert.equal(sent.length, 1);
    assert.deepEqual([sent[0].jid, sent[0].content], [DM, { text: 'hello' }]);
    assert.match(sent[0].options.messageId, /^[0-9A-F]{32}$/, 'the id is Baileys-shaped');

    // A refused receipt must not turn a recorded read into a failed one.
    await online.markRead({ id: DM, messageId: 'm1' });
    assert.equal(store.getChat(DM)?.last_read_msg_id, 'm1');
  } finally {
    db.close();
  }
});

test('a source nobody has paired answers empty, because there is nothing to read and nothing wrong', async () => {
  // R5 at the seam the panel reads through: no rows and no socket is an empty inbox, not a failure.
  // A throw here would become one error line per poll, which is the first impression the plan forbids.
  const { db, store } = fixture();
  try {
    const transport = createWhatsAppTransport({ store, connection: down });
    assert.deepEqual(await transport.listChats({ limit: 20 }), { chats: [] });
    assert.deepEqual(await transport.openChat({ id: 'never-seen', limit: 60 }), []);
  } finally {
    db.close();
  }
});

// U6 — a picture renders from bytes already here, and one we do not have says so. The download is
// one attempt per request through the open socket; the failure classes are `src/whatsapp/media.ts`'s
// and are not re-decided here — 404/410 is permanent, 412/418 asks the phone once to re-upload, and
// a 5xx is retriable until the message itself is past the measured serve window.

test('a stored picture downloads once through the socket, then serves from disk with no second fetch', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'wa-serve-'));
  const { db, store } = fixture();
  try {
    storedPicture(store);
    let downloads = 0;
    const online = createWhatsAppTransport({
      store,
      dataDir,
      connection: withReupload(async message => message),
      download: async () => { downloads += 1; return Buffer.from('jpeg bytes'); },
    });

    const first = await online.loadMedia('IMG1');
    assert.equal(downloads, 1, 'the bytes were not on disk, so the one download happened');
    assert.deepEqual([...(first.bytes ?? [])], [...Buffer.from('jpeg bytes')]);
    assert.deepEqual([first.info?.cached, first.info?.available, first.info?.mime], [true, true, 'image/jpeg']);

    const ref = store.getMessage('IMG1')?.media_ref;
    assert.ok(ref, 'the row records where the bytes went');
    assert.equal(statSync(join(dataDir, ref)).mode & 0o777, 0o600, 'cached bytes are owner-only');

    // Reopening the thread is a read from disk, with the socket down and no downloader in reach.
    const offline = createWhatsAppTransport({
      store,
      dataDir,
      connection: down,
      download: async () => { downloads += 1; throw new Error('must not fetch cached bytes'); },
    });
    const second = await offline.loadMedia('IMG1');
    assert.equal(downloads, 1, 'a second serve of the same picture asks nobody');
    assert.deepEqual([...(second.bytes ?? [])], [...Buffer.from('jpeg bytes')]);
    assert.equal(second.info?.mime, 'image/jpeg');
  } finally {
    db.close();
  }
});

test('a picture with no cached bytes and no socket reports, and never waits or throws', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'wa-serve-'));
  const { db, store } = fixture();
  try {
    storedPicture(store);
    let downloads = 0;
    const transport = createWhatsAppTransport({
      store,
      dataDir,
      connection: down,
      download: async () => { downloads += 1; throw new Error('there is no socket to download over'); },
    });

    const answer = await transport.loadMedia('IMG1');
    assert.equal(downloads, 0, 'no socket means no download attempt at all');
    assert.deepEqual(answer.info, { messageId: 'IMG1', kind: 'image', cached: false, available: true });
    assert.equal(answer.bytes, undefined, 'the panel is told there is no picture, not handed a broken one');
  } finally {
    db.close();
  }
});

test('a 404 or 410 is permanent and is not asked again on the next open', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'wa-serve-'));
  const { db, store } = fixture();
  try {
    storedPicture(store);
    let downloads = 0;
    const transport = createWhatsAppTransport({
      store,
      dataDir,
      connection: withReupload(async message => message),
      download: async () => { downloads += 1; throw Object.assign(new Error('gone'), { statusCode: 404 }); },
    });

    const first = await transport.loadMedia('IMG1');
    assert.deepEqual([first.info?.available, first.info?.cached, first.bytes], [false, false, undefined]);
    assert.equal(store.getMessage('IMG1')?.media_error, 'unavailable');

    const again = await transport.loadMedia('IMG1');
    assert.equal(downloads, 1, 'a terminal verdict is not retried on every open');
    assert.equal(again.info?.available, false);
  } finally {
    db.close();
  }
});

test('a 412 or 418 asks the phone to re-upload exactly once per request, and age decides what a repeat means', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'wa-serve-'));
  const { db, store } = fixture();
  try {
    storedPicture(store);
    let downloads = 0;
    let reuploads = 0;
    const download: MediaDownloader = async (_message, _type, _options, ctx) => {
      downloads += 1;
      // What Baileys does on a 412/418: ask for a fresh upload once, then retry the fetch itself.
      const refreshed = await ctx!.reuploadRequest({ key: { id: 'IMG1' } } as WAMessage);
      reuploads += refreshed ? 1 : 0;
      throw Object.assign(new Error('decrypt failed'), { statusCode: 412 });
    };
    const transport = createWhatsAppTransport({ store, dataDir, connection: withReupload(async message => message), download });

    const first = await transport.loadMedia('IMG1');
    assert.deepEqual([downloads, reuploads], [1, 1], 'one download, one re-upload request');
    assert.deepEqual([first.info?.available, first.bytes], [true, undefined], 'recent media is retriable, so the panel may try again');

    const second = await transport.loadMedia('IMG1');
    assert.deepEqual([downloads, reuploads], [2, 2], 'a later open is one more request, never a loop inside one');
    assert.equal(second.info?.available, true);

    // Past the measured window the same refusal is the bytes being gone, so it becomes terminal.
    const old = createWhatsAppTransport({
      store: (() => { storedPicture(store, 'OLD1', Math.floor(Date.now() / 1000) - 30 * 86_400); return store; })(),
      dataDir,
      connection: withReupload(async message => message),
      download: async () => { throw Object.assign(new Error('general error'), { statusCode: 418 }); },
    });
    const aged = await old.loadMedia('OLD1');
    assert.equal(aged.info?.available, false, 'an old message behind a server refusal is not offered as retriable');
  } finally {
    db.close();
  }
});

test('a 5xx is temporary and a later open may try again', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'wa-serve-'));
  const { db, store } = fixture();
  try {
    storedPicture(store);
    let downloads = 0;
    const transport = createWhatsAppTransport({
      store,
      dataDir,
      connection: withReupload(async message => message),
      download: async () => {
        downloads += 1;
        if (downloads === 1) throw Object.assign(new Error('CDN hiccup'), { statusCode: 502 });
        return Buffer.from('jpeg bytes');
      },
    });

    const first = await transport.loadMedia('IMG1');
    assert.deepEqual([first.info?.available, first.bytes], [true, undefined]);

    const second = await transport.loadMedia('IMG1');
    assert.deepEqual([downloads, second.info?.cached], [2, true], 'the retry after a temporary failure is the one that serves');
    assert.deepEqual([...(second.bytes ?? [])], [...Buffer.from('jpeg bytes')]);
  } finally {
    db.close();
  }
});

test('audio and documents are not media the panel draws: no descriptor, no download', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'wa-serve-'));
  const { db, store } = fixture();
  try {
    store.upsertChat({ jid: DM, name: 'Ada', kind: '1:1', last_msg_at: 2_000 });
    store.upsertMessage(message({ id: 'voice', chat_jid: DM, ts: 1_000, type: 'audio' }));
    store.upsertMessage(message({ id: 'doc', chat_jid: DM, ts: 2_000, type: 'document' }));
    let downloads = 0;
    const transport = createWhatsAppTransport({
      store,
      dataDir,
      connection: withReupload(async msg => msg),
      download: async () => { downloads += 1; return Buffer.from('never'); },
    });

    assert.deepEqual(await transport.loadMedia('voice'), {}, 'an audio message stays a text placeholder');
    assert.deepEqual(await transport.loadMedia('doc'), {}, 'so does a document');
    assert.equal(downloads, 0);

    const rows = await transport.openChat({ id: DM, limit: 60 });
    assert.deepEqual(rows.map(row => row.media), [undefined, undefined], 'the panel is not told these are pictures');
  } finally {
    db.close();
  }
});
