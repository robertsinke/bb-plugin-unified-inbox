// The RPC contract is a module, not a side effect of the plugin entry point, so a
// schema edit can be proved by a test instead of only by a live call. Every check
// here is a claim a caller can rely on.
import assert from 'node:assert/strict';
import test from 'node:test';
import { rpcContract } from '../src/rpc-contract.ts';

test('a minimal Gmail send reaches the policy, not a schema refusal', () => {
  const parsed = rpcContract.send_gmail.input.safeParse({
    account: 'gmail-personal',
    to: 'ada@example.com',
    subject: 'Dinner',
    text: 'See you at six',
  });
  assert.equal(parsed.success, true, 'to, subject and text are enough; cc is optional');
});

test('a Gmail send can carry the send statement, so enabling it is a policy flip', () => {
  const parsed = rpcContract.send_gmail.input.safeParse({
    account: 'gmail-personal',
    to: 'ada@example.com',
    cc: 'grace@example.com',
    subject: 'Dinner',
    text: 'See you at six',
    allow: 'send',
  });
  assert.equal(parsed.success, true, 'the same word the chat send path uses');
  const refused = rpcContract.send_gmail.input.safeParse({
    account: 'gmail-personal',
    to: 'ada@example.com',
    subject: 'Dinner',
    text: 'See you at six',
    allow: 'please',
  });
  assert.equal(refused.success, false, 'and only that exact word');
});

test('a chat send says allow: send, and an unknown field is still refused', () => {
  const ok = rpcContract.action.input.safeParse({ account: 'whatsapp', id: 'c', action: 'reply', text: 'hi', allow: 'send' });
  assert.equal(ok.success, true);
  const typo = rpcContract.action.input.safeParse({ account: 'whatsapp', id: 'c', action: 'reply', text: 'hi', allows: 'send' });
  assert.equal(typo.success, false, 'a mistyped approval field is refused rather than ignored');
});

test('a send decision that was allowed has no reason, and the contract says so', () => {
  const allowed = {
    rows: [{
      at: 1,
      account: 'whatsapp',
      conversationId: 'chat-1',
      decision: 'allowed',
      // the gate writes a reason only when it refuses; an allowance has nothing to explain
      reason: null,
    }],
  };
  assert.equal(rpcContract.send_audit.output.safeParse(allowed).success, true, 'an allowed row with a null reason must parse');

  const refused = { rows: [{ ...allowed.rows[0], decision: 'refused', reason: 'nothing was sent' }] };
  assert.equal(rpcContract.send_audit.output.safeParse(refused).success, true, 'a refusal keeps its reason');
  // A blind copy is who the message reached silently; an old row has no such column at all, so
  // null and missing must both be readable rather than thrown away.
  const copying = { rows: [{ ...allowed.rows[0], bcc: 'quiet@example.com' }] };
  assert.equal(rpcContract.send_audit.output.safeParse(copying).success, true, 'a row remembers the blind copy');
  assert.equal(rpcContract.send_audit.output.safeParse({ rows: [{ ...allowed.rows[0], bcc: null }] }).success, true, 'and a send without one reads as null');
  // `safeParse` success proves nothing on its own: an object schema strips a key it does not know,
  // so a row could parse "fine" and lose the very field this log exists to keep. Pin the values.
  const kept = rpcContract.send_audit.output.parse({ rows: [{ ...allowed.rows[0], bcc: 'quiet@example.com', approvalId: 'a-1' }] });
  assert.equal(kept.rows[0].bcc, 'quiet@example.com', 'the blind copy survives the contract');
  assert.equal(kept.rows[0].approvalId, 'a-1', 'and so does the approval id, which says whether one was spent');
  const observed = rpcContract.send_audit.output.parse({ rows: [{ ...allowed.rows[0], reason: 'page-confirmed replay', approvalId: null }] });
  assert.equal(observed.rows[0].approvalId, null, 'a delivery with no approval reads as null, not as absent');
});

test('a Gmail draft can carry a blind copy', () => {
  const send = { account: 'gmail-business' as const, to: 'a@example.com', bcc: 'hidden@example.com', subject: 'Hi', text: 'Hello' };
  assert.equal(rpcContract.send_gmail.input.safeParse(send).success, true);
  assert.equal(rpcContract.send_gmail.input.safeParse({ ...send, bcc: 'x@example.com\r\nBcc: y@example.com' }).success, false, 'the header guard applies to bcc too');
});

