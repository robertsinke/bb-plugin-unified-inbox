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
