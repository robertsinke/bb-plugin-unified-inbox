import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { accounts } from '../src/adapters/types.ts';
import { BUBBLE_BASE, bubbleClass } from '../src/inbox-appearance.ts';

const css = readFileSync(new URL('../chat.css', import.meta.url), 'utf8');
const app = readFileSync(new URL('../app.tsx', import.meta.url), 'utf8');

test('every source draws the one bubble base, and only the accent differs', () => {
  const classes = accounts.map(bubbleClass);
  assert.deepEqual(classes, [
    'ui-bubble is-gmail-personal',
    'ui-bubble is-gmail-business',
    'ui-bubble is-whatsapp',
    'ui-bubble is-imessage',
    'ui-bubble is-linkedin',
  ], 'the same message from any source shares the base; only the accent token moves');
  for (const one of classes) assert.equal(one.split(' ')[0], BUBBLE_BASE);
  assert.equal(new Set(classes).size, accounts.length, 'no two sources share an accent');
});

test('each accent a bubble can carry is a rule that exists', () => {
  for (const account of accounts) {
    assert.ok(
      css.includes(`.ui-bubble.is-${account}{`),
      `${account} would draw an unaccented bubble: no .ui-bubble.is-${account} rule in chat.css`,
    );
  }
});

test('the components cannot draw a bubble outside that base', () => {
  assert.ok(app.includes('bubbleClass('), 'the panel names its bubbles through the one helper');
  assert.equal(
    app.includes('"ui-bubble"') || app.includes("'ui-bubble'"),
    false,
    'a hardcoded bubble class is how one source drifts into its own bubble language',
  );
});
