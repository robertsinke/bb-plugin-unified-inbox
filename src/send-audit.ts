import type Database from 'better-sqlite3';
import type { AuditRow } from './adapters/policy.ts';

/**
 * Where the send gate writes down every attempt.
 *
 * The plugin already keeps everything a reload must not lose — conversations, threads, the
 * search index — in this same storage database, so the audit is one more table rather than a
 * second kind of storage or a file under docs/. A table is the smallest thing that survives a
 * reload, can be read back, and cannot hold more than its columns declare: there is no column
 * for a message body or attachment bytes, and the gate never passes one.
 *
 * Read it back with `bb unified-inbox send-audit [limit]`, newest first.
 */
export function createSendAudit(db: Database.Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS inbox_send_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    operation TEXT NOT NULL,
    account TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    decision TEXT NOT NULL,
    reason TEXT
  )`);
  const insert = db.prepare('INSERT INTO inbox_send_audit (at, operation, account, conversation_id, decision, reason) VALUES (@at, @operation, @account, @conversationId, @decision, @reason)');
  const read = db.prepare('SELECT at, operation, account, conversation_id AS conversationId, decision, reason FROM inbox_send_audit ORDER BY id DESC LIMIT ?');
  return {
    /** One row per attempted send. Never a body, never bytes. */
    record(row: AuditRow) {
      insert.run({ ...row, reason: row.reason ?? null });
    },
    /** The last `limit` attempts, newest first. */
    list(limit = 20): AuditRow[] {
      return read.all(Math.min(Math.max(Math.trunc(limit) || 20, 1), 200)) as AuditRow[];
    },
  };
}
