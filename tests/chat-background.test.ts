import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';

test('the chat container has no card background', () => {
  const css = readFileSync('chat.css', 'utf8');
  const rule = css.match(/\.ui-chat\{([^}]*)\}/)?.[1];
  assert.ok(rule);
  assert.doesNotMatch(rule, /background\s*:/);
});