test('list keeps the no-input call every consumer makes and gains an opt-in page request', () => {
  assert.equal(rpcContract.list.input.safeParse(null).success, true, 'the panel, the CLI and the mention provider all pass null');
  assert.equal(rpcContract.list.input.safeParse({}).success, true);
  assert.equal(rpcContract.list.input.safeParse({ older: true }).success, true);
  assert.equal(rpcContract.list.input.safeParse({ older: 'yes' }).success, false, 'only a boolean asks for a page');
  assert.equal(rpcContract.list.input.safeParse({ older: true, cursor: 'page-2' }).success, false, 'a mistyped field is refused, not ignored: the gateway keeps the cursor');
  assert.equal(rpcContract.list.input.safeParse({ older: true, account: 'gmail-personal' }).success, true, 'one source can be asked on its own, which is how the list grows as each answers');
  assert.equal(rpcContract.list.input.safeParse({ older: true, account: 'nobody' }).success, false, 'and only a source that exists');

  // The shape the panel has always been handed still parses, so a caller that never asks for a
  // page reads exactly what it read before; `more` is the addition, not a replacement.
  assert.equal(rpcContract.list.output.safeParse({ items: [], errors: [] }).success, true);
  assert.equal(rpcContract.list.output.safeParse({ items: [], errors: ['WhatsApp unavailable.'], more: true }).success, true);
});

test('a source refresh may say it has an older page, and may say nothing at all', () => {
  assert.equal(rpcContract.sync.output.safeParse({ items: [], updatedAt: 1 }).success, true, 'a source that cannot page answers as it always did');
  assert.equal(rpcContract.sync.output.safeParse({ items: [], updatedAt: 1, more: true }).success, true);
});

test('a call that takes nothing parses as null and as an empty object', () => {
  // The same calls arrive both ways in the log: the panel and the CLI pass null, a client that always
  // sends a body passes {}. A refusal on the shape alone is a failure the caller cannot act on.
  const noArg = ['cached', 'freshness', 'search_status', 'clear_cache', 'linkedin_writes', 'linkedin_signin', 'mail_approval_policy', 'capabilities', 'sources'] as const;
  for (const method of noArg) {
    assert.equal(rpcContract[method].input.safeParse(null).success, true, `${method} answers a null call`);
    assert.equal(rpcContract[method].input.safeParse({}).success, true, `${method} answers an empty-body call`);
    assert.equal(rpcContract[method].input.safeParse({ limit: 5 }).success, false, `${method} still refuses a call that names something`);
  }
});

test('the audit and approval-status reads survive a caller with nothing to ask', () => {
  // Both fields are optional, so both methods are readable with no argument; the gateway must not
  // read through a null it was handed.
  for (const method of ['send_audit', 'mail_approval_status'] as const) {
    assert.equal(rpcContract[method].input.safeParse(null).success, true, `${method} answers a null call`);
    assert.equal(rpcContract[method].input.safeParse({}).success, true, `${method} answers an empty call`);
  }
  assert.equal(rpcContract.send_audit.input.safeParse({ limit: 0 }).success, false, 'and a page size is still a page size');
});

test('the pairing call reads with nothing and acts with one of four words', () => {
  assert.equal(rpcContract.whatsapp_pairing.input.safeParse(null).success, true, 'the card polls with no input at all');
  assert.equal(rpcContract.whatsapp_pairing.input.safeParse({ op: 'pair' }).success, true);
  assert.equal(rpcContract.whatsapp_pairing.input.safeParse({ op: 'request-code', phone: '31612345678' }).success, true);
  assert.equal(rpcContract.whatsapp_pairing.input.safeParse({ op: 'reconnect' }).success, true, 'a socket that will not open is reopened, not re-paired');
  assert.equal(rpcContract.whatsapp_pairing.input.safeParse({ op: 'retry' }).success, false, 'there is no retry: a lost device is re-paired');
  assert.equal(rpcContract.whatsapp_pairing.input.safeParse({ op: 'pair', phone: '31612345678', replace: true }).success, false, 'and replacing a linked device is not a flag on pairing');
  assert.equal(rpcContract.whatsapp_pairing.output.safeParse({ state: 'qr', qr: 'x', expiresAt: 1 }).success, true);
  assert.equal(rpcContract.whatsapp_pairing.output.safeParse({ state: 'unpaired', message: 'nothing yet' }).success, true);
  assert.equal(rpcContract.whatsapp_pairing.output.safeParse({ state: 'failed', message: 'already open in process 42' }).success, true, 'an account whose socket would not open says so');
  assert.equal(rpcContract.whatsapp_pairing.output.safeParse({ state: 'paired' }).success, false, 'the seven states are the whole vocabulary');
});
