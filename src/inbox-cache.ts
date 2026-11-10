import type Database from 'better-sqlite3';
import type { Account } from './adapters/types.ts';
import { unknownFreshness, type SourceFreshness } from './inbox-refresh.ts';

/** Rows written before `personal` / `business` became `gmail-personal` / `gmail-business`. */
const legacyGmailAccounts: Record<string, string> = { personal: 'gmail-personal', business: 'gmail-business' };

/**
 * Writes for a legacy id stop once its email-named credential file is published
 * and start again only after that legacy file is gone. A save in the window
 * must not put the old id back.
 */
const pausedWrites = new Set<string>();

export function pauseAccountWrites(account: string) {
  pausedWrites.add(account);
}

export function resumeAccountWrites(account: string) {
  pausedWrites.delete(account);
}

export function accountWritesPaused(account: string): boolean {
  return pausedWrites.has(account);
}

/**
 * Move account-keyed rows from one id to another. When the target key exists,
 * the target row stays and the source row is dropped. `inbox_send_audit` is
 * historical and is only touched for the original personal/business rename.
 * Idempotent.
 */
export function migrateGmailAccountIds(db: Database.Database, extra: Record<string, string> = {}) {
  const exists = (name: string) => !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name);
  const rename = (table: string, from: string, to: string) => db.prepare(`UPDATE ${table} SET account = ? WHERE account = ?`).run(to, from);
  const moveKeyed = (table: string, key: string, from: string, to: string) => {
    db.prepare(`DELETE FROM ${table} WHERE account = ? AND ${key} IN (SELECT ${key} FROM ${table} WHERE account = ?)`).run(from, to);
    rename(table, from, to);
  };
  const moveAccount = (table: string, from: string, to: string) => {
    db.prepare(`DELETE FROM ${table} WHERE account = ? AND EXISTS (SELECT 1 FROM ${table} WHERE account = ?)`).run(from, to);
    rename(table, from, to);
  };
  const searchColumns = exists('inbox_search')
    ? db.prepare('PRAGMA table_info(inbox_search)').all() as { name: string }[]
    : [];
  const searchHasItem = searchColumns.some(column => column.name === 'item');
  db.transaction(() => {
    const apply = (map: Record<string, string>, audit: boolean) => {
      for (const [from, to] of Object.entries(map)) {
        if (!from || !to || from === to) continue;
        for (const table of ['inbox_cache', 'inbox_revision', 'inbox_thread', 'inbox_unread_mark', 'inbox_read_hold', 'inbox_attention', 'inbox_mute', 'inbox_gmail_archive']) {
          if (exists(table)) moveKeyed(table, 'id', from, to);
        }
        if (exists('gmail_faces')) moveKeyed('gmail_faces', 'address', from, to);
        for (const table of ['inbox_sync', 'inbox_freshness']) {
          if (exists(table)) moveAccount(table, from, to);
        }
        if (audit && exists('inbox_send_audit')) rename('inbox_send_audit', from, to);
      }
      if (!exists('inbox_search')) return;
      const present = db.prepare('SELECT 1 FROM inbox_search WHERE id = ?');
      const update = searchHasItem
        ? db.prepare('UPDATE inbox_search SET id = ?, item = ? WHERE id = ?')
        : db.prepare('UPDATE inbox_search SET id = ? WHERE id = ?');
      const remove = db.prepare('DELETE FROM inbox_search WHERE id = ?');
      const rows = searchHasItem
        ? db.prepare('SELECT id, item FROM inbox_search').all() as { id: string; item: string | null }[]
        : (db.prepare('SELECT id FROM inbox_search').all() as { id: string }[]).map(row => ({ ...row, item: null }));
      for (const row of rows) {
        const split = row.id.indexOf('\u0000');
        const next = split > 0 ? map[row.id.slice(0, split)] : undefined;
        if (!next) continue;
        const id = next + row.id.slice(split);
        if (present.get(id)) { remove.run(row.id); continue; }
        let item = row.item;
        if (item) {
          try {
            const parsed = JSON.parse(item) as { account?: string };
            if (parsed && parsed.account && map[parsed.account]) item = JSON.stringify({ ...parsed, account: map[parsed.account] });
          } catch { /* the id move still stands */ }
        }
        if (searchHasItem) update.run(id, item, row.id);
        else update.run(id, row.id);
      }
    };
    apply(legacyGmailAccounts, true);
    apply(extra, false);
  })();
}

