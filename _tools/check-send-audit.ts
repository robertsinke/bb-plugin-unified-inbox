import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const WINDOW_DAYS = 7;

/** Read-only inspection of the installed plugin, never a schema migration or a send. */
export function sendAuditWarning(databasePath: string, since: number): string | null {
  const db = new Database(databasePath, { readonly: true, fileMustExist: true, timeout: 1_000 });
  try {
    const rows = db.prepare(`SELECT id, account FROM inbox_send_audit
      WHERE decision = 'allowed' AND (approval_id IS NULL OR trim(approval_id) = '') AND at >= ?
      ORDER BY id`).all(since) as { id: number; account: string }[];
    if (!rows.length) return null;
    const counts: Record<string, number> = Object.create(null);
    for (const row of rows) counts[row.account] = (counts[row.account] ?? 0) + 1;
    return `[send-audit] WARNING: ${rows.length} allowed attempts without an approval id since ${new Date(since).toISOString()}; counts=${JSON.stringify(counts)}; audit row ids=${rows.map(row => row.id).join(',')}. Investigate: rows precede dispatch and do not prove delivery or human approval. This does not detect caller-minted approval ids.`;
  } finally { db.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const status = JSON.parse(execFileSync('bb', ['status', '--json'], { encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'pipe'] }));
    if (typeof status.dataDir !== 'string' || !status.dataDir) throw new Error('BB did not report a data directory');
    const warning = sendAuditWarning(join(status.dataDir, 'plugins', 'unified-inbox', 'data.db'), Date.now() - WINDOW_DAYS * 86_400_000);
    if (warning) console.warn(warning);
  } catch (error) {
    const reason = error instanceof Error ? error.message.split('\n')[0] : 'unknown error';
    console.warn(`[send-audit] WARNING: audit NOT CHECKED (${reason}). No conclusion about unapproved sends.`);
  }
}
