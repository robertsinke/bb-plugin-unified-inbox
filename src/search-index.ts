import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { migrateGmailAccountIds, type CacheChange } from './inbox-cache.ts';
import { accounts, type Account, type Conversation, type SearchRow } from './adapters/types.ts';
import { bm25RankPrepared, conversationText, prepareDocument, type PreparedDocument } from './bm25.ts';

/**
 * What the index holds for one account. `corpus` is the source of truth for membership: a source
 * whose data is already on this disk answers all of it (WhatsApp's store, Messages' chat database),
 * and one that does not answers the cache's newest page. `readThread` is the single-thread path a
 * `saveThread` refreshes, so a chat opening does not re-read a 699-chat corpus.
 */
export type SearchSource = {
  corpus(account: Account): SearchRow[] | Promise<SearchRow[]>;
  readThread(account: Account, id: string): unknown[] | null;
  onChange(listener: (change: CacheChange) => void): void;
};

type StoredDocument = { id: string; signature: string; length: number; freq: Map<string, number> };

export function createSearchStore(db: Database.Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS inbox_search (id TEXT PRIMARY KEY, signature TEXT NOT NULL, length INTEGER NOT NULL, terms TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS inbox_search_meta (id INTEGER PRIMARY KEY CHECK(id = 1), updated_at INTEGER NOT NULL);`);
  migrateGmailAccountIds(db);
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
  /** The row behind each document: a hit is answered with it, whether or not the list ever loaded it. */
  const rows = new Map<string, SearchRow>();
  const dirty = new Set<string>();
  const removed = new Set<string>();
  let ready = false;
  let warming: Promise<void> | null = null;
  let updatedAt: number | null = null;
  const key = (account: Account, id: string) => `${account}\u0000${id}`;

  const persisted = store?.load();
  if (persisted) {
    updatedAt = persisted.updatedAt;
    for (const doc of persisted.documents) {
      documents.set(doc.id, { id: doc.id, freq: doc.freq, length: doc.length });
      signatures.set(doc.id, doc.signature);
    }
  }

  function searchText(row: SearchRow) {
    const { item } = row;
    return conversationText({
      title: [item.sender, item.title].filter(Boolean).join('\n'),
      recipients: item.recipients,
      attachments: item.attachments,
      preview: item.preview,
      messages: row.messages ?? source.readThread(item.account, item.id) ?? [],
    });
  }

  function put(row: SearchRow) {
    const id = key(row.item.account, row.item.id);
    const text = searchText(row);
    const signature = createHash('sha1').update(text).digest('hex');
    rows.set(id, row);
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
    rows.delete(id);
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

  /**
   * One account's membership, as its source answers it: rows the source still lists are kept even
   * when the cache has never held them, and a row the source dropped leaves the index. A source
   * that cannot answer keeps the documents it had — a failed read must not empty a corpus.
   */
  async function replaceAccount(account: Account) {
    const corpus = await source.corpus(account);
    const keep = new Set(corpus.map(row => key(row.item.account, row.item.id)));
    for (const id of [...documents.keys()]) if (id.startsWith(`${account}\u0000`) && !keep.has(id)) drop(id);
    for (const row of corpus) put(row);
    flush();
  }

  function warm(): Promise<void> {
    if (ready) return Promise.resolve();
    warming ??= (async () => {
      try {
        for (const account of accounts) {
          try { await replaceAccount(account); } catch { /* one source's failure is not the index's */ }
        }
        ready = true;
      } finally { warming = null; }
    })();
    return warming;
  }

  /**
   * A saved thread refreshes its document from what the source considers the text. A corpus row that
   * carries its own messages keeps them: a cached thread is the newest 60 of a chat, so rebuilding a
   * store's document from it would shrink the corpus a search reaches.
   */
  function replaceThread(account: Account, id: string) {
    if (!ready) return;
    const held = rows.get(key(account, id));
    if (held) put(held);
    flush();
  }

  source.onChange(change => {
    if (change.kind === 'clear') {
      documents.clear();
      signatures.clear();
      rows.clear();
      dirty.clear();
      removed.clear();
      ready = true;
      updatedAt = Date.now();
      store?.clear(updatedAt);
    } else if (change.kind === 'items') {
      // A cache save is not a search request: the owner's typing waits for no rebuild.
      if (ready) void replaceAccount(change.account).catch(() => {});
    } else {
      replaceThread(change.account, change.id);
    }
  });

  return {
    warm,
    async search(query: string) {
      await warm();
      return bm25RankPrepared(query, [...documents.values()]);
    },
    /** The row a ranked hit names, so a caller can draw a conversation the list never loaded. */
    row(account: Account, id: string): Conversation | undefined {
      return rows.get(key(account, id))?.item;
    },
    status() {
      return { size: documents.size, updatedAt, ready };
    },
  };
}
