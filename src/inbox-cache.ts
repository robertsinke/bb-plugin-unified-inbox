import type Database from 'better-sqlite3';

function parseAttachments(value: string | null): string[] | undefined {
  if (value === null) return undefined;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((name): name is string => typeof name === 'string') : undefined;
  } catch { return undefined; }
}

export type CachedItem = { account:'personal'|'business'|'whatsapp'|'imessage'|'linkedin'; id:string; title:string; preview:string; date:number; unread:boolean; sender?:string; recipients?:string; attachments?:string[] };
export type CacheChange = { kind:'items'; account:CachedItem['account'] } | { kind:'thread'; account:CachedItem['account']; id:string } | { kind:'clear' };
export function createInboxCache(db: Database.Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS inbox_cache (account TEXT NOT NULL, id TEXT NOT NULL, title TEXT NOT NULL, preview TEXT NOT NULL, date INTEGER NOT NULL, unread INTEGER NOT NULL, PRIMARY KEY(account,id));
    CREATE TABLE IF NOT EXISTS inbox_sync (account TEXT PRIMARY KEY, history_id TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS inbox_revision (account TEXT NOT NULL, id TEXT NOT NULL, history_id TEXT NOT NULL, preview TEXT NOT NULL, PRIMARY KEY(account,id));
    CREATE TABLE IF NOT EXISTS inbox_thread (account TEXT NOT NULL, id TEXT NOT NULL, messages TEXT NOT NULL, PRIMARY KEY(account,id));
    CREATE TABLE IF NOT EXISTS inbox_unread_mark (account TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY(account,id));`);
  let listener: ((change: CacheChange) => void) | null = null;
  const columns = db.prepare('PRAGMA table_info(inbox_cache)').all() as { name: string }[];
  if (!columns.some(column => column.name === 'sender')) db.exec('ALTER TABLE inbox_cache ADD COLUMN sender TEXT NOT NULL DEFAULT ""');
  if (!columns.some(column => column.name === 'recipients')) db.exec('ALTER TABLE inbox_cache ADD COLUMN recipients TEXT');
  if (!columns.some(column => column.name === 'attachments')) db.exec('ALTER TABLE inbox_cache ADD COLUMN attachments TEXT');
  const read = db.prepare('SELECT account, id, title, preview, date, unread, sender, recipients, attachments FROM inbox_cache ORDER BY date DESC, account, id');
  const clear = db.prepare('DELETE FROM inbox_cache WHERE account = ?');
  const insert = db.prepare('INSERT INTO inbox_cache (account,id,title,preview,date,unread,sender,recipients,attachments) VALUES (@account,@id,@title,@preview,@date,@unread,@sender,@recipients,@attachments)');
  const save = db.transaction((account: CachedItem['account'], items: CachedItem[]) => {
    if (items.some(item => item.account !== account)) throw new Error('Cache account mismatch');
    clear.run(account);
    for (const item of items) insert.run({ ...item, unread: item.unread ? 1 : 0, sender: item.sender ?? '', recipients: item.recipients ?? null, attachments: item.attachments ? JSON.stringify(item.attachments) : null });
  });
  return {
    list(): CachedItem[] { return (read.all() as Array<Omit<CachedItem,'unread'|'sender'|'recipients'|'attachments'> & {unread:number; sender:string; recipients:string|null; attachments:string|null}>).map(({sender,recipients,attachments,...item})=>{const names=parseAttachments(attachments);return {...item,unread:!!item.unread,...(sender?{sender}:{}),...(recipients!==null?{recipients}:{}),...(names?{attachments:names}:{})};}); },
    save(account: CachedItem['account'], items: CachedItem[]) { save(account, items); listener?.({kind:'items', account}); },
    onChange(fn: (change: CacheChange) => void) { listener = fn; },
    clear() { db.prepare('DELETE FROM inbox_cache').run(); db.prepare('DELETE FROM inbox_sync').run(); db.prepare('DELETE FROM inbox_revision').run(); db.prepare('DELETE FROM inbox_thread').run(); db.prepare('DELETE FROM inbox_unread_mark').run(); listener?.({kind:'clear'}); },
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
    cursor(account: CachedItem['account']) {
      const row = db.prepare('SELECT history_id FROM inbox_sync WHERE account = ?').get(account) as { history_id: string } | undefined;
      return row?.history_id ?? null;
    },
    setCursor(account: CachedItem['account'], historyId: string) {
      db.prepare('INSERT INTO inbox_sync (account, history_id) VALUES (?, ?) ON CONFLICT(account) DO UPDATE SET history_id = excluded.history_id').run(account, historyId);
    },
    revisions(account: CachedItem['account']) {
      return db.prepare('SELECT id, history_id AS historyId, preview FROM inbox_revision WHERE account = ?').all(account) as { id: string; historyId: string; preview: string }[];
    },
    saveRevisions(account: CachedItem['account'], rows: { id: string; historyId: string; preview: string }[]) {
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
    saveThread(account: CachedItem['account'], id: string, messages: unknown[]) {
      db.prepare('INSERT INTO inbox_thread (account, id, messages) VALUES (?, ?, ?) ON CONFLICT(account, id) DO UPDATE SET messages = excluded.messages').run(account, id, JSON.stringify(messages));
      listener?.({kind:'thread', account, id});
    },
  };
}
