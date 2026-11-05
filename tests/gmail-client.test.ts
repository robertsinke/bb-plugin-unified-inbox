// INBOX-10 / U2: the plugin's Gmail API client. Every method here is asserted against a fake
// `fetch` — no network, no CLI — and the 401 rule is exercised where it matters: mid-flight.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createGmailClient, GmailApiError, type GmailFetch } from '../src/gmail-client.ts';
import { toProviderError } from '../src/adapters/provider-error.ts';
import type { GmailAccount } from '../src/adapters/types.ts';

const ACCOUNT: GmailAccount = 'gmail-personal';
const API = 'https://gmail.googleapis.com/gmail/v1';
const CREDENTIALS = 'Request had invalid authentication credentials. Expected OAuth 2 access token, login cookie or other valid authentication credential.';

interface Reply {
  status?: number;
  body?: unknown;
  /** A body that is not JSON at all — a proxy's error page, say. */
  text?: string;
}

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

/** The Gmail API as a queue of replies, recording every request it was handed. */
function fakeGmail(replies: Reply[]) {
  const calls: Call[] = [];
  let index = 0;
  const fetch: GmailFetch = async (url, init) => {
    calls.push({ url, ...init });
    const reply = replies[Math.min(index++, replies.length - 1)];
    const status = reply.status ?? 200;
    const text = reply.text ?? (reply.body === undefined ? '' : JSON.stringify(reply.body));
    return { ok: status >= 200 && status < 300, status, text: async () => text };
  };
  return { fetch, calls };
}

/** U1's store, standing in: a cached token, and a different one after a forced refresh. */
function fakeCredentials() {
  const calls: { force: boolean }[] = [];
  const credentials = {
    async accessToken(_account: GmailAccount, opts: { force?: boolean } = {}) {
      calls.push({ force: Boolean(opts.force) });
      return opts.force ? 'token-fresh' : 'token-cached';
    },
  };
  return { credentials, calls };
}

function clientFor(replies: Reply[]) {
  const { fetch, calls } = fakeGmail(replies);
  const tokens = fakeCredentials();
  const client = createGmailClient({ account: ACCOUNT, credentials: tokens.credentials, fetch });
  return { client, calls, tokenCalls: tokens.calls };
}

/** Gmail's own error envelope, as every failing endpoint returns it. */
function providerError(status: number, reason: string, message: string) {
  return { error: { code: status, message, errors: [{ message, reason }], status: 'FAILED_PRECONDITION' } };
}

test('threadsList puts labelIds, maxResults and pageToken in the query and returns the page', async () => {
  const page = { threads: [{ id: 't1', historyId: '99', snippet: 'hello' }], resultSizeEstimate: 42, nextPageToken: 'p2' };
  const { client, calls, tokenCalls } = clientFor([{ body: page }]);

  const answer = await client.threadsList({ labelIds: ['INBOX', 'UNREAD'], maxResults: 10, pageToken: 'p1' });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].url, `${API}/users/me/threads?labelIds=INBOX&labelIds=UNREAD&maxResults=10&pageToken=p1`);
  assert.equal(calls[0].headers.authorization, 'Bearer token-cached');
  assert.equal(calls[0].headers['content-type'], undefined);
  assert.equal(calls[0].body, undefined);
  assert.deepEqual(tokenCalls, [{ force: false }]);
  assert.deepEqual(answer, page);
});

test('threadsList omits empty inputs rather than sending them blank', async () => {
  const { client, calls } = clientFor([{ body: {} }]);
  const answer = await client.threadsList({ maxResults: 5 });
  assert.equal(calls[0].url, `${API}/users/me/threads?maxResults=5`);
  assert.equal(answer.nextPageToken, undefined);
});

test('a metadata read sends format and the headers a cached row needs; a full read sends neither', async () => {
  const { client, calls } = clientFor([{ body: { id: 't1', messages: [] } }, { body: { id: 't2', messages: [] } }, { body: { id: 't3' } }]);

  const thread = await client.threadGet({ id: 't1', format: 'metadata' });
  assert.equal(thread.id, 't1');
  assert.equal(
    calls[0].url,
    `${API}/users/me/threads/t1?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc`
    + '&metadataHeaders=Subject&metadataHeaders=Message-ID&metadataHeaders=References&metadataHeaders=Reply-To',
  );

  await client.threadGet({ id: 't2', format: 'full' });
  assert.equal(calls[1].url, `${API}/users/me/threads/t2?format=full`);

  await client.threadGet({ id: 't3', format: 'metadata', metadataHeaders: ['From', 'Subject'] });
  assert.equal(calls[2].url, `${API}/users/me/threads/t3?format=metadata&metadataHeaders=From&metadataHeaders=Subject`);
});