function parseAttachments(value: string | null): string[] | undefined {
  if (value === null) return undefined;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((name): name is string => typeof name === 'string') : undefined;
  } catch { return undefined; }
}

export type CachedItem = { account: Account; id:string; title:string; preview:string; date:number; unread:boolean; sender?:string; senderAddress?:string; avatarUrl?:string; recipients?:string; attachments?:string[]; sentSnippet?:string };
export type CacheChange = { kind:'items'; account:CachedItem['account'] } | { kind:'thread'; account:CachedItem['account']; id:string } | { kind:'clear' };
export function createInboxCache(db: Database.Database, options: { alsoClear?: Array<() => void> } = {}) {
  // What a cache clear covers is wider than this module's own tables: the WhatsApp transport keeps
  // its messages and envelopes in the same database (plan D5), and the privacy promise in README.md
  // covers those copies too. The store that owns that DDL registers its own clearer here rather than
  // this module learning another schema.
  const alsoClear = options.alsoClear ?? [];
  db.exec(`CREATE TABLE IF NOT EXISTS inbox_cache (account TEXT NOT NULL, id TEXT NOT NULL, title TEXT NOT NULL, preview TEXT NOT NULL, date INTEGER NOT NULL, unread INTEGER NOT NULL, PRIMARY KEY(account,id));
    CREATE TABLE IF NOT EXISTS inbox_sync (account TEXT PRIMARY KEY, history_id TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS inbox_revision (account TEXT NOT NULL, id TEXT NOT NULL, history_id TEXT NOT NULL, preview TEXT NOT NULL, PRIMARY KEY(account,id));
    CREATE TABLE IF NOT EXISTS inbox_thread (account TEXT NOT NULL, id TEXT NOT NULL, messages TEXT NOT NULL, PRIMARY KEY(account,id));
    CREATE TABLE IF NOT EXISTS inbox_freshness (account TEXT PRIMARY KEY, last_attempt INTEGER, last_success INTEGER, last_error TEXT, cache_fallback INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS inbox_unread_mark (account TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY(account,id));
    CREATE TABLE IF NOT EXISTS inbox_read_hold (account TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY(account,id));
    CREATE TABLE IF NOT EXISTS inbox_mute (account TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY(account,id));
    CREATE TABLE IF NOT EXISTS inbox_gmail_archive (account TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY(account,id));`);
  const listeners = new Set<(change: CacheChange) => void>();
  const emit = (change: CacheChange) => { for (const listener of listeners) listener(change); };
  const columns = db.prepare('PRAGMA table_info(inbox_cache)').all() as { name: string }[];
  if (!columns.some(column => column.name === 'sender')) db.exec('ALTER TABLE inbox_cache ADD COLUMN sender TEXT NOT NULL DEFAULT ""');
  if (!columns.some(column => column.name === 'recipients')) db.exec('ALTER TABLE inbox_cache ADD COLUMN recipients TEXT');
  if (!columns.some(column => column.name === 'attachments')) db.exec('ALTER TABLE inbox_cache ADD COLUMN attachments TEXT');
  if (!columns.some(column => column.name === 'avatar_url')) db.exec('ALTER TABLE inbox_cache ADD COLUMN avatar_url TEXT');
  // A face is keyed by the sender's address, and a cached row that kept only the display name could
  // never be given the picture that arrived after it was cached (`src/gmail-faces.ts`).
  if (!columns.some(column => column.name === 'sender_address')) db.exec('ALTER TABLE inbox_cache ADD COLUMN sender_address TEXT');
  if (!columns.some(column => column.name === 'sent_snippet')) db.exec('ALTER TABLE inbox_cache ADD COLUMN sent_snippet TEXT');
  const threadColumns = db.prepare('PRAGMA table_info(inbox_thread)').all() as { name: string }[];
  if (!threadColumns.some(column => column.name === 'updated_at')) db.exec('ALTER TABLE inbox_thread ADD COLUMN updated_at INTEGER');
  const holdColumns = db.prepare('PRAGMA table_info(inbox_read_hold)').all() as { name: string }[];
  if (!holdColumns.some(column => column.name === 'through_ms')) db.exec('ALTER TABLE inbox_read_hold ADD COLUMN through_ms INTEGER');
  migrateGmailAccountIds(db);
  const read = db.prepare('SELECT account, id, title, preview, date, unread, sender, sender_address, avatar_url, recipients, attachments, sent_snippet FROM inbox_cache ORDER BY date DESC, account, id');
  const clear = db.prepare('DELETE FROM inbox_cache WHERE account = ?');
  const insert = db.prepare('INSERT INTO inbox_cache (account,id,title,preview,date,unread,sender,sender_address,avatar_url,recipients,attachments,sent_snippet) VALUES (@account,@id,@title,@preview,@date,@unread,@sender,@senderAddress,@avatarUrl,@recipients,@attachments,@sentSnippet)');
  const writeSent = db.prepare('UPDATE inbox_cache SET sent_snippet = ?, preview = ?, date = ? WHERE account = ? AND id = ?');
  const save = db.transaction((account: CachedItem['account'], items: CachedItem[]) => {
    if (items.some(item => item.account !== account)) throw new Error('Cache account mismatch');
    clear.run(account);
    for (const item of items) insert.run({ ...item, unread: item.unread ? 1 : 0, sender: item.sender ?? '', senderAddress: item.senderAddress ?? null, avatarUrl: item.avatarUrl ?? null, recipients: item.recipients ?? null, attachments: item.attachments ? JSON.stringify(item.attachments) : null, sentSnippet: item.sentSnippet ?? null });
  });
  return {
    list(): CachedItem[] { return (read.all() as Array<Omit<CachedItem,'unread'|'sender'|'senderAddress'|'avatarUrl'|'recipients'|'attachments'|'sentSnippet'> & {unread:number; sender:string; sender_address:string|null; avatar_url:string|null; recipients:string|null; attachments:string|null; sent_snippet:string|null}>).map(({sender,sender_address,avatar_url,recipients,attachments,sent_snippet,...item})=>{const names=parseAttachments(attachments);return {...item,unread:!!item.unread,...(sender?{sender}:{}),...(sender_address!==null?{senderAddress:sender_address}:{}),...(avatar_url?{avatarUrl:avatar_url}:{}),...(recipients!==null?{recipients}:{}),...(names?{attachments:names}:{}),...(sent_snippet?{sentSnippet:sent_snippet}:{})};}); },
    save(account: CachedItem['account'], items: CachedItem[]) { if (pausedWrites.has(account)) return; save(account, items); emit({kind:'items', account}); },
    setSentSnippet(account: CachedItem['account'], id: string, text: string, date = Date.now()) {
      const snippet = text.replace(/\s+/g, ' ').trim().slice(0, 2_000);
      if (!snippet || writeSent.run(snippet, snippet, date, account, id).changes === 0) return;
      emit({ kind: 'items', account });
    },
    onChange(fn: (change: CacheChange) => void) { listeners.add(fn); },
    freshness(account: CachedItem['account']): SourceFreshness {
      const row = db.prepare('SELECT last_attempt AS lastAttemptAt, last_success AS lastSuccessAt, last_error AS lastError, cache_fallback AS cacheFallback FROM inbox_freshness WHERE account = ?').get(account) as (Omit<SourceFreshness, 'cacheFallback'> & { cacheFallback: number }) | undefined;
      return row ? { ...row, cacheFallback: !!row.cacheFallback } : unknownFreshness();
    },
    saveFreshness(account: CachedItem['account'], state: SourceFreshness) {
      if (pausedWrites.has(account)) return;
      db.prepare('INSERT INTO inbox_freshness VALUES (?, ?, ?, ?, ?) ON CONFLICT(account) DO UPDATE SET last_attempt = excluded.last_attempt, last_success = excluded.last_success, last_error = excluded.last_error, cache_fallback = excluded.cache_fallback').run(account, state.lastAttemptAt, state.lastSuccessAt, state.lastError, state.cacheFallback ? 1 : 0);
    },
    threadUpdatedAt(account: CachedItem['account'], id: string): number | null {
      const row = db.prepare('SELECT updated_at FROM inbox_thread WHERE account = ? AND id = ?').get(account, id) as { updated_at: number | null } | undefined;
      return row?.updated_at ?? null;
    },
    clear() { db.prepare('DELETE FROM inbox_cache').run(); db.prepare('DELETE FROM inbox_sync').run(); db.prepare('DELETE FROM inbox_freshness').run(); db.prepare('DELETE FROM inbox_revision').run(); db.prepare('DELETE FROM inbox_thread').run(); db.prepare('DELETE FROM inbox_unread_mark').run(); db.prepare('DELETE FROM inbox_read_hold').run(); for (const clear of alsoClear) clear(); emit({kind:'clear'}); },
    /**
     * Drop one account's cached rows. Does not call the all-source clear, so WhatsApp
     * and LinkedIn files stay. Panel drafts live in localStorage; this cannot see them.
     * shortcut: local drafts are dropped when the settings page handles remove, until then a removed mailbox can still have a draft in the panel.
     */
    forget(account: string) {
      const tables = ['inbox_cache', 'inbox_sync', 'inbox_freshness', 'inbox_revision', 'inbox_thread', 'inbox_unread_mark', 'inbox_read_hold', 'inbox_attention', 'inbox_mute', 'inbox_gmail_archive', 'gmail_faces'];
      const exists = (name: string) => !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name);
      db.transaction(() => {
        for (const table of tables) {
          if (exists(table)) db.prepare(`DELETE FROM ${table} WHERE account = ?`).run(account);
        }
        if (!exists('inbox_search')) return;
        const rows = db.prepare('SELECT id FROM inbox_search').all() as { id: string }[];
        const drop = db.prepare('DELETE FROM inbox_search WHERE id = ?');
        const prefix = `${account}\u0000`;
        for (const row of rows) {
          if (row.id === account || row.id.startsWith(prefix)) drop.run(row.id);
        }
      })();
      emit({ kind: 'items', account });
    },
    keepUnread(account: CachedItem['account'], id: string) {
      db.prepare('INSERT INTO inbox_unread_mark (account, id) VALUES (?, ?) ON CONFLICT(account, id) DO NOTHING').run(account, id);
      db.prepare('UPDATE inbox_cache SET unread = 1 WHERE account = ? AND id = ?').run(account, id);
    },
    dropUnread(account: CachedItem['account'], id: string) {
      db.prepare('DELETE FROM inbox_unread_mark WHERE account = ? AND id = ?').run(account, id);
      db.prepare('UPDATE inbox_cache SET unread = 0 WHERE account = ? AND id = ?').run(account, id);
    },
    keptUnread(account: CachedItem['account'], id: string) {
      return !!db.prepare('SELECT 1 FROM inbox_unread_mark WHERE account = ? AND id = ?').get(account, id);
    },
    /**
     * The owner already read this row. Gmail may still carry UNREAD until the minute budget
     * allows the label change. Messages keeps its own unread count; `throughMs` is the chat
     * date this inbox has read through, and a later message is newer than that. A later sync
     * must not paint the row unread again while it is still held.
     */
    holdRead(account: CachedItem['account'], id: string, throughMs?: number) {
      db.prepare('INSERT INTO inbox_read_hold (account, id, through_ms) VALUES (?, ?, ?) ON CONFLICT(account, id) DO UPDATE SET through_ms = COALESCE(excluded.through_ms, inbox_read_hold.through_ms)').run(account, id, throughMs ?? null);
      db.prepare('UPDATE inbox_cache SET unread = 0 WHERE account = ? AND id = ?').run(account, id);
    },
    releaseRead(account: CachedItem['account'], id: string) {
      db.prepare('DELETE FROM inbox_read_hold WHERE account = ? AND id = ?').run(account, id);
    },
    heldRead(account: CachedItem['account'], id: string) {
      return !!db.prepare('SELECT 1 FROM inbox_read_hold WHERE account = ? AND id = ?').get(account, id);
    },
    heldReads(account: CachedItem['account']) {
      return (db.prepare('SELECT id FROM inbox_read_hold WHERE account = ?').all(account) as { id: string }[]).map(row => row.id);
    },
    readHolds(account: CachedItem['account']) {
      return (db.prepare('SELECT id, through_ms AS throughMs FROM inbox_read_hold WHERE account = ?').all(account) as { id: string; throughMs: number | null }[]);
    },
    // The owner's choice. `save` rewrites the list and `clear` drops derived marks. This row stays until unmute or `forget`.
    mute(account: CachedItem['account'], id: string) {
      db.prepare('INSERT INTO inbox_mute (account, id) VALUES (?, ?) ON CONFLICT(account, id) DO NOTHING').run(account, id);
    },
    unmute(account: CachedItem['account'], id: string) {
      db.prepare('DELETE FROM inbox_mute WHERE account = ? AND id = ?').run(account, id);
    },
    muted(account: CachedItem['account'], id: string) {
      return !!db.prepare('SELECT 1 FROM inbox_mute WHERE account = ? AND id = ?').get(account, id);
    },
    /** A conversation archived in this inbox. A later message on it stays hidden. */
    keepArchived(account: CachedItem['account'], id: string) {
      db.prepare('INSERT INTO inbox_gmail_archive (account, id) VALUES (?, ?) ON CONFLICT(account, id) DO NOTHING').run(account, id);
    },
    archived(account: CachedItem['account']) {
      return (db.prepare('SELECT id FROM inbox_gmail_archive WHERE account = ?').all(account) as { id: string }[]).map(row => row.id);
    },
    cursor(account: CachedItem['account']) {
      const row = db.prepare('SELECT history_id FROM inbox_sync WHERE account = ?').get(account) as { history_id: string } | undefined;
      return row?.history_id ?? null;
    },
    setCursor(account: CachedItem['account'], historyId: string) {
      if (pausedWrites.has(account)) return;
      db.prepare('INSERT INTO inbox_sync (account, history_id) VALUES (?, ?) ON CONFLICT(account) DO UPDATE SET history_id = excluded.history_id').run(account, historyId);
    },
    revisions(account: CachedItem['account']) {
      return db.prepare('SELECT id, history_id AS historyId, preview FROM inbox_revision WHERE account = ?').all(account) as { id: string; historyId: string; preview: string }[];
    },
    saveRevisions(account: CachedItem['account'], rows: { id: string; historyId: string; preview: string }[]) {
      if (pausedWrites.has(account)) return;
      const clearRows = db.prepare('DELETE FROM inbox_revision WHERE account = ?');
      const insertRow = db.prepare('INSERT INTO inbox_revision (account, id, history_id, preview) VALUES (?, ?, ?, ?)');
      db.transaction(() => {
        clearRows.run(account);
        for (const row of rows) insertRow.run(account, row.id, row.historyId, row.preview);
      })();
    },
    readThread(account: CachedItem['account'], id: string): unknown[] | null {
      const row = db.prepare('SELECT messages FROM inbox_thread WHERE account = ? AND id = ?').get(account, id) as { messages: string } | undefined;
      if (!row) return null;
      try {
        const parsed = JSON.parse(row.messages);
        return Array.isArray(parsed) ? parsed : null;
      } catch { return null; }
    },
    saveThread(account: CachedItem['account'], id: string, messages: unknown[], updatedAt: number | null = Date.now()) {
      if (pausedWrites.has(account)) return;
      db.prepare('INSERT INTO inbox_thread (account, id, messages, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(account, id) DO UPDATE SET messages = excluded.messages, updated_at = excluded.updated_at').run(account, id, JSON.stringify(messages), updatedAt);
      emit({kind:'thread', account, id});
    },
  };
}
