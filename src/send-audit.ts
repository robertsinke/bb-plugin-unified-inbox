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
    approval_id TEXT,
    reason TEXT
  )`);
  // The table on a machine that ran an earlier build predates `approval_id`, and
  // CREATE TABLE IF NOT EXISTS will not add a column to it. Add it in place, once.
  const columns = db.prepare('PRAGMA table_info(inbox_send_audit)').all() as { name: string }[];
  if (!columns.some(column => column.name === 'approval_id')) {
    db.exec('ALTER TABLE inbox_send_audit ADD COLUMN approval_id TEXT');
  }
  const insert = db.prepare('INSERT INTO inbox_send_audit (at, operation, account, conversation_id, decision, approval_id, reason) VALUES (@at, @operation, @account, @conversationId, @decision, @approvalId, @reason)');
  const read = db.prepare('SELECT at, operation, account, conversation_id AS conversationId, decision, approval_id AS approvalId, reason FROM inbox_send_audit ORDER BY id DESC LIMIT ?');
  const spentRow = db.prepare("SELECT 1 FROM inbox_send_audit WHERE approval_id = ? AND decision = 'allowed' LIMIT 1");
  return {
    /** One row per attempted send. Never a body, never bytes. */
    record(row: AuditRow) {
      insert.run({ ...row, approvalId: row.approvalId ?? null, reason: row.reason ?? null });
    },
    /**
     * Whether this approval was already spent, read from the rows themselves rather than
     * from memory — so a plugin reload cannot revive an approval that already sent something.
     */
    hasSpent(approvalId: string): boolean {
      return spentRow.get(approvalId) !== undefined;
    },
    /** The last `limit` attempts, newest first. */
    list(limit = 20): AuditRow[] {
      return read.all(Math.min(Math.max(Math.trunc(limit) || 20, 1), 200)) as AuditRow[];
    },
  };
}
