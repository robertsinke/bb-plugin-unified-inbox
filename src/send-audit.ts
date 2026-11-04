import type Database from 'better-sqlite3';
import type { AuditRow } from './adapters/policy.ts';
import { migrateGmailAccountIds } from './inbox-cache.ts';

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
    reason TEXT,
    bcc TEXT
  )`);
  // A table from an earlier build predates one or more of these, and CREATE TABLE IF NOT EXISTS
  // will not add a column to it — so every column the rows need is added in place, once.
  const present = new Set(
    (db.prepare('PRAGMA table_info(inbox_send_audit)').all() as { name: string }[]).map(column => column.name),
  );
  for (const column of ['approval_id', 'bcc', 'payload_hash', 'assertion_hash', 'key_id', 'authorization_model', 'assertion_trust']) {
    if (!present.has(column)) db.exec(`ALTER TABLE inbox_send_audit ADD COLUMN ${column} TEXT`);
  }
  migrateGmailAccountIds(db);
  const insert = db.prepare('INSERT INTO inbox_send_audit (at, operation, account, conversation_id, decision, approval_id, reason, bcc, payload_hash, assertion_hash, key_id, authorization_model, assertion_trust) VALUES (@at, @operation, @account, @conversationId, @decision, @approvalId, @reason, @bcc, @payloadHash, @assertionHash, @keyId, @authorizationModel, @assertionTrust)');
  const read = db.prepare('SELECT at, operation, account, conversation_id AS conversationId, decision, approval_id AS approvalId, reason, bcc, payload_hash AS payloadHash, assertion_hash AS assertionHash, key_id AS keyId, authorization_model AS authorizationModel, assertion_trust AS assertionTrust FROM inbox_send_audit ORDER BY id DESC LIMIT ?');
  const spentRow = db.prepare("SELECT 1 FROM inbox_send_audit WHERE approval_id = ? AND decision = 'allowed' LIMIT 1");
  return {
    /** Last mail-envelope refusal across both Gmail accounts; historical and reload-persistent. */
    lastMailRefusal(): { reason: string; at: number; account: string } | null {
      return db.prepare("SELECT reason, at, account FROM inbox_send_audit WHERE decision = 'refused' AND authorization_model = 'envelope_mail' ORDER BY id DESC LIMIT 1").get() as { reason: string; at: number; account: string } | undefined ?? null;
    },
    /** One row per attempted send. Never a body, never bytes. */
    record(row: AuditRow) {
      insert.run({ ...row, approvalId: row.approvalId ?? null, reason: row.reason ?? null, bcc: row.bcc ?? null,
        payloadHash: row.payloadHash ?? null, assertionHash: row.assertionHash ?? null,
        keyId: row.keyId ?? null, authorizationModel: row.authorizationModel ?? null, assertionTrust: row.assertionTrust ?? null });
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
