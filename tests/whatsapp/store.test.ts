// U2 — the store the transport needs. What these tests pin: a message that arrived is still readable
// after a restart with the socket down, the raw envelope answers `getMessage(key)`, a replayed batch
// adds no row, and `clear_cache` still means what README.md promises.
//
// No socket, no network: the history fixture below is a captured envelope set, and every write goes
// through the same `attachIngest` the socket binds to.
import assert from 'node:assert/strict';
import { createCipheriv, hkdfSync } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { proto, type WAMessage } from 'baileys';
import { createInboxCache } from '../../src/inbox-cache.ts';
import { createSendAudit } from '../../src/send-audit.ts';
import { deepenChatHistory } from '../../src/whatsapp/history.ts';
import {
  attachIngest,
  ingestBaileysGroup,
  handleLidMappingUpdate,
  handleMessagesReaction,
  handleMessagesUpdate,
  handleHistorySet,
  handleMessagesUpsert,
  type HistorySetPayload,
  type MessagesReactionPayload,
  type MessagesUpdatePayload,
} from '../../src/whatsapp/ingest.ts';
import { createWhatsAppStore } from '../../src/whatsapp/store.ts';

const history = JSON.parse(
  readFileSync(new URL('../fixtures/whatsapp-history.json', import.meta.url), 'utf8'),
) as HistorySetPayload;

/** A plugin database the way `server.ts` opens it: foreign keys on, one connection. */
function fixture() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  return { db, store: createWhatsAppStore(db) };
}

function message(value: Record<string, unknown>): WAMessage {
  return value as unknown as WAMessage;
}

test('replaying the same captured batch twice leaves one row per message and the first envelope readable', () => {
  const { db, store } = fixture();
  try {
    handleHistorySet(store, history);
    const first = store.countMessages();
    assert.ok(first > 0, 'the captured batch must store something');
    const before = store.getMessage('group-target');
    assert.equal(before?.text, 'Original text');

    handleHistorySet(store, history);

    assert.equal(store.countMessages(), first, 'a replay replaces rows, it never adds them');
    assert.deepEqual(store.getMessage('group-target'), before, 'the stored row is the same row');
    assert.ok(store.getMessage('group-target')?.raw?.includes('Original text'), 'the envelope is kept');
  } finally {
    db.close();
  }
});

test('a restart reads the same messages with the socket down, and getMessage(key) answers', async () => {
  const db = new Database(':memory:');
  try {
    handleHistorySet(createWhatsAppStore(db), history);
    // A restart is a new store over the same database; nothing about the socket is involved.
    const reopened = createWhatsAppStore(db);
    assert.equal(reopened.getMessage('group-target')?.text, 'Original text');

    const loader = reopened.storedMessageLoader();
    const envelope = await loader({ id: 'group-target', remoteJid: 'team@g.us', fromMe: false });
    assert.equal(envelope?.conversation, 'Original text');
    // An unknown key answers nothing rather than throwing: the protocol reads that as "cannot resend".
    assert.equal(await loader({ id: 'never-seen', remoteJid: 'team@g.us' }), undefined);
    assert.equal(await loader({ remoteJid: 'team@g.us' }), undefined);

    // A row whose envelope will not parse is the same answer, not a socket event turned into a throw.
    db.prepare("UPDATE wa_messages SET raw = '{not json' WHERE id = 'group-target'").run();
    assert.equal(await loader({ id: 'group-target', remoteJid: 'team@g.us' }), undefined);
  } finally {
    db.close();
  }
});

