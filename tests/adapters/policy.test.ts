// INBOX-7 / spec T8: the policy layer's rules, one gate for every source. What
// it refuses, what it allows, and what it writes down — never the message text.
import assert from 'node:assert/strict';
import test from 'node:test';
import { APPROVAL_WINDOW_MS, SEND_POLICY, approvalFor, createSendGate } from '../../src/adapters/policy.ts';
import { accounts } from '../../src/adapters/types.ts';
import { harness, IMSG_ID, LINKEDIN_ID } from './harness.ts';
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

// An approval is good for a window, not forever: one kept from this morning must
// not send tonight. The window is one constant where the gate lives, so no call
// site can widen it.
test('an approval older than the gate window is refused', async () => {
  const { rows, send } = gate(T0 + APPROVAL_WINDOW_MS + 1);
  let delivered = 0;
  const approval = { id: 'a2', conversationId: WHATSAPP_ID, issuedAt: T0 };
  await assert.rejects(
    send({ account: 'whatsapp', conversationId: WHATSAPP_ID, text: 'see you at six' }, approval, async () => { delivered += 1; return { status: 'Sent' }; }),
    /expired/,
  );
  assert.equal(delivered, 0);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].decision, 'refused');
  assert.match(String(rows[0].reason), /expired/);
});

// One approval, one send. A retry that reuses the same approval is how a second
// message lands in a conversation nobody meant to write twice.
test('the same approval cannot send twice', async () => {
  const { rows, send } = gate();
  const approval = { id: 'a3', conversationId: WHATSAPP_ID, issuedAt: T0 };
  let delivered = 0;
  const deliver = async () => { delivered += 1; return { status: 'Sent' }; };
  await send({ account: 'whatsapp', conversationId: WHATSAPP_ID, text: 'on my way' }, approval, deliver);
  await assert.rejects(
    send({ account: 'whatsapp', conversationId: WHATSAPP_ID, text: 'on my way' }, approval, deliver),
    /already been used/,
  );
  assert.equal(delivered, 1, 'the replayed send never reaches the adapter');
  const last = rows.at(-1)!;
  assert.equal(last.decision, 'refused');
  assert.match(String(last.reason), /already been used/);
});

// The path that must keep working: a fresh approval for this conversation sends
// once, and the row it leaves says so with the same fields as a refusal.
test('an allowed send delivers once and its row carries no message', async () => {
  const { rows, send } = gate();
  const approval = { id: 'a4', conversationId: WHATSAPP_ID, issuedAt: T0 };
  let delivered = 0;
  const receipt = await send(
    { account: 'whatsapp', conversationId: WHATSAPP_ID, text: 'the party is at eight, do not tell anyone' },
    approval,
    async () => { delivered += 1; return { status: 'Sent.' }; },
  );
  assert.deepEqual(receipt, { status: 'Sent.' });
  assert.equal(delivered, 1, 'an allowed send delivers exactly once');
  assert.equal(rows.length, 1);
  const [row] = rows;
  assert.equal(row.decision, 'allowed');
  assert.equal(row.at, T0);
  assert.equal(row.account, 'whatsapp');
  assert.equal(row.conversationId, WHATSAPP_ID);
  assert.equal(row.reason, undefined, 'an allowed send has nothing to explain');
  assert.deepEqual(
    Object.keys(row).sort(),
    ['account', 'at', 'conversationId', 'decision', 'operation'],
    'the row is the attempt: no field can carry a body or attachment bytes',
  );
  assert.ok(!JSON.stringify(rows).includes('party'), 'the audit never carries message text');
});

// Gmail sending was disabled by a named constant inside its handler. The same
// decision belongs to the gate, as a rule a person can read, and the caller's
// refusal text must not change while it moves.
test('Gmail is refused by a readable policy rule, and every source declares one', async () => {
  const { rows, send } = gate();
  const reason = 'Gmail sending is not enabled yet. Your draft has not been sent.';
  for (const account of ['personal', 'business'] as const) {
    let delivered = 0;
    await assert.rejects(
      send(
        { account, conversationId: 'thread-1', text: 'draft for the team' },
        { id: `gmail-${account}`, conversationId: 'thread-1', issuedAt: T0 },
        async () => { delivered += 1; return { status: 'Sent.' }; },
      ),
      /Gmail sending is not enabled yet\. Your draft has not been sent\./,
      'a disabled source refuses even with a valid approval',
    );
    assert.equal(delivered, 0);
    assert.equal(rows.at(-1)!.reason, reason);
  }
  assert.deepEqual(
    accounts.map(account => [account, SEND_POLICY[account].state]),
    [
      ['personal', 'disabled'],
      ['business', 'disabled'],
      ['whatsapp', 'enabled'],
      ['imessage', 'enabled'],
      ['linkedin', 'enabled'],
    ],
    'the owner decisions of 2026-11-02 are the rule the gate reads',
  );
});

