// The share card, as the bubble declares it. `app.tsx` is one file, so the contract is read
// from the source: a share draws a card, a link with no card still draws the open control, and
// the picture is asked for as LinkedIn media rather than as a second photo button.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const app = readFileSync(new URL('../app.tsx', import.meta.url), 'utf8');

function component(name: string): string {
  const start = app.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} is declared in app.tsx`);
  const next = app.indexOf('\nfunction ', start + 1);
  return app.slice(start, next === -1 ? undefined : next);
}

test('a bubble draws a share card and does not leave a link-only message empty', () => {
  const bubble = component('ChatBubble');
  assert.match(bubble, /<ShareCard /, 'a share or a link is a card inside the bubble');
  assert.match(bubble, /!m\.media \? <ShareCard /, 'a picture message keeps its own control');
  const card = component('ShareCard');
  assert.match(card, /Open shared post/, 'a link with no words and no picture still has the open control');
  assert.match(card, /onOpenLink\(link\)/, 'the card opens the activity link');
  assert.match(card, /account: 'linkedin'/, 'the picture is a LinkedIn media read');
  assert.match(card, /ui-share-text/, 'the post words are in the card');
});

test('a text bubble does not grow a card of its own', () => {
  const bubble = component('ChatBubble');
  const cardAt = bubble.indexOf('<ShareCard ');
  const guard = bubble.lastIndexOf('(m.share || m.link)', cardAt);
  assert.ok(guard >= 0 && guard < cardAt, 'the card is behind the share-or-link check');
});
