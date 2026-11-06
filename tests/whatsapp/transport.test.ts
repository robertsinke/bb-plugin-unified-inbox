// U3 — what answers a WhatsApp read. The transport is proved here against the real store and a
// fake socket: no Baileys socket, no network, no account state.
//
// What these tests pin: a read works with the socket down (the point of the store), the list is
// newest-first and pages by offset, unread counts only messages newer than the read cursor, history
// that was synced is not news, and a send with no socket refuses rather than pretending.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
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
const GROUP = '120363413535442462@g.us';

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

/** Let the picture queue's asks (one per macrotask) and their writes finish. */
async function settle(): Promise<void> {
  for (let round = 0; round < 4; round += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** A connection that never opened a socket: the state a read finds on a cold plugin, and no reopen. */
const down = { connection: () => undefined, ensure: async () => undefined };

/**
 * The two ways a transport asks about its socket: the one it can see, and the one a call that needs
 * a live socket asks for. A fake that has no reopen answers both with the same connection.
 */
function sockets(get: () => WhatsAppConnection | undefined) {
  return { connection: get, ensure: async () => get() };
}

function up(socket: Partial<WhatsAppSendSocket>) {
  const connection = {
    getSendSocket: () => socket as WhatsAppSendSocket,
    status: () => 'connected',
  };
  return sockets(() => connection as unknown as WhatsAppConnection);
}

/** A socket that can answer the one media call: asking the phone to upload again. */
function withReupload(updateMediaMessage: (message: WAMessage) => Promise<WAMessage>) {
  const connection = {
    getSendSocket: () => undefined,
    getMediaSocket: () => ({ updateMediaMessage }),
    status: () => 'connected',
  };
  return sockets(() => connection as unknown as WhatsAppConnection);
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

    const transport = createWhatsAppTransport({ store, ...down });
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
      preview: { text: 'See you', fromMe: false, sender: '+15551234567' },
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
    const transport = createWhatsAppTransport({ store, ...down });

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
    const transport = createWhatsAppTransport({ store, ...down });

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

test('a 1:1 row stored with a blank sender is still the other person', async () => {
  const { db, store } = fixture();
  try {
    // Rows already on disk from before a blank participant was ignored. The address book has the
    // person; the bubble must not say Unknown just because the sender column is empty.
    store.upsertChat({ jid: DM, name: null, kind: '1:1', last_msg_at: 1_000 });
    store.upsertContact({ jid: DM, name: '+31∙∙∙∙∙∙∙44', push_name: 'Jan' });
    store.upsertMessage(message({ id: 'm1', chat_jid: DM, ts: 1_000, sender: '', text: 'he maat' }));
    const transport = createWhatsAppTransport({ store, ...down });
    const [row] = await transport.openChat({ id: DM, limit: 10 });
    assert.equal(row?.sender, 'Jan');
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
    const transport = createWhatsAppTransport({ store, ...down });

    const rows = await transport.openChat({ id: DM, limit: 60 });
    assert.equal(rows.length, 60, 'the limit is what a read asks for, not everything ever stored');
    assert.equal(rows.at(-1)!.id, 'stub', 'the newest row is last, the way a thread reads');
    assert.equal(rows.at(-1)!.type, 'system', 'the transport reports the type; the adapter decides what is noise');

    assert.deepEqual(await transport.openChat({ id: 'nobody@s.whatsapp.net', limit: 60 }), [], 'no stored rows is an empty thread, not an error');
  } finally {
    db.close();
  }
});

test('the corpus is every chat with every stored message, read from the store with no socket', async () => {
  const { db, store } = fixture();
  try {
    store.upsertChat({ jid: DM, name: 'Ada', kind: '1:1', last_msg_at: 3_000 });
    store.upsertChat({ jid: GROUP, name: 'Builders', kind: 'group', last_msg_at: 9_000 });
    store.upsertContact({ jid: '255700000001@s.whatsapp.net', push_name: 'Grace' });
    for (let index = 1; index <= 120; index += 1) {
      store.upsertMessage(message({ id: `m${String(index).padStart(3, '0')}`, chat_jid: DM, ts: index * 1_000, text: `body ${index}` }));
    }
    store.upsertMessage(message({ id: 'g1', chat_jid: GROUP, ts: 2_000, sender: '255700000001@s.whatsapp.net', text: 'Ship it' }));
    store.markChatsRead([DM, GROUP]);
    store.upsertMessage(message({ id: 'unread', chat_jid: GROUP, ts: 9_000, sender: '255700000001@s.whatsapp.net', text: 'Anyone there' }));

    // The socket answers nothing and may not even be asked: a corpus is a store read.
    let socketAsked = 0;
    const transport = createWhatsAppTransport({
      store,
      connection: () => { socketAsked += 1; return undefined; },
      ensure: async () => { socketAsked += 1; return undefined; },
    });
    const corpus = await transport.listCorpus();

    assert.deepEqual(corpus.map(row => row.jid), [GROUP, DM], 'newest activity first, like the list');
    const [, direct] = corpus;
    assert.equal(direct.messages.length, 120, 'every stored message, not the newest page');
    assert.deepEqual(direct.messages.slice(0, 2).map(row => row.text), ['body 1', 'body 2'], 'oldest first, the order a thread reads in');
    assert.equal(direct.unread, 0, 'a chat read up to its newest has nothing unread');
    const [group] = corpus;
    assert.equal(group.messages[1].sender, 'Grace', 'a group message names its sender from the stored contact');
    assert.equal(group.unread, 1, 'and the unread count is the list\'s own rule');
    assert.equal(direct.messages[0].type, 'text');
    assert.equal('raw' in direct.messages[0], false, 'the corpus carries words, not envelopes');
    assert.equal(socketAsked, 0, 'a corpus read never touches the socket');
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
    const transport = createWhatsAppTransport({ store, ...down, dataDir });

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

    const offline = createWhatsAppTransport({ store, ...down });
    await assert.rejects(offline.sendText({ id: DM, text: 'hello' }), WhatsAppDisconnectedError);
    await offline.markRead({ id: DM });
    assert.equal(store.getChat(DM)?.last_read_msg_id, 'm1', 'a read is recorded with the socket down');
    assert.deepEqual(await offline.status(), { connection: 'disconnected', paired: false }, 'and the status says both facts plainly');

    const sent: Array<{ jid: string; content: unknown; options: { messageId: string } }> = [];
    const online = createWhatsAppTransport({
      store,
      ...up({
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

// INBOX-29 — a chat picture is a store read at the seam, and the ask that fills the store runs behind
// it through an open socket. Nothing here may open one: a face is not worth a reconnect, and a
// reconnect against a live account state is the ban lever.

test('a chat picture is asked through the open socket, and answered from the store from then on', async () => {
  const { db, store } = fixture();
  try {
    const asks: string[] = [];
    const picture = 'https://pps.whatsapp.net/v/t61.24694-24/1_n.jpg?oe=68a1b2c3';
    const connection = {
      getSendSocket: () => undefined,
      getAvatarSocket: () => ({
        async profilePictureUrl(jid: string) {
          asks.push(jid);
          return picture;
        },
      }),
      status: () => 'connected',
    };
    const transport = createWhatsAppTransport({ store, ...sockets(() => connection as unknown as WhatsAppConnection) });

    // The draw that finds nothing answers immediately, and the ask is already in flight behind it.
    assert.equal(transport.avatarUrl(DM), undefined);
    assert.deepEqual(asks, [DM]);

    await settle();
    assert.equal(store.getAvatar(DM)?.url, picture);
    assert.equal(transport.avatarUrl(DM), picture, 'the next draw has the picture, from the store');
    assert.equal(asks.length, 1);
  } finally {
    db.close();
  }
});

test('a chat picture never opens a socket: a closed account keeps drawing initials', async () => {
  const { db, store } = fixture();
  try {
    let ensured = 0;
    const transport = createWhatsAppTransport({
      store,
      connection: () => undefined,
      ensure: async () => {
        ensured += 1;
        return undefined;
      },
    });
    assert.equal(transport.avatarUrl(DM), undefined);
    await settle();
    assert.equal(ensured, 0, 'a picture is not a reason to reconnect');
    assert.equal(store.getAvatar(DM), undefined, 'and no verdict is recorded for a row nobody could ask about');
  } finally {
    db.close();
  }
});

test('a source nobody has paired answers empty, because there is nothing to read and nothing wrong', async () => {
  // R5 at the seam the panel reads through: no rows and no socket is an empty inbox, not a failure.
  // A throw here would become one error line per poll, which is the first impression the plan forbids.
  const { db, store } = fixture();
  try {
    const transport = createWhatsAppTransport({ store, ...down });
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
      ...withReupload(async message => message),
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
      ...down,
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
      ...down,
      download: async () => { downloads += 1; throw new Error('there is no socket to download over'); },
    });

    const answer = await transport.loadMedia('IMG1');
    assert.equal(downloads, 0, 'no socket means no download attempt at all');
    assert.deepEqual(answer.info, { messageId: 'IMG1', kind: 'image', cached: false, available: true });
    assert.equal(answer.bytes, undefined, 'the panel is told there is no picture, not handed a broken one');
    assert.equal(answer.notConnected, true, 'and told it is the socket, not the message');
    assert.equal(store.getMessage('IMG1')?.media_state, 'placeholder', 'a request with nowhere to go is not a verdict on the message');
    assert.equal(store.getMessage('IMG1')?.media_error, null);
  } finally {
    db.close();
  }
});

test('a picture no socket could serve is fetched by opening one, not reported dead', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'wa-serve-'));
  const { db, store } = fixture();
  try {
    storedPicture(store);
    let opened = 0;
    const transport = createWhatsAppTransport({
      store,
      dataDir,
      // What a lifecycle looks like after the boot service's abort path: nothing open, an account
      // that can still be opened, and a call that needs a socket asking for one.
      connection: down.connection,
      ensure: async () => {
        opened += 1;
        return withReupload(async message => message).connection();
      },
      download: async () => Buffer.from('jpeg bytes'),
    });

    const answer = await transport.loadMedia('IMG1');
    assert.equal(opened, 1, 'the request that needed a socket asked for one');
    assert.equal(answer.notConnected, undefined);
    assert.deepEqual([answer.info?.cached, [...(answer.bytes ?? [])]], [true, [...Buffer.from('jpeg bytes')]]);
  } finally {
    db.close();
  }
});

test('a send asks for a socket before it reports the source disconnected', async () => {
  const { db, store } = fixture();
  try {
    const sent: string[] = [];
    const transport = createWhatsAppTransport({
      store,
      connection: down.connection,
      ensure: async () => up({
        async sendMessage(_jid: string, content: { text: string }) { sent.push(content.text); return {}; },
      } as unknown as Partial<WhatsAppSendSocket>).connection(),
    });

    await transport.sendText({ id: DM, text: 'hello' });
    assert.deepEqual(sent, ['hello'], 'the socket the send opened is the one it sent over');
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
      ...withReupload(async message => message),
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
    const transport = createWhatsAppTransport({ store, dataDir, ...withReupload(async message => message), download });

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
      ...withReupload(async message => message),
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
      ...withReupload(async message => message),
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

test('audio is media the panel draws, and a document is', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'wa-serve-'));
  const { db, store } = fixture();
  try {
    store.upsertChat({ jid: DM, name: 'Ada', kind: '1:1', last_msg_at: 2_000 });
    store.upsertMessage(message({ id: 'voice', chat_jid: DM, ts: 1_000, type: 'audio' }));
    // A row with no envelope is still a document: the chip is named from what arrives, and an older
    // row that kept no envelope must not make the file disappear from the thread.
    store.upsertMessage(message({ id: 'doc', chat_jid: DM, ts: 2_000, type: 'document' }));
    let downloads = 0;
    const transport = createWhatsAppTransport({
      store,
      dataDir,
      ...withReupload(async msg => msg),
      download: async () => { downloads += 1; return Buffer.from('never'); },
    });

    assert.deepEqual((await transport.loadMedia('voice')).info, { messageId: 'voice', kind: 'audio', cached: false, available: true }, 'an audio message has bytes a player asks for');
    assert.deepEqual((await transport.loadMedia('doc')).info, { messageId: 'doc', kind: 'document', cached: false, available: true });
    assert.equal(downloads, 0, 'nothing is fetched until the download asks');

    const rows = await transport.openChat({ id: DM, limit: 60 });
    assert.deepEqual(rows.map(row => row.media?.kind), ['audio', 'document']);
  } finally {
    db.close();
  }
});

test('a voice note is labelled from its envelope, and its declared type is the one served', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'wa-audio-'));
  const { db, store } = fixture();
  try {
    store.upsertChat({ jid: DM, name: 'Ada', kind: '1:1', last_msg_at: 2_000 });
    // The shape a live row holds: `fileLength` is a decimal string after BufferJSON, and the type
    // carries its codecs, which a data URL must not.
    handleMessagesUpsert(store, {
      type: 'notify',
      messages: [{
        key: { id: 'AUD1', remoteJid: DM, fromMe: false },
        messageTimestamp: 2_000,
        message: { audioMessage: { mimetype: 'audio/ogg; codecs=opus', fileLength: '175401', seconds: 69, ptt: true } },
      } as unknown as WAMessage],
    });
    const transport = createWhatsAppTransport({
      store,
      dataDir,
      ...withReupload(async msg => msg),
      download: async () => Buffer.from('opus bytes'),
    });

    const [row] = await transport.openChat({ id: DM, limit: 60 });
    assert.deepEqual(row.media, {
      messageId: 'AUD1',
      kind: 'audio',
      cached: false,
      available: true,
      seconds: 69,
      voice: true,
      size: 175_401,
      mime: 'audio/ogg; codecs=opus',
    }, 'the length, the voice flag, the size and the type exist only in the envelope');

    const served = await transport.loadMedia('AUD1');
    assert.deepEqual([served.info?.mime, served.info?.cached], ['audio/ogg; codecs=opus', true], 'the envelope names the type, not the .ogg the bytes were cached under');
    assert.deepEqual([...(served.bytes ?? [])], [...Buffer.from('opus bytes')]);

    // Serving it again is a read from disk, and the envelope is still the answer.
    const offline = createWhatsAppTransport({ store, dataDir, ...down });
    const second = await offline.mediaFacts('AUD1');
    assert.deepEqual([second?.mime, second?.seconds, second?.voice], ['audio/ogg; codecs=opus', 69, true]);
  } finally {
    db.close();
  }
});

test('a document is named and sized from its envelope, and its bytes are saved under its own name', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'wa-doc-'));
  const { db, store } = fixture();
  try {
    handleMessagesUpsert(store, {
      type: 'notify',
      messages: [{
        key: { id: 'DOC1', remoteJid: DM, fromMe: false },
        messageTimestamp: 2_000,
        message: { documentWithCaptionMessage: { message: { documentMessage: { fileName: 'Contract v2.pdf', mimetype: 'application/pdf', fileLength: 1_024, caption: 'Sign this' } } } },
      } as unknown as WAMessage],
    });
    const transport = createWhatsAppTransport({
      store,
      dataDir,
      ...withReupload(async msg => msg),
      download: async () => Buffer.from('%PDF-1.4'),
    });

    const [row] = await transport.openChat({ id: DM, limit: 60 });
    assert.deepEqual(row.media, {
      messageId: 'DOC1',
      kind: 'document',
      cached: false,
      available: true,
      filename: 'Contract v2.pdf',
      size: 1_024,
      mime: 'application/pdf',
    }, 'the name, size and type exist only in the envelope, and the caption stays the message text');

    const served = await transport.loadMedia('DOC1');
    assert.deepEqual([served.info?.filename, served.info?.mime, served.info?.cached], ['Contract v2.pdf', 'application/pdf', true]);
    const ref = store.getMessage('DOC1')?.media_ref ?? '';
    assert.ok(ref.endsWith('.pdf'), `the cached file keeps the extension it was sent under, got ${ref}`);
    assert.deepEqual([...(served.bytes ?? [])], [...Buffer.from('%PDF-1.4')]);

    // Serving it again is a read from disk, with the envelope's type still the answer.
    const offline = createWhatsAppTransport({ store, dataDir, ...down });
    const second = await offline.loadMedia('DOC1');
    assert.deepEqual([second.info?.mime, second.info?.filename], ['application/pdf', 'Contract v2.pdf']);
  } finally {
    db.close();
  }
});

