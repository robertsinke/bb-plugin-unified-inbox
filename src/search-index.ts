import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { CachedItem, CacheChange } from './inbox-cache.ts';
import { bm25RankPrepared, conversationText, prepareDocument, type PreparedDocument } from './bm25.ts';

export type SearchSource = {
  list(): CachedItem[];
  readThread(account: CachedItem['account'], id: string): unknown[] | null;
  onChange(listener: (change: CacheChange) => void): void;
};

type StoredDocument = { id: string; signature: string; length: number; freq: Map<string, number> };

export function createSearchStore(db: Database.Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS inbox_search (id TEXT PRIMARY KEY, signature TEXT NOT NULL, length INTEGER NOT NULL, terms TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS inbox_search_meta (id INTEGER PRIMARY KEY CHECK(id = 1), updated_at INTEGER NOT NULL);`);
  const readDocs = db.prepare('SELECT id, signature, length, terms FROM inbox_search');
  const readMeta = db.prepare('SELECT updated_at FROM inbox_search_meta WHERE id = 1');
  const insert = db.prepare('INSERT INTO inbox_search (id, signature, length, terms) VALUES (@id, @signature, @length, @terms) ON CONFLICT(id) DO UPDATE SET signature = excluded.signature, length = excluded.length, terms = excluded.terms');
  const remove = db.prepare('DELETE FROM inbox_search WHERE id = ?');
  const writeMeta = db.prepare('INSERT INTO inbox_search_meta (id, updated_at) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at');
  const clearDocs = db.prepare('DELETE FROM inbox_search');
  const write = db.transaction((changed: StoredDocument[], removed: string[], updatedAt: number) => {
    for (const doc of changed) insert.run({ id: doc.id, signature: doc.signature, length: doc.length, terms: JSON.stringify([...doc.freq]) });
    for (const id of removed) remove.run(id);
    if (changed.length || removed.length) writeMeta.run(updatedAt);
  });
  const clear = db.transaction((updatedAt: number) => { clearDocs.run(); writeMeta.run(updatedAt); });
  return {
    load() {
      const documents: StoredDocument[] = [];
      for (const row of readDocs.all() as Array<{ id: string; signature: string; length: number; terms: string }>) {
        try {
          const terms = JSON.parse(row.terms);
          if (!Array.isArray(terms)) continue;
          const freq = new Map<string, number>();
          for (const entry of terms) {
            if (Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'number' && entry[1] > 0) freq.set(entry[0], entry[1]);
          }
          documents.push({ id: row.id, signature: row.signature, length: row.length, freq });
        } catch { /* skip malformed persisted rows */ }
      }
      const meta = readMeta.get() as { updated_at: number } | undefined;
      return { documents, updatedAt: meta?.updated_at ?? null };
    },
    write,
    clear,
  };
}

export function createSearchIndex(source: SearchSource, store: ReturnType<typeof createSearchStore> | null = null) {
  const documents = new Map<string, PreparedDocument>();
  const signatures = new Map<string, string>();
  const dirty = new Set<string>();
  const removed = new Set<string>();
  let ready = false;
  let updatedAt: number | null = null;
  const key = (account: CachedItem['account'], id: string) => `${account}\u0000${id}`;

  const persisted = store?.load();
  if (persisted) {
    updatedAt = persisted.updatedAt;
    for (const doc of persisted.documents) {
      documents.set(doc.id, { id: doc.id, freq: doc.freq, length: doc.length });
      signatures.set(doc.id, doc.signature);
    }
  }

  function searchText(item: CachedItem) {
    return conversationText({
      title: [item.sender, item.title].filter(Boolean).join('\n'),
      recipients: item.recipients,
      attachments: item.attachments,
      preview: item.preview,
      messages: source.readThread(item.account, item.id) ?? [],
    });
  }

  function put(item: CachedItem) {
    const id = key(item.account, item.id);
    const text = searchText(item);
    const signature = createHash('sha1').update(text).digest('hex');
    if (signatures.get(id) === signature && documents.has(id)) return;
    documents.set(id, prepareDocument(id, text));
    signatures.set(id, signature);
    dirty.add(id);
    removed.delete(id);
  }

  function drop(id: string) {
    const present = documents.has(id) || signatures.has(id);
    documents.delete(id);
    signatures.delete(id);
    dirty.delete(id);
    if (present) removed.add(id);
  }

  function flush() {
    if (!store) { dirty.clear(); removed.clear(); return; }
    const changed = [...dirty].flatMap(id => {
      const doc = documents.get(id);
      const signature = signatures.get(id);
      return doc && signature ? [{ id, signature, length: doc.length, freq: doc.freq }] : [];
    });
    if (!changed.length && !removed.size) return;
    const now = Date.now();
    store.write(changed, [...removed], now);
    updatedAt = now;
    dirty.clear();
    removed.clear();
  }

  function warm() {
    if (ready) return;
    const items = source.list();
    const keep = new Set(items.map(item => key(item.account, item.id)));
    for (const id of [...documents.keys()]) if (!keep.has(id)) drop(id);
    for (const item of items) put(item);
    ready = true;
    flush();
  }

  function replaceAccount(account: CachedItem['account']) {
    if (!ready) return;
    const items = source.list().filter(item => item.account === account);
    const keep = new Set(items.map(item => key(item.account, item.id)));
    for (const id of [...documents.keys()]) if (id.startsWith(`${account}\u0000`) && !keep.has(id)) drop(id);
    for (const item of items) put(item);
    flush();
  }

  function replaceThread(account: CachedItem['account'], id: string) {
    if (!ready) return;
    const item = source.list().find(item => item.account === account && item.id === id);
    if (item) put(item);
    flush();
  }

  source.onChange(change => {
    if (change.kind === 'clear') {
      documents.clear();
      signatures.clear();
      dirty.clear();
      removed.clear();
      ready = true;
      updatedAt = Date.now();
      store?.clear(updatedAt);
    } else if (change.kind === 'items') {
      replaceAccount(change.account);
    } else {
      replaceThread(change.account, change.id);
    }
  });

  return {
    warm,
    search(query: string) {
      warm();
      return bm25RankPrepared(query, [...documents.values()]);
    },
    status() {
      return { size: documents.size, updatedAt, ready };
    },
  };
}
