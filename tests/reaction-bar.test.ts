import assert from 'node:assert/strict';
import test from 'node:test';
import { reactionBarPosition } from '../src/reaction-bar.ts';

const view = { top: 100, right: 400, bottom: 500, left: 40 };
const bar = { width: 160, height: 30 };

test('the bar sits on the top edge of a bubble that has room above it', () => {
  const bubble = { top: 200, right: 280, bottom: 260, left: 60 };
  const place = reactionBarPosition({ bubble, view, bar });
  assert.equal(place.top, -22);
  assert.equal(bubble.top + place.top, 178);
  assert.equal(bubble.top + place.top + bar.height, 208);
  assert.ok(bubble.left + place.left >= view.left);
  assert.ok(bubble.left + place.left + bar.width <= view.right);
});

test('a bubble at the top of the pane keeps the whole bar inside the pane', () => {
  const bubble = { top: 104, right: 280, bottom: 180, left: 60 };
  const place = reactionBarPosition({ bubble, view, bar });
  const top = bubble.top + place.top;
  const left = bubble.left + place.left;
  assert.ok(top >= view.top + 4);
  assert.ok(top + bar.height <= view.bottom - 4);
  assert.ok(left >= view.left + 4);
  assert.ok(left + bar.width <= view.right - 4);
});

test('a bubble against the right edge keeps the bar inside the pane', () => {
  const bubble = { top: 200, right: 396, bottom: 260, left: 300 };
  const place = reactionBarPosition({ bubble, view, bar });
  const left = bubble.left + place.left;
  assert.equal(left + bar.width, view.right - 4);
  assert.ok(left >= view.left + 4);
});

test('a bubble against the left edge keeps the bar inside the pane', () => {
  const bubble = { top: 200, right: 120, bottom: 260, left: 44 };
  const place = reactionBarPosition({ bubble, view, bar });
  const left = bubble.left + place.left;
  assert.equal(left, view.left + 4);
  assert.ok(left + bar.width <= view.right - 4);
});
