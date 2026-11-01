// INBOX-7 / spec T8: one send gate in front of every adapter. The gate owns the
// call, so "refused" means the adapter was never reached — not that a handler
// remembered to check a flag first.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createSendGate } from '../src/adapters/policy.ts';
import type { Account } from '../src/adapters/types.ts';

type AuditRow = {
  at: number;
  account: Account;
  conversationId: string;
  decision: 'allowed' | 'refused';
  reason?: string;
};

const T0 = 1_700_000_000_000;

function gate() {
  const rows: AuditRow[] = [];
  return { rows, send: createSendGate({ now: () => T0, audit: row => { rows.push(row as AuditRow); } }) };
}

test('an unapproved send is refused, and the adapter is never reached', async () => {
  const { rows, send } = gate();
  let delivered = 0;

  await assert.rejects(
    send(
      { account: 'whatsapp', conversationId: '15550000001@s.whatsapp.net', text: 'see you at six' },
      undefined,
      async () => { delivered += 1; return { status: 'Sent' }; },
    ),
    /approv/i,
    'a send without an approval says why it was refused',
  );

  assert.equal(delivered, 0, 'the adapter must not be reached at all');

  assert.equal(rows.length, 1, 'the refused attempt is still recorded');
  const row = rows[0];
  assert.equal(row.decision, 'refused');
  assert.equal(row.account, 'whatsapp');
  assert.equal(row.conversationId, '15550000001@s.whatsapp.net');
  assert.equal(row.at, T0);
  assert.ok(
    !JSON.stringify(row).includes('see you at six'),
    'the audit never carries message text',
  );
});