test('the facts of a message answer before its bytes, and bytes nobody will show are taken back', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'wa-facts-'));
  const { db, store } = fixture();
  try {
    handleMessagesUpsert(store, {
      type: 'notify',
      messages: [{
        key: { id: 'DOC1', remoteJid: DM, fromMe: false },
        messageTimestamp: 2_000,
        message: { documentMessage: { fileName: 'Deck.pdf', mimetype: 'application/pdf', fileLength: 9_000_000 } },
      } as unknown as WAMessage],
    });
    const offline = createWhatsAppTransport({ store, dataDir, ...down });

    assert.deepEqual(await offline.mediaFacts('DOC1'), {
      messageId: 'DOC1',
      kind: 'document',
      cached: false,
      available: true,
      filename: 'Deck.pdf',
      size: 9_000_000,
      mime: 'application/pdf',
    }, 'the declared size is what lets a caller refuse a file without fetching it');
    assert.equal(await offline.mediaFacts('no-such-message'), undefined);

    const online = createWhatsAppTransport({
      store,
      dataDir,
      ...withReupload(async msg => msg),
      download: async () => Buffer.from('pdf bytes'),
    });
    await online.loadMedia('DOC1');
    const ref = store.getMessage('DOC1')?.media_ref ?? '';
    assert.ok(existsSync(join(dataDir, ref)), 'the download wrote the file');

    await online.discardMedia('DOC1');
    assert.equal(existsSync(join(dataDir, ref)), false, 'a discarded entry takes the file with it');
    assert.equal(store.getMessage('DOC1')?.media_ref, null, 'and the row no longer claims bytes');
    assert.equal(store.getMessage('DOC1')?.media_state, 'placeholder');

    await online.discardMedia('no-such-message');
  } finally {
    db.close();
  }
});

