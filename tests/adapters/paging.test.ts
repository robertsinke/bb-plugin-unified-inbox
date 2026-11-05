// Paging, proved at the transport seam. Gmail hands back its own `pageToken` for the page after
// the newest rows; the WhatsApp transport pages its store by row offset and answers a cursor only
// when another page exists. Both answers are reads only: the cache keeps holding the newest page,
// because every refresh replaces it wholesale and a second page written into it would vanish on the
// next one.
import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { createInboxCache } from '../../src/inbox-cache.ts';
import { createGmailAdapter } from '../../src/adapters/gmail.ts';
import { createWhatsAppAdapter } from '../../src/adapters/whatsapp.ts';
import { toProviderError } from '../../src/adapters/provider-error.ts';
import type { RegistryDeps } from '../../src/adapters/deps.ts';
import type { WhatsAppTransport } from '../../src/adapters/types.ts';
import { fakeWhatsAppTransport } from './harness.ts';

/** One Gmail thread as `threads.get` answers it: a subject, a sender and an internal date. */
function thread(id: string, subject: string, date: number) {
  return {
    id,
    messages: [{
      id: `m-${id}`,
      internalDate: String(date),
      snippet: `${subject} preview`,
      labelIds: [],
      payload: {
        mimeType: 'text/plain',
        headers: [
          { name: 'Subject', value: subject },
          { name: 'From', value: 'Ada Lovelace <ada@example.com>' },
          { name: 'To', value: 'robert@inhouse.works' },
        ],
        body: { data: Buffer.from(subject).toString('base64url') },
      },
    }],
  };
}

type GmailCall = { method: string; input?: any };

function fixture(gmail: (call: GmailCall) => unknown, whatsapp?: Partial<WhatsAppTransport>) {
  const db = new Database(':memory:');
  const cache = createInboxCache(db);
  const whatsappCalls: string[] = [];
  const calls: { gmail: GmailCall[] } = { gmail: [] };
  /** Every typed endpoint answers through the one stub, and the call itself is the record. */
  const client = (method: string) => async (input?: any) => {
    const call = { method, input };
    calls.gmail.push(call);
    return gmail(call);
  };
  const deps = {
    cache,
    // No contact photo is cached in this fixture: a face is not what a cursor test is about.
    gmailFaces: () => ({ url: () => undefined }),
    gmail: () => ({
      profile: client('profile'),
      threadsList: client('threadsList'),
      threadGet: client('threadGet'),
      threadsModify: client('threadsModify'),
      messageGet: client('messageGet'),
      attachmentGet: client('attachmentGet'),
      sendRaw: async (input: unknown) => { calls.gmail.push({ method: 'sendRaw', input }); return { id: 'sent' }; },
    }),
    whatsapp: fakeWhatsAppTransport(whatsappCalls, whatsapp),
    imsg: { request: async () => ({}) },
    linkedInPage: {},
    armLinkedInRecorder: async () => ({}),
    providerError: toProviderError,
  } as unknown as RegistryDeps;
  return { cache, calls, deps, close: () => db.close() };
}

/** The input a typed Gmail read carried, which is where its arguments travel. */
function input(call: GmailCall): any {
  return call.input ?? {};
}

