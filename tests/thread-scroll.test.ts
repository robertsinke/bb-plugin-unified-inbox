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

test('the reaction bar is not hung off the side of the bubble, and it shows on hover', () => {
  const css = readFileSync('chat.css', 'utf8');
  assert.doesNotMatch(css, /\.ui-chat-(incoming|outgoing) \.ui-bubble-actions\{/);
  const bar = rule('chat.css', '.ui-bubble-actions');
  assert.match(bar, /position:\s*absolute/);
  assert.doesNotMatch(bar, /left:\s*100%/);
  assert.doesNotMatch(bar, /right:\s*100%/);
  const shown = rule('chat.css', '.ui-bubble:hover>.ui-bubble-actions,.ui-bubble-actions.is-open,.ui-bubble-actions:has(:focus-visible)');
  assert.match(shown, /opacity:\s*1/);
});