test('open copies stored reactions and quote text, and does not ask for a socket', async () => {
  const { db, store } = fixture();
  try {
    store.upsertChat({ jid: DM, name: 'Ada', kind: '1:1', last_msg_at: 2_000 });
    store.upsertContact({ jid: '255700000001@s.whatsapp.net', push_name: 'Grace' });
    store.upsertContact({ jid: '255700000002@s.whatsapp.net', name: 'Ida' });
    store.upsertMessage(message({
      id: 'm1',
      chat_jid: DM,
      ts: 2_000,
      text: 'See you',
      quote_target_id: 'earlier',
      quote_sender: '255700000001@s.whatsapp.net',
      quote_text: 'the earlier line',
    }));
    store.upsertMessageReaction({ chat_jid: DM, target_msg_id: 'm1', actor: '255700000001@s.whatsapp.net', emoji: '👍', updated_at: 1 });
    store.upsertMessageReaction({ chat_jid: DM, target_msg_id: 'm1', actor: '255700000002@s.whatsapp.net', emoji: '👎', updated_at: 2 });
    // History can name no one. The emoji still shows.
    store.upsertMessageReaction({ chat_jid: DM, target_msg_id: 'm1', actor: '', emoji: '😂', updated_at: 5 });
    // A falsey emoji is not a reaction, even when a row was written past the store's own delete.
    db.prepare('INSERT INTO wa_message_reactions (chat_jid, target_msg_id, actor, emoji, updated_at) VALUES (?, ?, ?, ?, ?)').run(DM, 'm1', 'ghost', '', 3);
    db.prepare('INSERT INTO wa_message_reactions (chat_jid, target_msg_id, actor, emoji, updated_at) VALUES (?, ?, ?, ?, ?)').run(DM, 'm1', 'blank', '   ', 4);

    let asked = 0;
    const transport = createWhatsAppTransport({
      store,
      connection: () => { asked += 1; return undefined; },
      ensure: async () => { asked += 1; return undefined; },
    });
    const [row] = await transport.openChat({ id: DM, limit: 60 });

    assert.equal(asked, 0, 'a read of stored reactions and quotes does not open a socket');
    assert.deepEqual(row.reactions, [
      { sender: 'Grace', label: '👍' },
      { sender: 'Ida', label: '👎' },
      { sender: '', label: '😂' },
    ]);
    assert.deepEqual(row.quote, { targetId: 'earlier', sender: 'Grace', text: 'the earlier line' });
  } finally {
    db.close();
  }
});

