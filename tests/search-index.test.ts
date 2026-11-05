import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import Database from 'better-sqlite3';
import { createSearchIndex, createSearchStore } from '../src/search-index.ts';
import type { CacheChange } from '../src/inbox-cache.ts';
import type { Account, Conversation, SearchRow } from '../src/adapters/types.ts';

type Store = ReturnType<typeof createSearchStore>;

/**
 * Two corpora, as a source really answers them: one account whose source keeps its own store (so a
 * row exists that the cache has never held) and one that answers from the cache's newest page.
 */
function fixture(store: Store | null = null) {
  let cacheRows: Conversation[] = [
    { account: 'whatsapp', id: 'a', title: 'Chat one', preview: 'first', date: 2, unread: false },
    { account: 'gmail-personal', id: 'c', title: 'Chat three', preview: 'third', date: 3, unread: false },
  ];
  /** The WhatsApp store: `a`, and `d`, a chat older than any page the cache holds. */
  let storeRows: SearchRow[] = [
    { item: { account: 'whatsapp', id: 'a', title: 'Chat one', preview: 'first', date: 2, unread: false }, messages: [{ sender: 'Ada', text: 'alpha body', date: 1 }] },
    { item: { account: 'whatsapp', id: 'd', title: 'Chat four', preview: 'delta', date: 0, unread: false }, messages: [{ sender: 'Dan', text: 'delta body', date: 1 }] },
  ];
  const threads = new Map<string, unknown[]>([
    ['gmail-personal\u0000c', [{ sender: 'Bob', text: 'beta body' }]],
  ]);
  let listener: ((change: CacheChange) => void) | undefined;
  const source = {
    corpus: (account: Account): SearchRow[] => account === 'whatsapp'
      ? storeRows
      : cacheRows.filter(row => row.account === account).map(item => ({ item })),
    readThread: (account: Account, id: string) => threads.get(`${account}\u0000${id}`) ?? null,
    onChange: (fn: (change: CacheChange) => void) => { listener = fn; },
  };
  const index = createSearchIndex(source, store);
  /** A cache save rebuilds in the background: a test waits for that rebuild to land. */
  const settle = () => new Promise(resolve => setImmediate(resolve));
  return {
    settle,
    index,
    async ids(query: string) {
      return (await index.search(query)).map(row => row.id);
    },
    row: (account: Account, id: string) => index.row(account, id),
    refresh() {
      listener?.({ kind: 'items', account: 'whatsapp' });
    },
    setCacheRows(next: Conversation[]) {
      cacheRows = next;
      listener?.({ kind: 'items', account: 'whatsapp' });
    },
    setStoreRows(next: SearchRow[]) {
      storeRows = next;
      listener?.({ kind: 'items', account: 'whatsapp' });
    },
    setThread(account: Account, id: string, messages: unknown[]) {
      threads.set(`${account}\u0000${id}`, messages);
      listener?.({ kind: 'thread', account, id });
    },
    clear() {
      cacheRows = [];
      storeRows = [];
      threads.clear();
      listener?.({ kind: 'clear' });
    },
  };
}

test('search builds lazily and then replaces one thread in place', async () => {
  const f = fixture();
  assert.deepEqual(await f.ids('beta'), ['gmail-personal\u0000c']);
  f.setThread('gmail-personal', 'c', [{ sender: 'Bob', text: 'gamma body' }]);
  assert.deepEqual(await f.ids('beta'), []);
  assert.deepEqual(await f.ids('gamma'), ['gmail-personal\u0000c']);
  assert.deepEqual(await f.ids('delta'), ['whatsapp\u0000d']);
});

test('a store corpus keeps its own text when the panel caches a thread of that chat', async () => {
  const f = fixture();
  assert.deepEqual(await f.ids('alpha'), ['whatsapp\u0000a']);
  // Opening the chat caches its newest 60 messages, which is fewer than the store holds.
  f.setThread('whatsapp', 'a', [{ sender: 'Ada', text: 'gamma body' }]);
  assert.deepEqual(await f.ids('alpha'), ['whatsapp\u0000a'], 'a cached page of a chat must not shrink what search reaches');
  assert.deepEqual(await f.ids('gamma'), []);
});

test('a conversation its source still answers for survives a cache save that never held it', async () => {
  const f = fixture();
  assert.deepEqual(await f.ids('delta'), ['whatsapp\u0000d'], 'the store corpus is the index, not the cache listing');
  // The cache saves its newest page — the newest two chats — and `d` is on neither.
  f.setCacheRows([
    { account: 'whatsapp', id: 'e', title: 'Chat five', preview: 'epsilon', date: 9, unread: false },
    { account: 'gmail-personal', id: 'c', title: 'Chat three', preview: 'third', date: 3, unread: false },
  ]);
  await f.settle();
  assert.deepEqual(await f.ids('delta'), ['whatsapp\u0000d'], 'a save does not erase a document the source still answers for');
  assert.equal(f.index.status().size, 3, 'and the size counts it');

  // A conversation the source dropped leaves the index, whatever the cache holds.
  f.setStoreRows([{ item: { account: 'whatsapp', id: 'e', title: 'Chat five', preview: 'epsilon', date: 9, unread: false } }]);
  await f.settle();
  assert.deepEqual(await f.ids('delta'), [], 'a conversation the corpus dropped is removed');
  assert.deepEqual(await f.ids('epsilon'), ['whatsapp\u0000e']);
});

