import assert from 'node:assert/strict';
import test from 'node:test';
import { IMSG_TEXT_LIMIT, imsgSendStatus, imsgText, sendImsgText } from '../src/imsg-send.ts';

const sender = (result: unknown) => {
  const calls: { method: string; params?: Record<string, unknown> }[] = [];
  return { calls, request: (method: string, params?: Record<string, unknown>) => { calls.push({ method, params }); return Promise.resolve(result); } };
};

test('a send needs text and stays within the limit', () => {
  assert.throws(() => imsgText('   '), /needs text/);
  assert.throws(() => imsgText('a'.repeat(IMSG_TEXT_LIMIT + 1)), /limited to/);
  assert.equal(imsgText('  hi  '), 'hi');
  assert.equal(imsgText('a'.repeat(IMSG_TEXT_LIMIT)).length, IMSG_TEXT_LIMIT);
});

test('a send reaches the chat id the inbox row carries', async () => {
  const client = sender({ ok: true, guid: 'g-1' });
  assert.equal(await sendImsgText(client, '50', '  hello  '), 'Sent.');
  assert.deepEqual(client.calls, [{ method: 'send', params: { chat_id: 50, text: 'hello' } }]);
});

test('a chat id that is not a Messages chat is refused before the backend', async () => {
  const client = sender({ ok: true });
  await assert.rejects(sendImsgText(client, 'urn:li:msg_conversation:1', 'hi'), /Invalid Messages conversation/);
  assert.deepEqual(client.calls, []);
});

test('an unconfirmed send never reports success, and is never retried', async () => {
  assert.throws(() => imsgSendStatus({ ok: false }), /did not send/);
  assert.match(imsgSendStatus({ ok: true }), /no delivery id/);
  const client = { request: () => Promise.reject(new Error('Messages request failed (code -32001)')) };
  await assert.rejects(sendImsgText(client, '50', 'hi'), /could not confirm the send/);
});

test('a backend failure keeps its own message', async () => {
  const client = { request: () => Promise.reject(new Error('Messages backend exited')) };
  await assert.rejects(sendImsgText(client, '50', 'hi'), /backend exited/);
});
