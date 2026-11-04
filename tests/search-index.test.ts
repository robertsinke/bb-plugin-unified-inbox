import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import Database from 'better-sqlite3';
import { createSearchIndex, createSearchStore } from '../src/search-index.ts';
import type { CachedItem, CacheChange } from '../src/inbox-cache.ts';

type Store = ReturnType<typeof createSearchStore>;

function fixture(store: Store | null = null) {
  let items: CachedItem[] = [
    { account: 'whatsapp', id: 'a', title: 'Chat one', preview: 'first', date: 2, unread: false },
    { account: 'whatsapp', id: 'b', title: 'Chat two', preview: 'second', date: 1, unread: false },
    { account: 'gmail-personal', id: 'c', title: 'Chat three', preview: 'third', date: 3, unread: false },
  ];
  const threads = new Map<string, unknown[]>([
    ['whatsapp\u0000a', [{ sender: 'Ada', text: 'alpha body' }]],
    ['whatsapp\u0000b', [{ sender: 'Bob', text: 'beta body' }]],
  ]);
  let listener: ((change: CacheChange) => void) | undefined;
  const source = {
    list: () => items,
    readThread: (account: CachedItem['account'], id: string) => threads.get(`${account}\u0000${id}`) ?? null,
    onChange: (fn: (change: CacheChange) => void) => { listener = fn; },
  };
  const index = createSearchIndex(source, store);
  return {
    index,
    ids: (query: string) => index.search(query).map(row => row.id),
    refresh() {
      listener?.({ kind: 'items', account: 'whatsapp' });
    },
    setItems(next: CachedItem[]) {
      items = next;
      listener?.({ kind: 'items', account: 'whatsapp' });
    },
    changePreview() {
      items = items.map(item => item.id === 'b' ? { ...item, preview: 'changed' } : item);
      listener?.({ kind: 'items', account: 'whatsapp' });
    },
    setThread(account: CachedItem['account'], id: string, messages: unknown[]) {
      threads.set(`${account}\u0000${id}`, messages);
      listener?.({ kind: 'thread', account, id });
    },
    clear() {
      items = [];
      threads.clear();
      listener?.({ kind: 'clear' });
    },
  };
}

test('search builds lazily and then replaces one thread in place', () => {
  const f = fixture();
  assert.deepEqual(f.ids('alph'), ['whatsapp\u0000a']);
  f.setThread('whatsapp', 'a', [{ sender: 'Ada', text: 'gamma body' }]);
  assert.deepEqual(f.ids('alpha'), []);
  assert.deepEqual(f.ids('gamma'), ['whatsapp\u0000a']);
  assert.deepEqual(f.ids('beta'), ['whatsapp\u0000b']);
});

test('an account refresh updates and removes only that account documents', () => {
  const f = fixture();
  assert.deepEqual(f.ids('third'), ['gmail-personal\u0000c']);
  f.setItems([
    { account: 'whatsapp', id: 'b', title: 'Chat two', preview: 'changed', date: 4, unread: false },
  ]);
  assert.deepEqual(f.ids('third'), ['gmail-personal\u0000c']);
  assert.deepEqual(f.ids('alpha'), []);
  assert.deepEqual(f.ids('changed'), ['whatsapp\u0000b']);
});

test('clearing the cache clears the index', () => {
  const f = fixture();
  assert.deepEqual(f.ids('beta'), ['whatsapp\u0000b']);
  f.clear();
  assert.deepEqual(f.ids('beta'), []);
});

test('the prepared index survives a restart', () => {
  const db = new Database(':memory:');
  try {
    const store = createSearchStore(db);
    const first = fixture(store);
    assert.deepEqual(first.ids('alpha'), ['whatsapp\u0000a']);
    const saved = first.index.status();
    assert.equal(saved.size, 3);
    assert.equal(saved.ready, true);
    assert.ok(saved.updatedAt);

    const second = fixture(store);
    const loaded = second.index.status();
    assert.equal(loaded.size, 3);
    assert.equal(loaded.ready, false);
    assert.equal(loaded.updatedAt, saved.updatedAt);
    assert.deepEqual(second.ids('alpha'), ['whatsapp\u0000a']);
    assert.equal(second.index.status().ready, true);
  } finally {
    db.close();
  }
});

test('a changed thread is rebuilt after restart while other documents are reused', () => {
  const db = new Database(':memory:');
  try {
    const store = createSearchStore(db);
    const first = fixture(store);
    assert.deepEqual(first.ids('alpha'), ['whatsapp\u0000a']);

    const second = fixture(store);
    second.setThread('whatsapp', 'a', [{ sender: 'Ada', text: 'gamma body' }]);
    assert.deepEqual(second.ids('gamma'), ['whatsapp\u0000a']);
    assert.deepEqual(second.ids('alpha'), []);
    assert.deepEqual(second.ids('beta'), ['whatsapp\u0000b']);
  } finally {
    db.close();
  }
});

test('unchanged searchable fields do not rewrite the index', async () => {
  const db = new Database(':memory:');
  try {
    const store = createSearchStore(db);
    const f = fixture(store);
    assert.deepEqual(f.ids('alpha'), ['whatsapp\u0000a']);
    const before = f.index.status().updatedAt;
    assert.ok(before);
    await new Promise(resolve => setTimeout(resolve, 5));
    f.refresh();
    f.setThread('whatsapp', 'a', [{ sender: 'Ada', text: 'alpha body' }]);
    assert.equal(f.index.status().updatedAt, before);
    await new Promise(resolve => setTimeout(resolve, 5));
    f.changePreview();
    assert.ok((f.index.status().updatedAt ?? 0) > before);
    assert.deepEqual(f.ids('changed'), ['whatsapp\u0000b']);
  } finally {
    db.close();
  }
});
