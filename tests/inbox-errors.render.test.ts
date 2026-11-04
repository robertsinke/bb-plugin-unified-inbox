// The panel's failure lines are drawn from the pair the session keeps — the account that owns the
// failure and what it said — not from a name written into the text. This is the render that proves
// it: the same sentence from two sources reads as two different lines, and renaming a source changes
// the line without touching the session.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';

const require = createRequire(import.meta.url);

import { loadComponent } from './jsdom-harness.ts';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost' });
install(dom);

const { InboxErrors } = loadComponent('src/inbox-errors.tsx');
const { flushSync } = require('react-dom');

const DECLARED = {
  'gmail-personal': { label: 'Personal Gmail', icon: 'Mail', pollIntervalMs: 45_000 },
  'gmail-business': { label: 'Inhouse Gmail', icon: 'Mail', pollIntervalMs: 45_000 },
  whatsapp: { label: 'WhatsApp', icon: 'MessageCircle', pollIntervalMs: 8_000 },
  imessage: { label: 'Messages', icon: 'MessageCircle', pollIntervalMs: 8_000 },
  linkedin: { label: 'LinkedIn', icon: 'MessageCircle', pollIntervalMs: 45_000 },
};

function render(errors: readonly Record<string, unknown>[], sources: Record<string, unknown> | null) {
  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const host = dom.window.document.createElement('div');
  dom.window.document.body.append(host);
  const root = createRoot(host);
  flushSync(() => root.render(React.createElement(InboxErrors, { errors, sources })));
  const lines = [...host.querySelectorAll('.ui-errors p')].map(line => line.textContent);
  flushSync(() => root.unmount());
  host.remove();
  return lines;
}

test('a failure line is drawn from the account and the message, not from the text', () => {
  const message = 'could not refresh. the token expired Previously loaded messages may be stale.';
  const lines = render(
    [{ account: 'gmail-personal', kind: 'refresh', message }, { account: 'gmail-business', kind: 'refresh', message }],
    DECLARED,
  );

  assert.deepEqual(lines, [
    'Personal Gmail could not refresh. the token expired Previously loaded messages may be stale.',
    'Inhouse Gmail could not refresh. the token expired Previously loaded messages may be stale.',
  ], 'the same sentence from two sources is two lines, each named by its own source');
});

test('the name in the line is the one the source declares, so renaming it needs no render change', () => {
  const error = [{ account: 'gmail-business', kind: 'refresh', message: 'could not refresh.' }];
  assert.deepEqual(render(error, DECLARED), ['Inhouse Gmail could not refresh.']);

  const renamed = { ...DECLARED, 'gmail-business': { ...DECLARED['gmail-business'], label: 'Work Gmail' } };
  assert.deepEqual(render(error, renamed), ['Work Gmail could not refresh.'], 'the panel holds no copy of the name');
});

test('a cached failure that already names its source is named once, not twice', () => {
  // The cache keeps the sentence the source wrote, and these two open with the source's own name.
  const lines = render([
    { account: 'gmail-business', kind: 'refresh', message: 'Inhouse Gmail unavailable. Check its connection. Previously loaded messages may be stale.' },
    { account: 'linkedin', kind: 'refresh', message: 'LinkedIn did not answer in time. Previously loaded messages may be stale.' },
  ], DECLARED);

  assert.deepEqual(lines, [
    'Inhouse Gmail unavailable. Check its connection. Previously loaded messages may be stale.',
    'LinkedIn did not answer in time. Previously loaded messages may be stale.',
  ]);
});

test('a failure no source owns reads as its own sentence, and nothing renders when nothing failed', () => {
  assert.deepEqual(
    render([{ kind: 'older', message: 'Older conversations could not load in time: nothing answered within 15 seconds.' }], DECLARED),
    ['Older conversations could not load in time: nothing answered within 15 seconds.'],
  );
  assert.deepEqual(render([], DECLARED), []);
});

/** jsdom owns the globals React reads. Installed once, kept for the whole file. */
function install(dom: JSDOM): void {
  const keys = ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'MouseEvent'] as const;
  // `navigator` is a getter on the Node global, so globals are defined rather than assigned.
  const define = (key: string, value: unknown) => Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  define('window', dom.window);
  define('document', dom.window.document);
  for (const key of keys) {
    const value = (dom.window as any)[key];
    if (value !== undefined) define(key, value);
  }
}
