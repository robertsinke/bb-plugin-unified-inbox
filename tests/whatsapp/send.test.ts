// U1 — the send surface is a type plus a guard: a caller with no socket must get `offline`, never a
// silent return. The actual send path (gate, audit, delivery) is U5's.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createWhatsAppSendTransport, WhatsAppDisconnectedError, type WhatsAppSendSocket } from '../../src/whatsapp/send.ts';

test('every call refuses with WhatsAppDisconnectedError when there is no socket', async () => {
  const transport = createWhatsAppSendTransport(() => undefined);
  await assert.rejects(() => transport.sendText('jid@s.whatsapp.net', 'hi', 'MSG1'), WhatsAppDisconnectedError);
  await assert.rejects(() => transport.setPresence('jid@s.whatsapp.net', 'composing'), WhatsAppDisconnectedError);
  await assert.rejects(() => transport.markRead('jid@s.whatsapp.net', 'MSG1'), WhatsAppDisconnectedError);
  await assert.rejects(
    () => transport.sendReaction('jid@s.whatsapp.net', { id: 'MSG1', remoteJid: 'jid@s.whatsapp.net' }, '👍'),
    WhatsAppDisconnectedError,
  );
});

test('a send carries the message id, the quote, and nothing else', async () => {
  const calls: Array<Record<string, unknown>> = [];
  const socket = {
    async sendPresenceUpdate(type: string, jid: string) {
      calls.push({ type, jid });
    },
    async sendMessage(jid: string, content: unknown, options: unknown) {
      calls.push({ jid, content, options });
      return {};
    },
    async readMessages(keys: unknown) {
      calls.push({ keys });
    },
  };
  const transport = createWhatsAppSendTransport(() => socket as unknown as WhatsAppSendSocket);
  const quoted = { key: { id: 'QUOTED' } };

  await transport.sendText('jid@s.whatsapp.net', 'hello', 'MSG1', quoted as never);
  assert.deepEqual(calls.at(-1), {
    jid: 'jid@s.whatsapp.net',
    content: { text: 'hello' },
    options: { messageId: 'MSG1', quoted },
  });
});

test('a reaction sends the emoji, and an empty emoji removes it', async () => {
  const calls: Array<Record<string, unknown>> = [];
  const socket = {
    async sendPresenceUpdate() {},
    async sendMessage(jid: string, content: unknown) {
      calls.push({ jid, content });
      return {};
    },
    async readMessages() {},
  };
  const transport = createWhatsAppSendTransport(() => socket as unknown as WhatsAppSendSocket);
  const key = { id: 'MSG1', remoteJid: 'jid@s.whatsapp.net' };

  await transport.sendReaction('jid@s.whatsapp.net', key, '👍');
  await transport.sendReaction('jid@s.whatsapp.net', key, '');
  assert.deepEqual(calls, [
    { jid: 'jid@s.whatsapp.net', content: { react: { text: '👍', key } } },
    { jid: 'jid@s.whatsapp.net', content: { react: { text: '', key } } },
  ]);
});
