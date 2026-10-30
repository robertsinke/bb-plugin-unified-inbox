import assert from 'node:assert/strict';
import test from 'node:test';
import { linkedinPageScript, linkedinRunOutput } from '../src/linkedin-page.ts';

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (...args: string[]) => Function;

test('LinkedIn in-page scripts compile after template-string escaping', () => {
  for (const mode of [{ mode: 'list' }, { mode: 'thread', id: 'urn:li:msg_conversation:test' }] as const) {
    assert.doesNotThrow(() => new AsyncFunction('browser', linkedinPageScript(mode)));
  }
});

test('LinkedIn run output accepts direct successful JSON and wrapped runtime output', () => {
  const result = { ok: true, payload: { conversations: [], invitations: [] } };
  assert.deepEqual(linkedinRunOutput(JSON.stringify(result)), result);
  assert.deepEqual(linkedinRunOutput(JSON.stringify({ text: JSON.stringify(result), exitCode: 0 })), result);
});
