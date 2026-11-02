import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createAsyncGate, createAsyncPool } from '../src/async-gate.ts';

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

test('the pool runs at most `limit` calls at once and frees a slot on failure', async () => {
  const pool = createAsyncPool(2);
  let active = 0;
  let maxActive = 0;
  const claim = (fail = false) => pool(async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active -= 1;
    if (fail) throw new Error('keyring');
  });
  const runs = [claim(), claim(true), claim(), claim(), claim()];
  await Promise.allSettled(runs);
  assert.equal(maxActive, 2, 'the bound holds across five calls, one of which fails');
  assert.equal(await pool(async () => 'ok'), 'ok', 'a failed call leaves the pool usable');
});