// The composition the spec asks for: the gate in front of the real registry. Every
// source's send is refused before its adapter is touched, and the one enabled path
// reaches the source exactly once with an allowed row behind it.
test('a refusal stops before every adapter, and an approved WhatsApp send reaches the composer', async () => {
  const h = harness();
  const originalFetch = globalThis.fetch;
  const fetched: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    fetched.push(String(input));
    return new Response(JSON.stringify({ id: 41, status: 'pending' }), { headers: { 'content-type': 'application/json' } });
  }) as typeof globalThis.fetch;
  try {
    const { rows, send } = gate();
    const attempts: Array<[Account, string, RegExp]> = [
      ['personal', 'thread-1', /Gmail sending is not enabled yet/],
      ['business', 'thread-1', /Gmail sending is not enabled yet/],
      ['whatsapp', WHATSAPP_ID, /approv/i],
      ['imessage', IMSG_ID, /approv/i],
      ['linkedin', LINKEDIN_ID, /approv/i],
    ];
    for (const [account, conversationId, pattern] of attempts) {
      await assert.rejects(
        send({ account, conversationId, text: 'see you at six' }, undefined, () => h.registry[account].action('reply', conversationId, { text: 'see you at six' })),
        pattern,
        `${account} refuses before its adapter`,
      );
    }
    assert.deepEqual(h.calls, [], 'no source was touched by a refused send');
    assert.equal(fetched.length, 0, 'no provider HTTP call was made by a refused send');
    assert.deepEqual(rows.map(row => [row.account, row.decision]), attempts.map(([account]) => [account, 'refused']));

    // The enabled path: a fresh approval for this conversation delivers once.
    const approval = { id: 'wa-1', conversationId: WHATSAPP_ID, issuedAt: T0 };
    assert.deepEqual(
      await send({ account: 'whatsapp', conversationId: WHATSAPP_ID, text: 'On my way' }, approval, () => h.registry.whatsapp.action('reply', WHATSAPP_ID, { text: 'On my way' })),
      { status: 'Sending.' },
    );
    assert.deepEqual(
      fetched.map(url => url.replace(/^http:\/\/127\.0\.0\.1:\d+/, '')),
      [`/api/chats/${encodeURIComponent(WHATSAPP_ID)}/messages`],
      'the composer path ran once',
    );
    assert.equal(rows.at(-1)!.decision, 'allowed');
    assert.ok(!JSON.stringify(rows).includes('On my way'), 'the allowed row still carries no text');
  } finally {
    globalThis.fetch = originalFetch;
    h.close();
  }
});

// A reply the caller never marked as a send is not approved by being sent. The
// transport's one chat-send line composes this test: allow: 'send' earns the
// approval, and its absence hands the gate none, so the gate refuses and records
// it — the adapter is not reached either way.
test('a reply without allow: send is refused and audited, and with it delivers once', async () => {
  const h = harness();
  const originalFetch = globalThis.fetch;
  const fetched: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    fetched.push(String(input));
    return new Response(JSON.stringify({ id: 41, status: 'pending' }), { headers: { 'content-type': 'application/json' } });
  }) as typeof globalThis.fetch;
  try {
    const { rows, send } = gate();
    const reply = (allow: 'send' | undefined) => send(
      { account: 'whatsapp', conversationId: WHATSAPP_ID, text: 'On my way' },
      approvalFor(allow, WHATSAPP_ID, T0),
      () => h.registry.whatsapp.action('reply', WHATSAPP_ID, { text: 'On my way' }),
    );

    await assert.rejects(reply(undefined), /approv/i);
    assert.deepEqual(h.calls, [], 'a reply with no send statement never reaches the adapter');
    assert.equal(fetched.length, 0, 'and makes no provider call');
    assert.equal(rows.at(-1)!.decision, 'refused');
    assert.match(String(rows.at(-1)!.reason), /approv/i);

    assert.deepEqual(await reply('send'), { status: 'Sending.' });
    assert.deepEqual(
      fetched.map(url => url.replace(/^http:\/\/127\.0\.0\.1:\d+/, '')),
      [`/api/chats/${encodeURIComponent(WHATSAPP_ID)}/messages`],
      'the owner statement reaches the composer once',
    );
    assert.equal(rows.at(-1)!.decision, 'allowed');
  } finally {
    globalThis.fetch = originalFetch;
    h.close();
  }
});
