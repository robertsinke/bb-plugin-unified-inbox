// The Gmail adapter's side of the transport seam (plan unit U3). The adapter must speak the typed
// contract and nothing else: every provider call is a named endpoint, a rejection is normalized once
// at the source boundary, and the bytes an attachment read returns are used as they arrive rather
// than decoded a second time here.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createGmailClient, GmailApiError } from '../../src/gmail-client.ts';
import { createGmailCredentials } from '../../src/gmail-oauth.ts';
import { PeopleApiError } from '../../src/google-people.ts';
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

// INBOX-13 / U5: with the CLI runner gone, an account nobody imported yet is the ordinary case, not
// a crash. The real credential store, the real HTTPS client and the real adapter are used here; the
// only fake is the network, which must never be reached because there is no token to send.
test('an account with no stored credential fails as one scrubbed ProviderError, offline', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bb-inbox-nocredential-'));
  const offline = async (url: string) => { throw new Error(`the network was reached without a credential: ${url}`); };
  const credentials = createGmailCredentials({ dir, fetch: offline });
  const h = harness({ gmail: account => createGmailClient({ account, credentials, fetch: offline }) });
  try {
    await assert.rejects(h.registry['gmail-personal'].list(), (error: Error) => {
      assert.match(error.message, /^gmail gmail-personal request failed \(unknown/, 'the ProviderError template still classifies it');
      assert.match(error.message, /No Gmail credential for gmail-personal/i, 'the account that needs one is named');
      assert.match(
        error.message,
        /bb unified-inbox import-gws-account gmail-personal$/,
        'the fix survives redaction: a path here would be scrubbed to [redacted]',
      );
      assert.doesNotMatch(error.message, /ENOENT/, 'a missing file is reported as a missing credential, not as a filesystem error');
      return true;
    });
    assert.deepEqual(h.calls, [], 'nothing crossed the adapter boundary: there was no token to send');
    assert.equal((await credentials.status('gmail-personal')).present, false, 'the state is inspectable without an exception');
  } finally { h.close(); await rm(dir, { recursive: true, force: true }); }
});

// INBOX-38 — a Gmail row's face. The adapter stamps what the contact store already knows, and the
// ask that fills it runs behind the draw: initials first, the picture on a later read, and a URL the
// allowlist refuses is dropped rather than drawn.

const FACE = 'https://lh3.googleusercontent.com/a/ACg8ocPhoto=s96-c';

/** The background drain is deliberately not awaited by the read that started it. */
async function settle(): Promise<void> {
  for (let round = 0; round < 4; round += 1) await new Promise(resolve => setImmediate(resolve));
}

test('a row draws initials first, and its sender’s contact photo on a later read', async () => {
  const photos = [{ address: 'ada@example.com', url: FACE }];
  const h = harness({ people: { connections: async () => ({ photos }) } });
  try {
    const first = await h.registry['gmail-personal'].list();
    assert.equal(first.items[0]?.senderAddress, 'ada@example.com', 'the address is carried, because a face is keyed by it');
    assert.equal(first.items[0]?.avatarUrl, undefined, 'nothing was cached yet, so the row drew initials');
    await settle();
    const second = await h.registry['gmail-personal'].list();
    assert.equal(second.items[0]?.avatarUrl, FACE, 'the same cached row now draws the picture');
  } finally { h.close(); }
});

test('a cached row is drawn with the face the store already knows, without waiting for a sync', async () => {
  // The panel paints from the cache first, and a row cached before its sender's photo was learned
  // kept its initials until that thread changed again. `decorate` is the read that answers this:
  // every list, cached or fresh, passes a row through it.
  const h = harness({ people: { connections: async () => ({ photos: [{ address: 'ada@example.com', url: FACE }] }) } });
  try {
    const decorated = h.registry['gmail-personal'].decorate;
    assert.ok(decorated, 'the Gmail adapter answers a face on every read');
    const row = { account: 'gmail-personal' as const, id: 'thread-1', title: '', preview: '', date: 0, unread: false, sender: 'Ada Lovelace', senderAddress: 'ada@example.com' };
    decorated(row);
    await settle();
    assert.equal(decorated(row).avatarUrl, FACE, 'a row from the cache draws the picture the store holds');
    assert.equal(decorated({ ...row, senderAddress: 'grace@example.com' }).avatarUrl, undefined, 'and a sender with no photo keeps its initials');
    assert.equal(decorated({ ...row, senderAddress: undefined }).avatarUrl, undefined, 'a row that carries no address asks for nothing');
  } finally { h.close(); }
});

test('a photo URL the allowlist refuses is dropped, so the row keeps drawing initials', async () => {
  const h = harness({ people: { connections: async () => ({ photos: [{ address: 'ada@example.com', url: 'https://evil.example/face.png' }] }) } });
  try {
    await h.registry['gmail-personal'].list();
    await settle();
    const rows = await h.registry['gmail-personal'].list();
    assert.equal(rows.items[0]?.avatarUrl, undefined, 'a URL from another host never reaches the frame');
  } finally { h.close(); }
});

test('a refused People read leaves the row alone and makes no error row', async () => {
  const notes: string[] = [];
  const refused = new PeopleApiError(403, 'forbidden', 'Request had insufficient authentication scopes.', 'people/me/connections');
  const h = harness({
    notes,
    people: {
      connections: async () => { throw refused; },
      otherContacts: async () => { throw refused; },
    },
  });
  try {
    const result = await h.registry['gmail-personal'].list();
    await settle();
    assert.equal(result.errors.length, 0, 'a source without consent is inert, not broken');
    assert.equal(result.items.length, 1, 'and the row is still drawn');
    assert.equal(result.items[0]?.avatarUrl, undefined);
    assert.equal(notes.length, 1, 'one line names what is missing, not one per row');
    assert.match(notes[0], /contacts\.readonly is not granted/);
  } finally { h.close(); }
});
