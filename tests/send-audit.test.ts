// INBOX-7: the audit's home. The gate hands every attempt to a store that lives in
// the plugin's own database, next to the inbox cache, so it outlives a reload and
// can be read back without anyone's message text.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { createSendGate } from '../src/adapters/policy.ts';
import { createSendAudit } from '../src/send-audit.ts';

const T0 = 1_700_000_000_000;
const CONVERSATION = '15550000001@s.whatsapp.net';

test('the audit survives a reload and never holds message text', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'inbox-send-audit-'));
  const file = join(dir, 'plugin.db');
  try {
    const first = new Database(file);
    const audit = createSendAudit(first);
    const send = createSendGate({ now: () => T0, store: audit });
    await send(
      { account: 'whatsapp', conversationId: CONVERSATION, text: 'the party is at eight' },
      { id: 'a1', conversationId: CONVERSATION, issuedAt: T0 },
      async () => ({ status: 'Sent.' }),
    );
    await assert.rejects(
      send(
        { account: 'whatsapp', conversationId: CONVERSATION, text: 'the party is at eight' },
        undefined,
        async () => ({ status: 'Sent.' }),
      ),
      /approv/i,
    );
    first.close();

    // A reload is a new connection to the same database and a new gate.
    const second = new Database(file);
    const reloadedAudit = createSendAudit(second);
    const reloadedGate = createSendGate({ now: () => T0, store: reloadedAudit });

    // The approval that already sent something cannot be spent again by the new gate.
    await assert.rejects(
      reloadedGate(
        { account: 'whatsapp', conversationId: CONVERSATION, text: 'the party is at eight' },
        { id: 'a1', conversationId: CONVERSATION, issuedAt: T0 },
        async () => ({ status: 'Sent.' }),
      ),
      /already been used/,
      'spend is read from the rows, so a reload cannot revive a spent approval',
    );
    const rows = reloadedAudit.list();
    second.close();

    assert.deepEqual(
      rows.map(row => [row.decision, row.account, row.conversationId, row.at]),
      [
        ['refused', 'whatsapp', CONVERSATION, T0],
        ['refused', 'whatsapp', CONVERSATION, T0],
        ['allowed', 'whatsapp', CONVERSATION, T0],
      ],
      'newest first, both decisions kept across a reload',
    );
    assert.match(String(rows[1].reason), /approv/i, 'a refusal keeps the reason it was refused for');
    assert.match(String(rows[0].reason), /already been used/, 'and the reloaded refusal says why');
    assert.ok(!JSON.stringify(rows).includes('party'), 'the audit never carries message text');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A machine that ran the earlier build has the table without `approval_id`, and
// CREATE TABLE IF NOT EXISTS silently leaves it that way — so opening the audit
// must migrate it in place rather than fail on the first insert.
test('an audit table from the earlier build gains the newer columns in place', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'inbox-send-audit-old-'));
  const file = join(dir, 'plugin.db');
  try {
    const old = new Database(file);
    old.exec(`CREATE TABLE inbox_send_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at INTEGER NOT NULL,
      operation TEXT NOT NULL,
      account TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      decision TEXT NOT NULL,
      reason TEXT
    )`);
    old.prepare("INSERT INTO inbox_send_audit (at, operation, account, conversation_id, decision, reason) VALUES (1,'send','whatsapp','c','refused','old row')").run();
    old.close();

    const reopened = new Database(file);
    const audit = createSendAudit(reopened);
    assert.equal(audit.list().length, 1, 'the row written before the migration is still there');
    audit.record({ at: 2, operation: 'send', account: 'personal', conversationId: 'b', decision: 'allowed', approvalId: 'p2', bcc: 'quiet@example.com' });
    assert.equal(audit.list()[0].bcc, 'quiet@example.com', 'and the blind copy has somewhere to go');
    const gate = createSendGate({ now: () => T0, store: audit });
    await gate(
      { account: 'whatsapp', conversationId: 'c', text: 'hi' },
      { id: 'post-migration', conversationId: 'c', issuedAt: T0 },
      async () => ({ status: 'Sent.' }),
    );
    assert.equal(audit.hasSpent('post-migration'), true, 'and the migrated table records spend');
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
