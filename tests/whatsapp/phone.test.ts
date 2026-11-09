import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import type { WhatsAppConnection } from '../../src/whatsapp/connection.ts';
import { WHATSAPP_OFFLINE, WHATSAPP_OWN_NUMBER, WHATSAPP_UNKNOWN_NUMBER, whatsAppPhoneDigits } from '../../src/whatsapp/phone.ts';
import { createWhatsAppStore } from '../../src/whatsapp/store.ts';
import { createWhatsAppTransport } from '../../src/whatsapp/transport.ts';

function store() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  return createWhatsAppStore(db);
}

test('a phone number is 7 to 15 digits', () => {
  assert.equal(whatsAppPhoneDigits('+31 6 12345678'), '31612345678');
  assert.equal(whatsAppPhoneDigits('123456'), null);
  assert.equal(whatsAppPhoneDigits('1234567890123456'), null);
  assert.equal(whatsAppPhoneDigits(''), null);
});

test('a stored contact answers with its phone jid and does not open a socket', async () => {
  const saved = store();
  saved.upsertContact({ jid: '111@lid', phone_jid: '31612345678@s.whatsapp.net', name: 'Ada' });
  let opened = 0;
  const transport = createWhatsAppTransport({
    store: saved,
    connection: () => undefined,
    ensure: async () => { opened += 1; return undefined; },
  });
  assert.equal(await transport.resolvePhone('31612345678'), '31612345678@s.whatsapp.net');
  assert.equal(opened, 0);
});

test('an open socket confirms a number that is not stored', async () => {
  const transport = createWhatsAppTransport({
    store: store(),
    connection: () => ({
      getSendSocket: () => ({
        onWhatsApp: async () => [{ jid: '31612345678@s.whatsapp.net', exists: true }],
      }),
      status: () => 'connected',
    }) as unknown as WhatsAppConnection,
    ensure: async () => { throw new Error('lookup must not open a socket'); },
  });
  assert.equal(await transport.resolvePhone('31612345678'), '31612345678@s.whatsapp.net');
});

test('a number the socket cannot confirm is refused before any send', async () => {
  const transport = createWhatsAppTransport({
    store: store(),
    connection: () => ({
      getSendSocket: () => ({ onWhatsApp: async () => [{ exists: false }] }),
      status: () => 'connected',
    }) as unknown as WhatsAppConnection,
    ensure: async () => undefined,
  });
  await assert.rejects(() => transport.resolvePhone('31612345678'), new Error(WHATSAPP_UNKNOWN_NUMBER));
});

test('no open socket and no stored contact refuses before any send', async () => {
  const transport = createWhatsAppTransport({
    store: store(),
    connection: () => undefined,
    ensure: async () => { throw new Error('lookup must not open a socket'); },
  });
  await assert.rejects(() => transport.resolvePhone('31612345678'), new Error(WHATSAPP_OFFLINE));
});

test('the owner number is refused', async () => {
  const transport = createWhatsAppTransport({
    store: store(),
    connection: () => ({
      getSendSocket: () => ({
        user: { id: '31612345678:1@s.whatsapp.net' },
        onWhatsApp: async () => [{ jid: '31612345678@s.whatsapp.net', exists: true }],
      }),
      status: () => 'connected',
    }) as unknown as WhatsAppConnection,
    ensure: async () => undefined,
  });
  await assert.rejects(() => transport.resolvePhone('31612345678'), new Error(WHATSAPP_OWN_NUMBER));
});