test('a hit answers with its own row, even one the cache never held', async () => {
  const f = fixture();
  assert.deepEqual(await f.ids('delta'), ['whatsapp\u0000d']);
  assert.equal(f.row('whatsapp', 'd')?.title, 'Chat four');
  assert.equal(f.row('whatsapp', 'dd'), undefined);
});

test('an account refresh updates and removes only that account documents', async () => {
  const f = fixture();
  assert.deepEqual(await f.ids('third'), ['gmail-personal\u0000c']);
  f.setStoreRows([
    { item: { account: 'whatsapp', id: 'b', title: 'Chat two', preview: 'changed', date: 4, unread: false } },
  ]);
  await f.settle();
  assert.deepEqual(await f.ids('third'), ['gmail-personal\u0000c']);
  assert.deepEqual(await f.ids('alpha'), []);
  assert.deepEqual(await f.ids('changed'), ['whatsapp\u0000b']);
});

test('clearing the cache clears the index', async () => {
  const f = fixture();
  assert.deepEqual(await f.ids('delta'), ['whatsapp\u0000d']);
  f.clear();
  assert.deepEqual(await f.ids('delta'), []);
});

test('the prepared index survives a restart, and warms again from the corpus', async () => {
  const db = new Database(':memory:');
  try {
    const store = createSearchStore(db);
    const first = fixture(store);
    assert.deepEqual(await first.ids('alpha'), ['whatsapp\u0000a']);
    const saved = first.index.status();
    assert.equal(saved.size, 3);
    assert.equal(saved.ready, true);
    assert.ok(saved.updatedAt);

    const second = fixture(store);
    const loaded = second.index.status();
    assert.equal(loaded.size, 3);
    assert.equal(loaded.ready, false);
    assert.equal(loaded.updatedAt, saved.updatedAt);
    assert.deepEqual(await second.ids('alpha'), ['whatsapp\u0000a']);
    assert.equal(second.index.status().ready, true);
    assert.equal(second.row('whatsapp', 'd')?.title, 'Chat four', 'a warmed index knows the row behind every document');
  } finally {
    db.close();
  }
});

test('a changed thread is rebuilt after restart while other documents are reused', async () => {
  const db = new Database(':memory:');
  try {
    const store = createSearchStore(db);
    const first = fixture(store);
    assert.deepEqual(await first.ids('beta'), ['gmail-personal\u0000c']);

    const second = fixture(store);
    // A cache-backed source's document is its row plus its cached thread, so a saved thread is the text.
    second.setThread('gmail-personal', 'c', [{ sender: 'Bob', text: 'gamma body' }]);
    assert.deepEqual(await second.ids('gamma'), ['gmail-personal\u0000c']);
    assert.deepEqual(await second.ids('beta'), []);
    assert.deepEqual(await second.ids('alpha'), ['whatsapp\u0000a'], 'and a store corpus keeps its own text');
  } finally {
    db.close();
  }
});

test('unchanged searchable fields do not rewrite the index', async () => {
  const db = new Database(':memory:');
  try {
    const store = createSearchStore(db);
    const f = fixture(store);
    assert.deepEqual(await f.ids('alpha'), ['whatsapp\u0000a']);
    const before = f.index.status().updatedAt;
    assert.ok(before);
    await new Promise(resolve => setTimeout(resolve, 5));
    f.refresh();
    f.setThread('whatsapp', 'a', [{ sender: 'Ada', text: 'alpha body' }]);
    assert.equal(f.index.status().updatedAt, before);
    await new Promise(resolve => setTimeout(resolve, 5));
    f.setStoreRows([
      { item: { account: 'whatsapp', id: 'a', title: 'Chat one', preview: 'first', date: 2, unread: false }, messages: [{ sender: 'Ada', text: 'alpha body', date: 1 }] },
      { item: { account: 'whatsapp', id: 'd', title: 'Chat four', preview: 'changed', date: 0, unread: false }, messages: [{ sender: 'Dan', text: 'delta body', date: 1 }] },
    ]);
    await f.settle();
    assert.ok((f.index.status().updatedAt ?? 0) > before);
    assert.deepEqual(await f.ids('changed'), ['whatsapp\u0000d']);
  } finally {
    db.close();
  }
});
