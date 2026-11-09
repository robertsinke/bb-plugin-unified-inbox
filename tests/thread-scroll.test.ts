// The open conversation scrolls down the page. It must not scroll sideways.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';

function rule(file: string, selector: string): string {
  const css = readFileSync(file, 'utf8');
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escaped}\\{([^}]*)\\}`));
  assert.ok(match, `${selector} is a rule in ${file}`);
  return match[1];
}

test('the thread pane scrolls down and does not scroll sideways', () => {
  const scroll = rule('layout.css', '.ui-thread-scroll');
  assert.match(scroll, /overflow-y:\s*auto/);
  assert.match(scroll, /overflow-x:\s*clip/);
});

test('a photo in a mail thread stays within the column', () => {
  const media = rule('inbox.css', '.ui-message-media');
  assert.match(media, /max-width:\s*min\(340px,\s*100%\)/);
});

test('a closed reply bar on your own message stays inside the bubble', () => {
  const closed = rule('chat.css', '.ui-chat-outgoing .ui-bubble-actions:not(.is-open)');
  assert.match(closed, /left:\s*auto/);
  assert.match(closed, /right:\s*8px/);
});