test('a reaction and an edit update the stored state instead of adding a message row', () => {
  const { db, store } = fixture();
  try {
    const chatJid = 'clara@s.whatsapp.net';
    const messageId = 'EDIT-TARGET';
    const secret = Buffer.alloc(32, 7);
    handleMessagesUpsert(store, {
      type: 'notify',
      messages: [
        message({
          key: { id: messageId, remoteJid: chatJid, participant: chatJid, fromMe: false },
          messageTimestamp: 100,
          message: { conversation: 'original', messageContextInfo: { messageSecret: secret } },
        }),
        message({
          key: { id: 'REACT-TARGET', remoteJid: chatJid, fromMe: false },
          messageTimestamp: 110,
          message: { conversation: 'their message' },
        }),
      ],
    });
    const baseline = store.countMessages();

    handleMessagesReaction(store, [
      {
        key: { id: 'REACT-TARGET', remoteJid: chatJid },
        reaction: { text: '👍', key: { id: 'r1', remoteJid: chatJid, participant: chatJid }, senderTimestampMs: 120_000 },
      },
    ] as unknown as MessagesReactionPayload);
    assert.equal(store.countMessages(), baseline, 'a reaction is not a message');
    assert.deepEqual(
      store.listMessageReactions(chatJid, 'REACT-TARGET').map((row) => row.emoji),
      ['👍'],
    );

    // A real secret-encrypted edit: the key comes from the original envelope's messageSecret.
    const info = Buffer.concat([
      Buffer.from(messageId),
      Buffer.from(chatJid),
      Buffer.from(chatJid),
      Buffer.from('Message Edit'),
    ]);
    const editKey = Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), info, 32));
    const iv = Buffer.alloc(12, 3);
    const cipher = createCipheriv('aes-256-gcm', editKey, iv);
    const encrypted = Buffer.concat([
      cipher.update(Buffer.from(proto.Message.encode({ conversation: 'edited text' }).finish())),
      cipher.final(),
      cipher.getAuthTag(),
    ]);
    const updated = handleMessagesUpdate(store, [
      {
        key: { id: messageId, remoteJid: chatJid, participant: chatJid, fromMe: false },
        update: {
          message: {
            editedMessage: {
              message: {
                secretEncryptedMessage: {
                  targetMessageKey: { id: messageId, remoteJid: chatJid, participant: chatJid, fromMe: false },
                  encPayload: encrypted,
                  encIv: iv,
                  secretEncType: proto.Message.SecretEncryptedMessage.SecretEncType.MESSAGE_EDIT,
                },
              },
            },
          },
        },
      },
    ] as unknown as MessagesUpdatePayload);

    assert.deepEqual(updated, [messageId]);
    assert.equal(store.countMessages(), baseline, 'an edit is not a message either');
    const edited = store.getMessage(messageId);
    assert.equal(edited?.text, 'edited text');
    assert.equal(typeof edited?.edited_at, 'number');
  } finally {
    db.close();
  }
});

test('a late LID mapping merges the two chat rows and the messages move with it', () => {
  const { db, store } = fixture();
  try {
    const lidJid = '999@lid';
    const phoneJid = '31600000099@s.whatsapp.net';
    handleMessagesUpsert(store, {
      type: 'notify',
      messages: [
        message({ key: { id: 'lid-1', remoteJid: lidJid, fromMe: false }, messageTimestamp: 100, message: { conversation: 'from the lid chat' } }),
        message({ key: { id: 'phone-1', remoteJid: phoneJid, fromMe: false }, messageTimestamp: 110, message: { conversation: 'from the phone chat' } }),
      ],
    });
    assert.equal(store.countMessages(), 2);
    assert.equal(store.getChat(lidJid)?.kind, '1:1');

    assert.deepEqual(handleLidMappingUpdate(store, { lid: lidJid, pn: phoneJid }), { from: lidJid, to: phoneJid });

    assert.equal(store.getChat(lidJid), undefined, 'the duplicate chat is gone');
    assert.deepEqual(
      store.listMessages(phoneJid).map((row) => row.id),
      ['lid-1', 'phone-1'],
      'the messages moved, none were dropped',
    );
    assert.equal(store.countMessages(), 2);
    assert.equal(store.canonicalChatJid(lidJid), phoneJid, 'and a later write lands on the surviving chat');
  } finally {
    db.close();
  }
});

test('a phone-shaped chat name is stored as no name and a group is a group', () => {
  const { db, store } = fixture();
  try {
    handleHistorySet(store, {
      chats: [
        { id: '31612345678@s.whatsapp.net', name: '+31 (6) 1234-5678', conversationTimestamp: 1 },
        { id: 'team@g.us', name: 'Team', conversationTimestamp: 2 },
      ] as unknown as HistorySetPayload['chats'],
      contacts: [],
      messages: [],
    });
    assert.equal(store.getChat('31612345678@s.whatsapp.net')?.name, null);
    assert.equal(store.getChat('team@g.us')?.name, 'Team');
    assert.equal(store.getChat('team@g.us')?.kind, 'group');
  } finally {
    db.close();
  }
});

