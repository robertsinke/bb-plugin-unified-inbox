// The Gmail adapter's side of the transport seam (plan unit U3). The adapter must speak the typed
// contract and nothing else: every provider call is a named endpoint, a rejection is normalized once
// at the source boundary, and the bytes an attachment read returns are used as they arrive rather
// than decoded a second time here.
import assert from 'node:assert/strict';
import test from 'node:test';
import { GmailApiError } from '../../src/gmail-client.ts';
import { harness } from './harness.ts';

const TOKEN = 'ya29.a0AfH6SMBx9TcdefGHijklmnopqrstuvwxyz1234567890';

test('a transport rejection becomes one scrubbed ProviderError message at the source boundary', async () => {
  const h = harness({ gmailCall: () => { throw new GmailApiError(401, 'authError', `Invalid Credentials for Bearer ${TOKEN}`, 'GET /users/me/profile'); } });
  try {
    await assert.rejects(h.registry['gmail-personal'].list(), (error: Error) => {
      assert.match(error.message, /^gmail gmail-personal request failed \(401; credentials, invalid\)/, 'classification survives the transport');
      assert.ok(!error.message.includes(TOKEN), 'the token must not reach the panel');
      return true;
    });
    assert.deepEqual(h.calls, ['gmail:gmail-personal:getProfile'], 'one failure is one message, not a retry storm');
  } finally { h.close(); }
});

test('a remote attachment is fetched once and its bytes are used as they arrive', async () => {
  const bytes = Buffer.from('remote bytes');
  const h = harness({
    gmailCall: (_account, call) => {
      if (call.method === 'messageGet') {
        return {
          id: 'm-att',
          payload: {
            mimeType: 'multipart/mixed',
            parts: [{ filename: 'notes.txt', mimeType: 'text/plain', body: { attachmentId: 'att-9', size: bytes.length } }],
          },
        };
      }
      if (call.method === 'attachmentGet') {
        assert.deepEqual(call.input, { messageId: 'm-att', id: 'att-9' }, 'the fetch names the message and the part');
        return bytes;
      }
      throw new Error(`unexpected Gmail call: ${call.method}`);
    },
  });
  try {
    const file = await h.registry['gmail-personal'].media({ kind: 'attachment', id: 'm-att', filename: 'notes.txt' });
    assert.equal(file.dataUrl, `data:text/plain;base64,${bytes.toString('base64')}`, 'the transport decoded once; the adapter re-encodes for the frame');
    assert.equal(file.size, bytes.length);
    assert.deepEqual(h.calls, ['gmail:gmail-personal:messages:get', 'gmail:gmail-personal:messages:attachments']);
  } finally { h.close(); }
});

test('an HTML body that only exists as an attachment is fetched through the same typed call', async () => {
  const h = harness({
    gmailCall: (_account, call) => {
      if (call.method === 'threadGet') {
        return {
          id: 't1',
          messages: [{
            id: 'm1',
            internalDate: '1700000000000',
            snippet: '',
            payload: {
              mimeType: 'multipart/alternative',
              headers: [{ name: 'Subject', value: 'Dinner' }],
              parts: [{ mimeType: 'text/html', body: { attachmentId: 'html-1', size: 1200 } }],
            },
          }],
        };
      }
      if (call.method === 'attachmentGet') return Buffer.from('<p>Hello</p>');
      throw new Error(`unexpected Gmail call: ${call.method}`);
    },
  });
  try {
    const opened = await h.registry['gmail-personal'].open('t1');
    assert.equal(opened.messages[0].html, '<p>Hello</p>');
    assert.deepEqual(h.calls, ['gmail:gmail-personal:threads:get', 'gmail:gmail-personal:messages:attachments']);
  } finally { h.close(); }
});
