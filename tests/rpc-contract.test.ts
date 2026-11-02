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
});

test('a Gmail draft can carry a blind copy', () => {
  const send = { account: 'business' as const, to: 'a@example.com', bcc: 'hidden@example.com', subject: 'Hi', text: 'Hello' };
  assert.equal(rpcContract.send_gmail.input.safeParse(send).success, true);
  assert.equal(rpcContract.send_gmail.input.safeParse({ ...send, bcc: 'x@example.com\r\nBcc: y@example.com' }).success, false, 'the header guard applies to bcc too');
});