test('a picture keeps its answer and when it was learned, and the surviving identity keeps it on a merge', () => {
  const db = new Database(':memory:');
  try {
    const store = createWhatsAppStore(db);
    const LID = '999000111222333@lid';
    const PHONE = '31123456789@s.whatsapp.net';

    // Never asked is the absence of a row; "no picture" is a row that says so, so a redraw does not ask again.
    assert.equal(store.getAvatar(PHONE), undefined);
    store.setAvatar({ jid: PHONE, url: null, state: 'failed', fetched_at: 10 });
    assert.deepEqual(store.getAvatar(PHONE), { jid: PHONE, url: null, state: 'failed', fetched_at: 10 });

    // The same answer a second time replaces the row rather than adding one.
    store.setAvatar({ jid: PHONE, url: 'https://pps.whatsapp.net/v/t61/pic.jpg', state: 'ready', fetched_at: 20 });
    assert.deepEqual(store.getAvatar(PHONE), { jid: PHONE, url: 'https://pps.whatsapp.net/v/t61/pic.jpg', state: 'ready', fetched_at: 20 });

    // A LID that turns out to be the same person carries the picture across and leaves nothing behind.
    store.upsertChat({ jid: LID, kind: '1:1' });
    store.upsertChat({ jid: PHONE, kind: '1:1' });
    store.setAvatar({ jid: LID, url: 'https://pps.whatsapp.net/v/t61/older.jpg', state: 'ready', fetched_at: 5 });
    assert.deepEqual(store.linkIdentityAndMergeChats({ lidJid: LID, phoneJid: PHONE }), { from: LID, to: PHONE });
    assert.equal(store.getAvatar(PHONE)?.url, 'https://pps.whatsapp.net/v/t61/pic.jpg', 'the fresher answer wins');
    assert.equal(store.getAvatar(LID), undefined, 'and the jid that no longer exists is not asked about again');
  } finally {
    db.close();
  }
});

test('a cache clear empties the transport rows and envelopes and leaves the rest of the database alone', () => {
  const db = new Database(':memory:');
  try {
    const store = createWhatsAppStore(db);
    const cache = createInboxCache(db, { alsoClear: [() => store.clear()] });
    const audit = createSendAudit(db);
    handleHistorySet(store, history);
    cache.save('whatsapp', [{ account: 'whatsapp', id: 'team@g.us', title: 'Team', preview: 'hi', date: 1, unread: false }]);
    store.setAvatar({ jid: 'team@g.us', url: 'https://pps.whatsapp.net/v/t61/pic.jpg', state: 'ready', fetched_at: 1 });
    audit.record({ at: 1, operation: 'send', account: 'whatsapp', conversationId: 'team@g.us', decision: 'allowed' });

    // The account state is a directory beside the database (src/whatsapp/auth.ts), not a table: a
    // clear has no path to it, and pairing again is the only thing that may forget it.
    const authDir = mkdtempSync(join(tmpdir(), 'wa-store-clear-'));
    writeFileSync(join(authDir, 'creds'), 'a device identity');

    cache.clear();

    assert.deepEqual(cache.list(), []);
    assert.equal(store.countMessages(), 0, 'messages go with the clear');
    assert.equal(store.getMessage('group-target'), undefined, 'so do the envelopes');
    assert.equal(store.getChat('team@g.us'), undefined);
    assert.equal(store.getContact('alice@s.whatsapp.net'), undefined);
    assert.equal(store.getAvatar('team@g.us'), undefined, 'a picture is cached state, so it goes too — it is re-asked');
    assert.equal(store.listMessageReactions('team@g.us', 'group-target').length, 0);
    assert.equal((db.prepare('SELECT COUNT(*) AS c FROM inbox_send_audit').get() as { c: number }).c, 1, 'the audit table is not a cache');
    assert.equal(readFileSync(join(authDir, 'creds'), 'utf8'), 'a device identity');
  } finally {
    db.close();
  }
});

