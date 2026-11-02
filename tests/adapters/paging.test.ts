// Paging, proved at the transport seam. Gmail hands back its own `pageToken` for the page after
// the newest rows; WhatsAgent pages chats with a row `offset` and says `has_more`. Both answers
// are reads only: the cache keeps holding the newest page, because every refresh replaces it
// wholesale and a second page written into it would vanish on the next one.
import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { createInboxCache } from '../../src/inbox-cache.ts';
import { createGmailAdapter } from '../../src/adapters/gmail.ts';
import { createWhatsAppAdapter } from '../../src/adapters/whatsapp.ts';
import { toProviderError } from '../../src/adapters/provider-error.ts';
import type { RegistryDeps } from '../../src/adapters/deps.ts';

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

type GmailCall = string[];
type WhatsCall = { tool: string; args: Record<string, unknown> };

function fixture(gmail: (args: string[]) => unknown, whatsapp?: (call: WhatsCall) => unknown) {
  const db = new Database(':memory:');
  const cache = createInboxCache(db);
  const calls: { gmail: GmailCall[]; whatsapp: WhatsCall[] } = { gmail: [], whatsapp: [] };
  const deps = {
    cache,
    gmail: {
      call: async (_account: string, args: string[]) => { calls.gmail.push(args); return gmail(args); },
      send: async () => ({ id: 'sent' }),
    },
    whatsapp: {
      call: async (tool: string, args: Record<string, unknown>) => {
        const call = { tool, args };
        calls.whatsapp.push(call);
        return whatsapp ? whatsapp(call) : {};
      },
      runtime: async () => ({ baseUrl: 'http://whatsapp.test', token: 'test-token', port: 1 }),
    },
    imsg: { request: async () => ({}) },
    linkedInPage: {},
    armLinkedInRecorder: async () => ({}),
    providerError: toProviderError,
  } as unknown as RegistryDeps;
  return { cache, calls, deps, close: () => db.close() };
}

/** The `--params` payload of a `gws` call, which is where Gmail reads its arguments. */
function params(args: string[]): any {
  const at = args.indexOf('--params');
  return at === -1 ? {} : JSON.parse(args[at + 1]);
}

test('Gmail pages with its own token, and an older page leaves the cache on the newest rows', async () => {
  const pages: Record<string, unknown> = {
    '': { threads: [{ id: 't1', historyId: '77', snippet: 'Newest' }], nextPageToken: 'page-2' },
    'page-2': { threads: [{ id: 't2', historyId: '70', snippet: 'Older' }] },
  };
  const f = fixture(args => {
    if (args[1] === 'getProfile') return { historyId: '77' };
    if (args[1] === 'threads' && args[2] === 'list') return pages[params(args).pageToken ?? ''] ?? { threads: [] };
    if (args[1] === 'threads' && args[2] === 'get') return thread(params(args).id, params(args).id === 't1' ? 'Newest' : 'Older', params(args).id === 't1' ? 2 : 1);
    throw new Error(`unexpected gws call: ${args.join(' ')}`);
  });
  try {
    const adapter = createGmailAdapter(f.deps, 'personal');

    const first = await adapter.list();
    assert.deepEqual(first.items.map(item => item.id), ['t1'], 'the newest page is what the list shows');
    assert.equal(first.cursor, 'page-2', 'Gmail says a page exists beyond the newest rows');
    assert.deepEqual(f.cache.list().map(item => item.id), ['t1'], 'the cache still holds the newest page');

    const synced = await adapter.sync();
    assert.equal(synced.cursor, 'page-2', 'a refresh reports where the older rows begin, so the panel can offer them');

    const older = await adapter.list('page-2');
    assert.deepEqual(older.items.map(item => item.id), ['t2'], 'the token answers with the page after the newest one');
    assert.equal(older.cursor, undefined, 'the last page says nothing older exists');
    assert.equal(params(f.calls.gmail.filter(args => args[2] === 'list').at(-1)!).pageToken, 'page-2', 'the token travels to Gmail as pageToken');
    assert.deepEqual(f.cache.list().map(item => item.id), ['t1'], 'an older page is a read: the cache is untouched');
  } finally {
    f.close();
  }
});

test('WhatsApp pages by row offset, advances past the rows it was given, and stops where WhatsAgent says', async () => {
  const page = (offset: number) => offset === 0
    ? {
      items: [
        { jid: 'a@s.whatsapp.net', name: 'Ada', preview: 'Newest', last_msg_at: 1_700_000_000_000, unread: 0, kind: 'dm' },
        { jid: 'archived@s.whatsapp.net', name: 'Archived', preview: '', last_msg_at: 1_699_000_000_000, unread: 0, kind: 'dm', archived: true },
      ],
      total: 3,
      offset,
      limit: 50,
      has_more: true,
    }
    : {
      items: [{ jid: 'b@s.whatsapp.net', name: 'Grace', preview: 'Older', last_msg_at: 1_600_000_000_000, unread: 0, kind: 'dm' }],
      total: 3,
      offset,
      limit: 50,
      has_more: false,
    };
  const f = fixture(() => ({}), call => page(Number(call.args.offset ?? 0)));
  try {
    const adapter = createWhatsAppAdapter(f.deps);

    const first = await adapter.list();
    assert.deepEqual(first.items.map(item => item.id), ['a@s.whatsapp.net'], 'an archived chat is filtered out of the page');
    assert.deepEqual(f.calls.whatsapp[0].args, { filter: 'all', limit: 50, offset: 0 }, 'the newest page is the read it always was');
    assert.equal(first.cursor, '2', 'the offset advances by the rows WhatsAgent returned, not the rows kept');

    const older = await adapter.list('2');
    assert.deepEqual(older.items.map(item => item.id), ['b@s.whatsapp.net']);
    assert.equal(older.cursor, undefined, 'has_more is false, so nothing older is offered');
    assert.deepEqual(f.calls.whatsapp.at(-1)!.args, { filter: 'all', limit: 50, offset: 2 });
    assert.deepEqual(f.cache.list().map(item => item.id), ['a@s.whatsapp.net'], 'an older page does not rewrite the cache');
  } finally {
    f.close();
  }
});
