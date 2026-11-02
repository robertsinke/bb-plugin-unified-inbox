// The RPC contract is a module, not a side effect of the plugin entry point, so a
// schema edit can be proved by a test instead of only by a live call. Every check
// here is a claim a caller can rely on.
import assert from 'node:assert/strict';
import test from 'node:test';
import { rpcContract } from '../src/rpc-contract.ts';

test('a minimal Gmail send reaches the policy, not a schema refusal', () => {
  const parsed = rpcContract.send_gmail.input.safeParse({
    account: 'personal',
    to: 'ada@example.com',
    subject: 'Dinner',
    text: 'See you at six',
  });
  assert.equal(parsed.success, true, 'to, subject and text are enough; cc is optional');
});

test('a Gmail send can carry the send statement, so enabling it is a policy flip', () => {
  const parsed = rpcContract.send_gmail.input.safeParse({
    account: 'personal',
    to: 'ada@example.com',
    cc: 'grace@example.com',
    subject: 'Dinner',
    text: 'See you at six',
    allow: 'send',
  });
  assert.equal(parsed.success, true, 'the same word the chat send path uses');
  const refused = rpcContract.send_gmail.input.safeParse({
    account: 'personal',
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
  const send = { account: 'business' as const, to: 'a@example.com', bcc: 'hidden@example.com', subject: 'Hi', text: 'Hello' };
  assert.equal(rpcContract.send_gmail.input.safeParse(send).success, true);
  assert.equal(rpcContract.send_gmail.input.safeParse({ ...send, bcc: 'x@example.com\r\nBcc: y@example.com' }).success, false, 'the header guard applies to bcc too');
});

test('list keeps the no-input call every consumer makes and gains an opt-in page request', () => {
  assert.equal(rpcContract.list.input.safeParse(null).success, true, 'the panel, the CLI and the mention provider all pass null');
  assert.equal(rpcContract.list.input.safeParse({}).success, true);
  assert.equal(rpcContract.list.input.safeParse({ older: true }).success, true);
  assert.equal(rpcContract.list.input.safeParse({ older: 'yes' }).success, false, 'only a boolean asks for a page');
  assert.equal(rpcContract.list.input.safeParse({ older: true, cursor: 'page-2' }).success, false, 'a mistyped field is refused, not ignored: the gateway keeps the cursor');
  assert.equal(rpcContract.list.input.safeParse({ older: true, account: 'personal' }).success, true, 'one source can be asked on its own, which is how the list grows as each answers');
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