test('an existing install opens with empty wa_ tables and its cached rows intact', () => {
  const db = new Database(':memory:');
  try {
    // A database created by the schema that shipped before this unit: the browser's cache, with data.
    const before = createInboxCache(db);
    before.save('whatsapp', [{ account: 'whatsapp', id: 'j@s.whatsapp.net', title: 'Jo', preview: 'hello', date: 5, unread: true }]);
    before.save('gmail-personal', [{ account: 'gmail-personal', id: 'm1', title: 'Subject', preview: 'body', date: 6, unread: false }]);

    const store = createWhatsAppStore(db);

    assert.equal(store.countMessages(), 0, 'the transport starts empty, it does not invent history');
    assert.deepEqual(
      before.list().map((row) => [row.account, row.id]),
      [['gmail-personal', 'm1'], ['whatsapp', 'j@s.whatsapp.net']],
      'the projection is untouched by the new tables',
    );
    // Opening again is a no-op — this runs on every start, and there is no migration runner.
    createWhatsAppStore(db);
    assert.equal(store.countMessages(), 0);
  } finally {
    db.close();
  }
});

test('asking for older history uses the oldest stored envelope', async () => {
  const { db, store } = fixture();
  try {
    handleHistorySet(store, history);
    const asked: Array<{ count: number; key: unknown; timestamp: number }> = [];
    const result = await deepenChatHistory(
      store,
      async (count, key, timestamp) => {
        asked.push({ count, key, timestamp });
        return 'session-1';
      },
      'team@g.us',
      50,
    );
    assert.deepEqual(result, { requested: true, sessionId: 'session-1', oldestMsgId: 'group-target' });
    assert.equal(asked.length, 1);
    assert.equal(asked[0]!.timestamp, 1700000000);
    assert.deepEqual(await deepenChatHistory(store, async () => 'x', 'nobody@s.whatsapp.net'), {
      requested: false,
      reason: 'no-messages',
    });
  } finally {
    db.close();
  }
});

test('a group participant list is where a synced sender gets their name', (t) => {
  const { db, store } = fixture();
  try {
    // The state the owner saw: a stored message whose sender is a LID with no contact row, because
    // history sync carries no `pushName` and a contact is only pushed when it changes.
    const sender = '69763254460511@lid';
    handleHistorySet(store, {
      chats: [{ id: '491724684626-1632930194@g.us', name: 'Parents', conversationTimestamp: 1_700_000 }],
      contacts: [],
      messages: [
        {
          key: { id: 'A1', remoteJid: '491724684626-1632930194@g.us', fromMe: false, participant: sender },
          messageTimestamp: 1_700_001,
          message: { conversation: 'Hello' },
        },
      ] as WAMessage[],
    } as HistorySetPayload);

    const group = {
      id: '491724684626-1632930194@g.us',
      subject: 'Parents',
      participants: [{ id: sender, name: '', notify: 'Ignacio Joaristi', admin: null }],
    } as unknown as Parameters<typeof ingestBaileysGroup>[1];

    ingestBaileysGroup(store, group);

    const contact = store.getContact(sender);
    assert.equal(contact?.push_name, 'Ignacio Joaristi', 'the self-chosen name reaches the contact row');
    assert.equal(store.getContact('nobody@lid'), undefined, 'a participant with no name writes nothing');

    ingestBaileysGroup(store, { ...group, participants: [{ id: 'nobody@lid', admin: null }] } as never);
    assert.equal(store.getContact('nobody@lid'), undefined);
  } finally {
    db.close();
  }
});

test('the ingest bindings never throw into the socket and detach cleanly', (t) => {
  t.mock.method(console, 'error', () => {});
  const { db, store } = fixture();
  try {
    const handlers = new Map<string, (...args: unknown[]) => void>();
    const ev = {
      on(event: string, handler: (...args: unknown[]) => void) {
        handlers.set(event, handler);
      },
      off(event: string) {
        handlers.delete(event);
      },
    };
    const errors: string[] = [];
    const detach = attachIngest(ev, store, { onHandlerError: ({ event }) => errors.push(event) });
    assert.ok(handlers.has('messaging-history.set'));

    // A malformed batch must be contained, not thrown at Baileys: one bad event cannot drop the rest.
    handlers.get('messaging-history.set')!({ chats: null, contacts: [], messages: [] });
    assert.deepEqual(errors, ['messaging-history.set']);

    detach();
    assert.equal(handlers.size, 0, 'detach removes the identical function objects');
  } finally {
    db.close();
  }
});