test('a reaction send does not write a row; the next open shows it only after ingest stores it', async () => {
  const { db, store } = fixture();
  try {
    store.upsertChat({ jid: DM, name: 'Ada', kind: '1:1', last_msg_at: 1_000 });
    store.upsertMessage(message({ id: 'm1', chat_jid: DM, ts: 1_000, from_me: false, text: 'hi' }));
    store.upsertMessageReaction({ chat_jid: DM, target_msg_id: 'm1', actor: 'me', emoji: '👍', updated_at: 1 });
    const sent: Array<{ text: string; key: { id?: string | null } }> = [];
    const transport = createWhatsAppTransport({
      store,
      ...up({
        async sendMessage(_jid: string, content: { react?: { text: string; key: { id?: string | null } } }) {
          sent.push({ text: content.react?.text ?? '', key: content.react?.key ?? {} });
          return {};
        },
      } as unknown as Partial<WhatsAppSendSocket>),
    });

    await transport.sendReaction({ id: DM, messageId: 'm1', emoji: '❤️' });
    assert.deepEqual(sent, [{ text: '❤️', key: { remoteJid: DM, id: 'm1', fromMe: false } }]);
    assert.deepEqual(store.listMessageReactions(DM, 'm1').map(row => row.emoji), ['👍'], 'the send does not invent a row');
    assert.deepEqual((await transport.openChat({ id: DM, limit: 60 }))[0].reactions, [{ sender: '', label: '👍' }]);

    // The same actor's next emoji replaces the stored one, because ingest keeps one row per actor.
    store.upsertMessageReaction({ chat_jid: DM, target_msg_id: 'm1', actor: 'me', emoji: '❤️', updated_at: 2 });
    assert.deepEqual((await transport.openChat({ id: DM, limit: 60 }))[0].reactions, [{ sender: '', label: '❤️' }]);

    sent.length = 0;
    await transport.sendReaction({ id: DM, messageId: 'm1', emoji: '' });
    assert.deepEqual(sent, [{ text: '', key: { remoteJid: DM, id: 'm1', fromMe: false } }], 'remove sends an empty emoji');
  } finally {
    db.close();
  }
});

