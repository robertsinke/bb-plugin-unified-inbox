// INBOX-7 / spec T8: the policy layer's rules, one gate for every source. What
// it refuses, what it allows, and what it writes down — never the message text.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createSendGate } from '../../src/adapters/policy.ts';
import type { Account } from '../../src/adapters/types.ts';

type AuditRow = {
  at: number;
  account: Account;
  conversationId: string;
  decision: 'allowed' | 'refused';
  reason?: string;
};

const T0 = 1_700_000_000_000;
const WHATSAPP_ID = '4797044099@s.whatsapp.net';
const OTHER_ID = '4915112345678@s.whatsapp.net';

function gate(now = T0) {
  const rows: AuditRow[] = [];
  return { rows, send: createSendGate({ now: () => now, audit: row => { rows.push(row as AuditRow); } }) };
}

// The incident this rule exists for: three messages meant as notes went to the
// wrong person, because the name search offered a suggestion and identity was
// never verified. An approval names one conversation or it is not an approval.
test('an approval for one conversation cannot send to another', async () => {
  const { rows, send } = gate();
  let delivered = 0;
  const approval = { id: 'a1', conversationId: WHATSAPP_ID, issuedAt: T0 };
  await assert.rejects(
    send({ account: 'whatsapp', conversationId: OTHER_ID, text: 'this was meant as a note' }, approval, async () => { delivered += 1; return { status: 'Sent' }; }),
    /does not cover this conversation/,
  );
  assert.equal(delivered, 0, 'the misaddressed send never reaches the adapter');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].decision, 'refused');
  assert.match(String(rows[0].reason), /does not cover this conversation/);
  assert.ok(
    !/not approved/i.test(String(rows[0].reason)),
    'the refusal names the conversation the approval covers, not a blanket "not approved"',
  );
});
