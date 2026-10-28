import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { approvalHash, confirmProposalRequest, latestInboundId } from '../src/whatsapp-confirm.ts';

test('approval hash is the sha256 of trimmed text', () => {
  assert.equal(approvalHash('  hi  '), approvalHash('hi'));
  assert.equal(approvalHash('hi'), '8f434346648f6b96df89dda901c5176b10a6d83961dd3c1ac88b59b2dc327aa4');
});

test('latest inbound skips newer messages you sent', () => {
  assert.equal(latestInboundId([
    { id: 'old', from_me: false },
    { id: 'mine', from_me: true },
  ]), 'old');
  assert.equal(latestInboundId([{ id: 'mine', from_me: true }]), undefined);
});

test('confirm request stays on loopback and carries the reviewed hash', () => {
  const request = confirmProposalRequest(8787, 4, 'abc', 'in-1');
  assert.equal(request.url, 'http://127.0.0.1:8787/api/proposals/4/confirm');
  assert.equal(request.origin, 'http://127.0.0.1:8787');
  assert.deepEqual(request.body, { base_hash: 'abc', confirmed_latest_inbound_id: 'in-1' });
  assert.throws(() => confirmProposalRequest(0, 4, 'abc', undefined));
});
