import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createAsyncGate } from '../src/async-gate.ts';

test('a second Gmail call waits until the first releases the keyring', async () => {
  const gate = createAsyncGate();
  let active = 0;
  let maxActive = 0;
  const claim = () => gate(async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise(resolve => setTimeout(resolve, 20));
    active -= 1;
  });
  await Promise.all([claim(), claim(), claim()]);
  assert.equal(maxActive, 1);
});

test('a failed call does not stick the gate', async () => {
  const gate = createAsyncGate();
  await assert.rejects(gate(async () => { throw new Error('keyring'); }), /keyring/);
  assert.equal(await gate(async () => 'ok'), 'ok');
});
