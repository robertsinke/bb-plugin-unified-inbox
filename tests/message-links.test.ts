import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { focusedBrowserId, messageParts, panelStateFocusedOn, tabsAfterLink } from '../src/message-links.ts';

test('message text keeps surrounding words and drops trailing punctuation from links', () => {
  assert.deepEqual(messageParts('See https://example.com/a.'), [
    { kind: 'text', value: 'See ' },
    { kind: 'link', value: 'https://example.com/a' },
    { kind: 'text', value: '.' },
  ]);
});

test('a parenthesised url keeps its own closing parenthesis', () => {
  const parts = messageParts('Wiki https://en.wikipedia.org/wiki/BM25_(algorithm).');
  assert.equal(parts.find(part => part.kind === 'link')?.value, 'https://en.wikipedia.org/wiki/BM25_(algorithm)');
});

test('opening a link pins the inbox tab and adds one browser tab', () => {
  const once = tabsAfterLink([{ id: 'chat', kind: 'thread-info' }], 'https://example.com', 'browser-1');
  assert.deepEqual(once.map(tab => tab.kind), ['thread-info', 'plugin-fixed', 'browser']);
  assert.equal(once.find(tab => tab.kind === 'plugin-fixed')?.id, 'plugin-fixed:unified-inbox:inbox');
  const twice = tabsAfterLink(once, 'https://example.com', 'browser-2');
  assert.equal(twice.filter(tab => tab.kind === 'browser').length, 1);
  assert.equal(twice.filter(tab => tab.kind === 'plugin-fixed').length, 1);
  assert.equal(focusedBrowserId(twice, 'https://example.com', 'browser-2'), 'browser-1');
});

test('focusing a link selects that browser tab and opens the panel', () => {
  const focused = panelStateFocusedOn(JSON.stringify({ version: 1, secondary: { tabs: [{ id: 'chat', kind: 'thread-info' }], activeTabId: 'chat', isOpen: false }, lastUsedAt: 1 }), 'browser:abc:none', 'https://example.com', 20);
  assert.equal(focused.secondary.activeTabId, 'browser:abc:none');
  assert.equal(focused.secondary.isOpen, true);
  assert.equal(focused.secondary.tabs.length, 2);
  assert.equal(focused.lastUsedAt, 20);
});
