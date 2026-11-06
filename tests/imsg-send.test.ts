import assert from 'node:assert/strict';
import test from 'node:test';
import { IMSG_TEXT_LIMIT, imsgSendStatus, imsgText, sendImsgTapback, sendImsgText } from '../src/imsg-send.ts';

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

test('a reply to one message is one send that carries the guid', async () => {
  const client = sender({ ok: true, guid: 'g-2' });
  assert.equal(await sendImsgText(client, '50', '  hello  ', 'parent-guid'), 'Sent.');
  assert.equal(client.calls.length, 1);
  assert.deepEqual(client.calls[0], { method: 'send', params: { chat_id: 50, text: 'hello', reply_to: 'parent-guid' } });
  assert.notDeepEqual(client.calls[0].params, { chat_id: 50, text: 'hello' });
});

test('a bridge refusal on a targeted reply does not send again', async () => {
  let calls = 0;
  const client = {
    request: () => {
      calls += 1;
      return Promise.reject(new Error('Messages request failed (code -32603): the bridge is required'));
    },
  };
  await assert.rejects(sendImsgText(client, '50', 'hello', 'parent-guid'), /bridge/);
  assert.equal(calls, 1);
});

test('each of the four emoji is one tapback kind, and removal keeps that kind', async () => {
  const client = sender({ ok: true });
  assert.equal(await sendImsgTapback(client, 'guid-1', '👍'), 'Sent.');
  assert.equal(await sendImsgTapback(client, 'guid-1', '❤️'), 'Sent.');
  assert.equal(await sendImsgTapback(client, 'guid-1', '👎'), 'Sent.');
  assert.equal(await sendImsgTapback(client, 'guid-1', '😂', true), 'Sent.');
  assert.deepEqual(client.calls, [
    { method: 'tapback', params: { message_guid: 'guid-1', kind: 'like' } },
    { method: 'tapback', params: { message_guid: 'guid-1', kind: 'heart' } },
    { method: 'tapback', params: { message_guid: 'guid-1', kind: 'dislike' } },
    { method: 'tapback', params: { message_guid: 'guid-1', kind: 'laugh', remove: true } },
  ]);
  assert.equal(client.calls.some(call => call.method === 'send'), false);
});

test('emphasis and question do not call tapback', async () => {
  const client = sender({ ok: true });
  await assert.rejects(sendImsgTapback(client, 'guid-1', '‼️'), /four reactions/);
  await assert.rejects(sendImsgTapback(client, 'guid-1', '❓'), /four reactions/);
  assert.deepEqual(client.calls, []);
});

test('a tapback timeout is unknown and is not sent again', async () => {
  let calls = 0;
  const client = {
    request: () => {
      calls += 1;
      return Promise.reject(new Error('Messages request timed out'));
    },
  };
  await assert.rejects(sendImsgTapback(client, 'guid-1', '👍'), /unknown/);
  assert.equal(calls, 1);
});

test('an unconfirmed tapback is unknown and is not sent again', async () => {
  let calls = 0;
  const client = {
    request: () => {
      calls += 1;
      return Promise.reject(new Error('Messages request failed (code -32001)'));
    },
  };
  await assert.rejects(sendImsgTapback(client, 'guid-1', '👍'), /unknown/);
  assert.equal(calls, 1);
});

test('a bridge refusal on a tapback does not call send', async () => {
  const calls: string[] = [];
  const client = {
    request: (method: string) => {
      calls.push(method);
      return Promise.reject(new Error('the bridge is required'));
    },
  };
  await assert.rejects(sendImsgTapback(client, 'guid-1', '👍'), /bridge/);
  assert.deepEqual(calls, ['tapback']);
});
