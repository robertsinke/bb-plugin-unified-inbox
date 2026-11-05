import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const WINDOW_DAYS = 7;

/**
 * One `bb status --json` round-trip, which spawns the CLI and reaches the BB server. 30 s is the
 * budget every external tool gets here; the 5 s this used to allow made a loaded machine look
 * exactly like an audit that could not be read, and the log said so either way.
 */
const CLI_TIMEOUT_MS = Number(process.env.UNIFIED_INBOX_AUDIT_TIMEOUT_MS ?? 30_000);

/** Read-only inspection of the installed plugin, never a schema migration or a send. */
export function sendAuditWarning(databasePath: string, since: number): string | null {
  const db = new Database(databasePath, { readonly: true, fileMustExist: true, timeout: 1_000 });
  try {
    const rows = db.prepare(`SELECT id, account FROM inbox_send_audit
      WHERE decision = 'allowed' AND (approval_id IS NULL OR trim(approval_id) = '' OR authorization_model = 'legacy_mail_allow') AND at >= ?
      ORDER BY id`).all(since) as { id: number; account: string }[];
    if (!rows.length) return null;
    const counts: Record<string, number> = Object.create(null);
    for (const row of rows) counts[row.account] = (counts[row.account] ?? 0) + 1;
    return `[send-audit] WARNING: ${rows.length} allowed attempts with missing approval ids or legacy mail consent since ${new Date(since).toISOString()}; counts=${JSON.stringify(counts)}; audit row ids=${rows.map(row => row.id).join(',')}. Investigate: rows precede dispatch and do not prove delivery or human approval. Legacy mail markers are included even with caller-minted ids; unmarked historical ids do not prove human approval.`;
  } finally { db.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const status = JSON.parse(execFileSync('bb', ['status', '--json'], { encoding: 'utf8', timeout: CLI_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'] }));
    if (typeof status.dataDir !== 'string' || !status.dataDir) throw new Error('BB did not report a data directory');
    const warning = sendAuditWarning(join(status.dataDir, 'plugins', 'unified-inbox', 'data.db'), Date.now() - WINDOW_DAYS * 86_400_000);
    if (warning) console.warn(warning);
  } catch (error) {
    const reason = error instanceof Error ? error.message.split('\n')[0] : 'unknown error';
    console.warn(`[send-audit] WARNING: audit NOT CHECKED (${reason}). No conclusion about unapproved sends.`);
  }
}