test('a quote reply sends the stored envelope, and a missing envelope is not a message', async () => {
  const { db, store } = fixture();
  try {
    store.upsertChat({ jid: DM, name: 'Ada', kind: '1:1', last_msg_at: 1_000 });
    const envelope = { key: { remoteJid: DM, id: 'm1', fromMe: false }, message: { conversation: 'hi' } };
    store.upsertMessage(message({ id: 'm1', chat_jid: DM, ts: 1_000, text: 'hi', raw: JSON.stringify(envelope) }));
    store.upsertMessage(message({ id: 'bare', chat_jid: DM, ts: 2_000, text: 'no envelope' }));
    store.upsertMessage(message({ id: 'bad', chat_jid: DM, ts: 3_000, text: 'bad', raw: '{not json' }));

    let asked = 0;
    const sent: Array<{ content: unknown; quoted: unknown }> = [];
    const transport = createWhatsAppTransport({
      store,
      connection: () => undefined,
      ensure: async () => { asked += 1; return undefined; },
    });
    assert.deepEqual(await transport.storedEnvelope('m1'), envelope);
    assert.equal(await transport.storedEnvelope('bare'), undefined, 'a row with no envelope cannot be quoted');
    assert.equal(await transport.storedEnvelope('bad'), undefined, 'an envelope that will not parse cannot be quoted');
    assert.equal(await transport.storedEnvelope('missing'), undefined);
    assert.equal(asked, 0, 'loading an envelope does not open a socket');

    const online = createWhatsAppTransport({
      store,
      ...up({
        async sendMessage(_jid: string, content: unknown, options: { quoted?: unknown }) {
          sent.push({ content, quoted: options.quoted });
          return {};
        },
      } as unknown as Partial<WhatsAppSendSocket>),
    });
    const quoted = await online.storedEnvelope('m1');
    await online.sendText({ id: DM, text: 'reply', quoted });
    assert.deepEqual(sent, [{ content: { text: 'reply' }, quoted: envelope }]);
  } finally {
    db.close();
  }
});

test('a reaction with no socket is the disconnected error, once', async () => {
  const { db, store } = fixture();
  try {
    let ensures = 0;
    const transport = createWhatsAppTransport({
      store,
      connection: () => undefined,
      ensure: async () => { ensures += 1; return undefined; },
    });
    await assert.rejects(
      transport.sendReaction({ id: DM, messageId: 'm1', emoji: '👍' }),
      WhatsAppDisconnectedError,
    );
    assert.equal(ensures, 1, 'one attempt: a disconnected socket is not asked again');
  } finally {
    db.close();
  }
});