test('messageGet defaults to a full read and encodes the id', async () => {
  const { client, calls } = clientFor([{ body: { id: 'm1', payload: { mimeType: 'text/plain' } } }]);
  const message = await client.messageGet({ id: 'm+1/2' });
  assert.equal(calls[0].url, `${API}/users/me/messages/m%2B1%2F2?format=full`);
  assert.equal(message.id, 'm1');
});

test('profile returns the mailbox history id the cache cursor is built from', async () => {
  const { client, calls } = clientFor([{ body: { emailAddress: 'personal@example.com', historyId: '12345' } }]);
  const profile = await client.profile();
  assert.equal(calls[0].url, `${API}/users/me/profile`);
  assert.equal(profile.historyId, '12345');
});

test('threadsModify posts label changes as one JSON body', async () => {
  const { client, calls } = clientFor([{ body: { id: 't1' } }, { body: { id: 't2' } }]);

  await client.threadsModify({ id: 't1', removeLabelIds: ['INBOX'] });
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].url, `${API}/users/me/threads/t1/modify`);
  assert.equal(calls[0].headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0].body as string), { addLabelIds: [], removeLabelIds: ['INBOX'] });

  await client.threadsModify({ id: 't2', addLabelIds: ['UNREAD'] });
  assert.deepEqual(JSON.parse(calls[1].body as string), { addLabelIds: ['UNREAD'], removeLabelIds: [] });
});

test('attachmentGet decodes base64url data to the bytes the CLI path decodes to', async () => {
  const bytes = Buffer.from([0x00, 0xff, 0x7f, 0x10, 0xab, 0xcd]);
  const { client, calls } = clientFor([{ body: { data: bytes.toString('base64url'), size: bytes.length } }]);

  const answer = await client.attachmentGet({ messageId: 'm1', id: 'a1' });

  assert.equal(calls[0].url, `${API}/users/me/messages/m1/attachments/a1`);
  assert.deepEqual(Buffer.from(answer), bytes);
});

test('attachmentGet throws when the answer carries no data', async () => {
  const { client } = clientFor([{ body: { size: 0 } }]);
  await assert.rejects(client.attachmentGet({ messageId: 'm1', id: 'a1' }), /no data for attachment a1/);
});

test('sendRaw base64url-encodes the message and names a thread only on a reply', async () => {
  const raw = Buffer.from('Subject: hi\r\n\r\nbody', 'utf8');
  const { client, calls } = clientFor([{ body: { id: 's1' } }, { body: { id: 's2', threadId: 't9' } }]);

  const sent = await client.sendRaw({ raw });
  assert.equal(sent.id, 's1');
  assert.equal(calls[0].url, `${API}/users/me/messages/send`);
  assert.equal(calls[0].method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].body as string), { raw: raw.toString('base64url') });
  assert.equal('threadId' in JSON.parse(calls[0].body as string), false);

  await client.sendRaw({ raw, threadId: 't9' });
  assert.deepEqual(JSON.parse(calls[1].body as string), { raw: raw.toString('base64url'), threadId: 't9' });
});

test('a 401 mid-threadsList refreshes once, retries the same request, and returns the page', async () => {
  const page = { threads: [{ id: 't1' }], nextPageToken: 'p2' };
  const { client, calls, tokenCalls } = clientFor([
    { status: 401, body: providerError(401, 'authError', CREDENTIALS) },
    { body: page },
  ]);

  const answer = await client.threadsList({ labelIds: ['INBOX'], maxResults: 10 });

  assert.deepEqual(answer, page);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, calls[1].url);
  assert.equal(calls[1].method, 'GET');
  assert.equal(calls[1].body, undefined);
  assert.equal(calls[0].headers.authorization, 'Bearer token-cached');
  assert.equal(calls[1].headers.authorization, 'Bearer token-fresh');
  assert.deepEqual(tokenCalls, [{ force: false }, { force: true }]);
});

