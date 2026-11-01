import assert from 'node:assert/strict';
import test from 'node:test';
import { CAPABILITY_KEYS, NO_CAPABILITIES, capabilitiesSchema } from '../src/adapters/capability.ts';
import { harness } from './adapters/harness.ts';

/**
 * A capability is declared in five places today: the `Capabilities` interface, every adapter's
 * literal, the gateway's zod schema, the UI's fallback, and the test fixtures. Adding `threads`
 * and `followsList` touched 19 files, and nothing failed when one place was missed — a source
 * simply went quiet, or the gateway rejected a declaration it should have accepted.
 *
 * These tests pin the end state: one list names the capabilities, and everything else follows
 * from it. They are red today because that list does not exist.
 */

test('one list names the capabilities, and the fallback is derived from it', () => {
  assert.equal(new Set(CAPABILITY_KEYS).size, CAPABILITY_KEYS.length, 'the list names each capability once');
  assert.deepEqual(Object.keys(NO_CAPABILITIES).sort(), [...CAPABILITY_KEYS].sort(), 'the fallback covers exactly the list');
  for (const key of CAPABILITY_KEYS) {
    assert.equal(NO_CAPABILITIES[key], false, `${key}: nothing is known before a source declares it, so it is not offered`);
  }
});

test('every source declares every capability, so a new one cannot be forgotten in one adapter', () => {
  const h = harness();
  try {
    for (const account of ['whatsapp', 'personal', 'business', 'imessage', 'linkedin'] as const) {
      const declared = h.registry[account].capabilities();
      for (const key of CAPABILITY_KEYS) {
        assert.equal(typeof declared[key], 'boolean', `${account} declares ${key}`);
      }
      const undeclared = Object.keys(declared).filter(key => !CAPABILITY_KEYS.includes(key as never) && key !== 'search');
      assert.deepEqual(undeclared, [], `${account} declares nothing outside the list`);
    }
  } finally {
    h.close();
  }
});

test('the gateway validates declarations with the same list', () => {
  assert.equal(capabilitiesSchema.safeParse(NO_CAPABILITIES).success, true, 'a declaration the UI can build is one the gateway accepts');

  const missing = { ...NO_CAPABILITIES } as Record<string, boolean>;
  delete missing[CAPABILITY_KEYS[0]];
  assert.equal(capabilitiesSchema.safeParse(missing).success, false, 'a declaration missing a capability is refused');

  const invented = { ...NO_CAPABILITIES, telepathy: true };
  assert.equal(capabilitiesSchema.safeParse(invented).success, false, 'a capability the list does not name is refused');
});
