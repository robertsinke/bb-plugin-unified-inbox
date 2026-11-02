// INBOX-7 / spec T8: the policy layer's rules, one gate for every source. What
// it refuses, what it allows, and what it writes down — never the message text.
import assert from 'node:assert/strict';
import test from 'node:test';
import { APPROVAL_WINDOW_MS, SEND_POLICY, approvalFor, createSendGate } from '../../src/adapters/policy.ts';
import { accounts } from '../../src/adapters/types.ts';
import { harness, IMSG_ID, LINKEDIN_ID } from './harness.ts';
import type { Account } from '../../src/adapters/types.ts';
// The row shape is the gate's, not a copy: a duplicate here silently missed a new column.
import type { AuditRow } from '../../src/adapters/policy.ts';

const T0 = 1_700_000_000_000;
const WHATSAPP_ID = '15550000001@s.whatsapp.net';
const OTHER_ID = '4915112345678@s.whatsapp.net';

/** The store the gate writes to and reads spend from — the plugin's table in production. */
function memoryStore() {
  const rows: AuditRow[] = [];
  const spent = new Set<string>();
  return {
    rows,
    record(row: AuditRow) {
      rows.push(row);
      if (row.decision === 'allowed' && row.approvalId) spent.add(row.approvalId);
    },
    hasSpent(approvalId: string) {
      return spent.has(approvalId);
    },
  };
}

function gate(now = T0) {
  const store = memoryStore();
  return { rows: store.rows, store, send: createSendGate({ now: () => now, store }) };
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
    ['account', 'approvalId', 'at', 'conversationId', 'decision', 'operation'],
    'the row is the attempt and the approval it spends: no field can carry a body or attachment bytes',
  );
  assert.ok(!JSON.stringify(rows).includes('party'), 'the audit never carries message text');
});

// Gmail sending was disabled by a named constant inside its handler; that decision moved to the
// gate. On 2026-11-03 the owner enabled it, so what the gate owes every source is the same two
// rules: an approval, and a policy entry that says enabled.
test('every source declares its policy, and every enabled source still needs an approval', async () => {
  const { rows, send } = gate();
  assert.deepEqual(
    accounts.map(account => [account, SEND_POLICY[account].state]),
    [
      ['personal', 'enabled'],
      ['business', 'enabled'],
      ['whatsapp', 'enabled'],
      ['imessage', 'enabled'],
      ['linkedin', 'enabled'],
    ],
    'the owner decisions are the rule the gate reads',
  );

  for (const account of accounts) {
    let delivered = 0;
    const deliver = async () => { delivered += 1; return { status: 'Sent.' }; };
    await assert.rejects(
      send({ account, conversationId: 'thread-1', text: 'draft for the team' }, undefined, deliver),
      /approv/i,
      `${account}: an enabled source refuses a send that carries no approval`,
    );
    assert.equal(delivered, 0, `${account}: the adapter is never reached without an approval`);
    assert.equal(rows.at(-1)!.decision, 'refused');

    await send(
      { account, conversationId: 'thread-1', text: 'draft for the team' },
      { id: `approval-${account}`, conversationId: 'thread-1', issuedAt: T0 },
      deliver,
    );
    assert.equal(delivered, 1, `${account}: an approval lets the one send through`);
    assert.equal(rows.at(-1)!.decision, 'allowed');
  }
});

// A blind copy is the one recipient the conversation id cannot explain — a send to yourself with a
// bcc carries the same conversation id as a send to yourself alone. The log says who, never what.
test('a blind copy is written down, and a send without one leaves the column empty', async () => {
  const { rows, send } = gate();
  await send(
    { account: 'personal', conversationId: 'thread-1', text: 'for your eyes', bcc: 'quiet@example.com' },
    { id: 'bcc-1', conversationId: 'thread-1', issuedAt: T0 },
    async () => ({ status: 'Sent.' }),
  );
  assert.equal(rows.at(-1)!.bcc, 'quiet@example.com', 'the log names the blind copy');
  assert.ok(!JSON.stringify(rows).includes('for your eyes'), 'and still carries no message text');

  await send(
    { account: 'personal', conversationId: 'thread-1', text: 'no copy this time' },
    { id: 'bcc-2', conversationId: 'thread-1', issuedAt: T0 },
    async () => ({ status: 'Sent.' }),
  );
  assert.ok(!rows.at(-1)!.bcc, 'no blind copy is an empty column, not a guess');
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
      ['personal', 'thread-1', /approv/i],
      ['business', 'thread-1', /approv/i],
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

// A reload must not revive a spent approval. The gate reads spend from the store
// it writes to, so a second gate built over the same store — what a plugin reload
// is — sees the earlier spend and refuses the reuse.
test('a spent approval stays spent across a reload', async () => {
  const store = memoryStore();
  const first = createSendGate({ now: () => T0, store });
  const approval = { id: 'reload-1', conversationId: WHATSAPP_ID, issuedAt: T0 };
  await first({ account: 'whatsapp', conversationId: WHATSAPP_ID, text: 'hello' }, approval, async () => ({ status: 'Sent' }));

  const second = createSendGate({ now: () => T0, store });
  let delivered = 0;
  await assert.rejects(
    second({ account: 'whatsapp', conversationId: WHATSAPP_ID, text: 'hello again' }, approval, async () => { delivered += 1; return { status: 'Sent' }; }),
    /already been used/,
    'the reloaded gate still knows the approval was spent',
  );
  assert.equal(delivered, 0);
  assert.equal(store.rows.filter(row => row.decision === 'refused').length, 1, 'and records the refusal');
});
