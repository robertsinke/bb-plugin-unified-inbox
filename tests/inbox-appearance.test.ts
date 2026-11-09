import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { accounts } from '../src/adapters/types.ts';
import { BUBBLE_BASE, bubbleClass, sourceClass } from '../src/inbox-appearance.ts';

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

test('a renamed Gmail mailbox keeps the accent of its legacy id', () => {
  assert.equal(bubbleClass('robertsinke.jr@gmail.com'), 'ui-bubble is-gmail-personal');
  assert.equal(bubbleClass('robert@inhouse.works'), 'ui-bubble is-gmail-business');
  assert.equal(sourceClass('robertsinke.jr@gmail.com'), 'ui-gmail-personal');
  assert.equal(sourceClass('robert@inhouse.works'), 'ui-gmail-business');
  assert.equal(bubbleClass('Ada@Example.com'), 'ui-bubble is-Ada@Example.com', 'an unknown mailbox is left unchanged');
});

test('the avatar takes that accent token, not the raw account id', () => {
  assert.ok(app.includes('sourceClass('), 'the row mark is colored from the accent token');
  assert.equal(app.includes('ui-${account}'), false, 'a mailbox address is not a CSS class the color rules can match');
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