test('Gmail pages with its own token, and an older page leaves the cache on the newest rows', async () => {
  const pages: Record<string, unknown> = {
    '': { threads: [{ id: 't1', historyId: '77', snippet: 'Newest' }], nextPageToken: 'page-2' },
    'page-2': { threads: [{ id: 't2', historyId: '70', snippet: 'Older' }] },
  };
  const f = fixture(call => {
    if (call.method === 'profile') return { historyId: '77' };
    if (call.method === 'threadsList') return pages[input(call).pageToken ?? ''] ?? { threads: [] };
    if (call.method === 'threadGet') return thread(input(call).id, input(call).id === 't1' ? 'Newest' : 'Older', input(call).id === 't1' ? 2 : 1);
    throw new Error(`unexpected Gmail call: ${call.method}`);
  });
  try {
    const adapter = createGmailAdapter(f.deps, 'gmail-personal');

    const first = await adapter.list();
    assert.deepEqual(first.items.map(item => item.id), ['t1'], 'the newest page is what the list shows');
    assert.equal(first.cursor, 'page-2', 'Gmail says a page exists beyond the newest rows');
    assert.deepEqual(f.cache.list().map(item => item.id), ['t1'], 'the cache still holds the newest page');

    const synced = await adapter.sync();
    assert.equal(synced.cursor, 'page-2', 'a refresh reports where the older rows begin, so the panel can offer them');

    const older = await adapter.list('page-2');
    assert.deepEqual(older.items.map(item => item.id), ['t2'], 'the token answers with the page after the newest one');
    assert.equal(older.cursor, undefined, 'the last page says nothing older exists');
    assert.equal(input(f.calls.gmail.filter(call => call.method === 'threadsList').at(-1)!).pageToken, 'page-2', 'the token travels to Gmail as pageToken');
    // A row needs headers, dates and labels, not a body: `metadata` is the read that answers it,
    // and it measured 0.7s against 1.35s for a full thread — the whole difference between a page
    // that lands in seconds and one that takes forty.
    const reads = f.calls.gmail.filter(call => call.method === 'threadGet').map(input);
    assert.deepEqual([...new Set(reads.map(read => read.format))], ['full', 'metadata'], 'the newest page keeps its full read; an older page reads metadata');
    assert.equal(reads.at(-1)!.format, 'metadata');
    assert.equal(older.items[0].attachments, undefined, 'a metadata read cannot name attachments, so an older row does not pretend it has none');
    assert.deepEqual(first.items[0].attachments, [], 'the newest row still carries the attachment list the cache and search expect');
    assert.deepEqual(f.cache.list().map(item => item.id), ['t1'], 'an older page is a read: the cache is untouched');

    // The gateway asks for a smaller older page than the twenty-row first load, because a Gmail
    // row is one thread read and twenty of them per account did not fit the panel's ceiling.
    await adapter.list('page-2', { limit: 10 });
    assert.equal(input(f.calls.gmail.filter(call => call.method === 'threadsList').at(-1)!).maxResults, 10, 'the page size the gateway names is the page size Gmail is asked for');
  } finally {
    f.close();
  }
});

test('WhatsApp pages by the row offset the transport answers, and an older page leaves the cache alone', async () => {
  const asked: Array<{ cursor?: string; limit: number }> = [];
  const row = (jid: string, name: string, text: string, at: number) => ({
    jid, name, kind: '1:1' as const, lastMsgAt: at,
    preview: { text, fromMe: false, sender: name },
    unread: 0,
  });
  const pages: Record<string, { chats: ReturnType<typeof row>[]; cursor?: string }> = {
    '': { chats: [row('a@s.whatsapp.net', 'Ada', 'Newest', 1_700_000_000_000), row('b@s.whatsapp.net', 'Grace', 'Also newest', 1_699_000_000_000)], cursor: '2' },
    '2': { chats: [row('c@s.whatsapp.net', 'Older', 'Older', 1_600_000_000_000)] },
  };
  const f = fixture(() => ({}), {
    async listChats(input) {
      asked.push(input);
      return pages[input.cursor ?? ''] ?? { chats: [] };
    },
  });
  try {
    const adapter = createWhatsAppAdapter(f.deps);

    const first = await adapter.list();
    assert.deepEqual(first.items.map(item => item.id), ['a@s.whatsapp.net', 'b@s.whatsapp.net'], 'the newest page is what the list shows');
    assert.deepEqual(asked, [{ limit: 50 }], 'the newest page is one store read');
    assert.equal(first.cursor, '2', 'the transport said another page exists, so one is offered');
    assert.deepEqual(f.cache.list().map(item => item.id), ['a@s.whatsapp.net', 'b@s.whatsapp.net'], 'the cache holds the newest page');

    const older = await adapter.list('2');
    assert.deepEqual(older.items.map(item => item.id), ['c@s.whatsapp.net']);
    assert.equal(older.cursor, undefined, 'the last page offers nothing older');
    assert.deepEqual(asked.at(-1), { cursor: '2', limit: 50 }, 'the cursor travels back as the offset the store pages by');
    assert.deepEqual(f.cache.list().map(item => item.id), ['a@s.whatsapp.net', 'b@s.whatsapp.net'], 'an older page does not rewrite the cache');
  } finally {
    f.close();
  }
});
