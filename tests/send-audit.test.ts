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
    const send = createSendGate({ now: () => T0, audit: row => audit.record(row) });
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
    const rows = createSendAudit(second).list();
    second.close();

    assert.deepEqual(
      rows.map(row => [row.decision, row.account, row.conversationId, row.at]),
      [
        ['refused', 'whatsapp', CONVERSATION, T0],
        ['allowed', 'whatsapp', CONVERSATION, T0],
      ],
      'newest first, both decisions kept across a reload',
    );
    assert.match(String(rows[0].reason), /approv/i, 'a refusal keeps the reason it was refused for');
    assert.ok(!JSON.stringify(rows).includes('party'), 'the audit never carries message text');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
