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

test('the reaction bar sits beside the middle of the bubble and shows on hover', () => {
  const bar = rule('chat.css', '.ui-bubble-actions');
  assert.match(bar, /top:\s*50%/);
  assert.match(bar, /transform:\s*translateY\(-50%\)/);
  assert.doesNotMatch(bar, /left:\s*50%/);
  const incoming = rule('chat.css', '.ui-chat-incoming .ui-bubble-actions');
  assert.match(incoming, /left:\s*100%/);
  const outgoing = rule('chat.css', '.ui-chat-outgoing .ui-bubble-actions');
  assert.match(outgoing, /right:\s*100%/);
  const shown = rule('chat.css', '.ui-bubble:hover>.ui-bubble-actions,.ui-bubble-actions.is-open,.ui-bubble-actions:has(:focus-visible)');
  assert.match(shown, /opacity:\s*1/);
});