test('a 401 on a POST retries with the same body, not a rebuilt one', async () => {
  const { client, calls } = clientFor([
    { status: 401, body: providerError(401, 'authError', CREDENTIALS) },
    { body: { id: 't1' } },
  ]);
  await client.threadsModify({ id: 't1', addLabelIds: ['UNREAD'] });
  assert.equal(calls[1].url, calls[0].url);
  assert.equal(calls[1].body, calls[0].body);
  assert.equal(calls[1].headers.authorization, 'Bearer token-fresh');
});

test('a persisting 401 fails with the provider reason so the expired/invalid/token hints survive', async () => {
  const { client, calls, tokenCalls } = clientFor([{ status: 401, body: providerError(401, 'authError', CREDENTIALS) }]);

  const error = await client.threadGet({ id: 't1' }).then(() => null, (cause: unknown) => cause as GmailApiError);

  assert.ok(error instanceof GmailApiError);
  assert.equal(error.status, 401);
  assert.equal(error.reason, 'authError');
  assert.equal(error.code, 401);
  assert.match(error.message, /Request had invalid authentication credentials/);
  // One retry, not a loop: the cached token and exactly one forced refresh.
  assert.equal(calls.length, 2);
  assert.deepEqual(tokenCalls, [{ force: false }, { force: true }]);

  const provider = toProviderError(ACCOUNT, 'gmail', error);
  assert.match(provider.message, /\(401;/);
  assert.match(provider.message, /invalid/);
  assert.match(provider.message, /token/);
});

test('a 401 whose refresh is rejected surfaces the refresh failure, not a second 401', async () => {
  let forced = 0;
  const credentials = {
    async accessToken(_account: GmailAccount, opts: { force?: boolean } = {}) {
      if (opts.force) {
        forced += 1;
        throw new Error('oauth token request failed (400 invalid_grant)');
      }
      return 'token-cached';
    },
  };
  const { fetch, calls } = fakeGmail([{ status: 401, body: providerError(401, 'authError', CREDENTIALS) }]);
  const client = createGmailClient({ account: ACCOUNT, credentials, fetch });

  await assert.rejects(client.profile(), /invalid_grant/);
  assert.equal(forced, 1);
  assert.equal(calls.length, 1);
});

test('a 404 throws instead of handing back an empty object the cache would mistake for a message', async () => {
  const { client, tokenCalls } = clientFor([
    { status: 404, body: providerError(404, 'notFound', 'Requested entity was not found.') },
  ]);

  const error = await client.messageGet({ id: 'gone' }).then(() => null, (cause: unknown) => cause as GmailApiError);

  assert.ok(error instanceof GmailApiError);
  assert.equal(error.status, 404);
  assert.equal(error.reason, 'notFound');
  assert.match(error.message, /Requested entity was not found\./);
  // A 404 is not an authentication problem: no refresh, no retry.
  assert.deepEqual(tokenCalls, [{ force: false }]);
});

test('a 429 keeps the provider message and reason unchanged for the caller', async () => {
  const message = 'User-rate limit exceeded. Retry after 2026-11-05T12:00:00Z';
  const { client } = clientFor([{ status: 429, body: providerError(429, 'rateLimitExceeded', message) }]);

  const error = await client.threadsList({ maxResults: 10 }).then(() => null, (cause: unknown) => cause as GmailApiError);

  assert.ok(error instanceof GmailApiError);
  assert.equal(error.status, 429);
  assert.equal(error.reason, 'rateLimitExceeded');
  assert.equal(error.providerMessage, message);
  assert.ok(error.message.includes(message));
  assert.equal(toProviderError(ACCOUNT, 'gmail', error).message.includes(message), true);
});

test('a 5xx body that is not JSON still reports its text and status', async () => {
  const { client } = clientFor([{ status: 502, text: '  <html>502 Bad Gateway</html>\n' }]);

  const error = await client.threadGet({ id: 't1' }).then(() => null, (cause: unknown) => cause as GmailApiError);

  assert.ok(error instanceof GmailApiError);
  assert.equal(error.status, 502);
  assert.equal(error.reason, undefined);
  assert.equal(error.providerMessage, '<html>502 Bad Gateway</html>');
});
