// The pairing card, rendered: what a stranger sees the first time they open WhatsApp in the panel.
//
// Everything asserted here is a promise the plan made about that first screen — the exposure note is
// real text *above* any code, an unpaired source is a card rather than an error, and a logged-out
// device offers a re-pair rather than a retry — so this test draws the card, not the session.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';

import { loadComponent } from './jsdom-harness.ts';

const require = createRequire(import.meta.url);

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost' });
install(dom);

const { WhatsAppPairingCard, EXPOSURE_NOTE } = loadComponent('src/whatsapp-pairing.tsx');
const { flushSync } = require('react-dom');

const QR = '2@abcdefghijklmnop,0123456789abcdef+QR+payload==';

type Answer = { state: string; qr?: string; expiresAt?: number; code?: string; message?: string };

function render(pairing: Answer, actions: { onPair?: () => void; onCode?: (phone: string) => void; onRePair?: () => void } = {}) {
  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const host = dom.window.document.createElement('div');
  dom.window.document.body.append(host);
  const root = createRoot(host);
  flushSync(() => root.render(React.createElement(WhatsAppPairingCard, {
    pairing,
    busy: false,
    onPair: actions.onPair ?? (() => {}),
    onCode: actions.onCode ?? (() => {}),
    onRePair: actions.onRePair ?? (() => {}),
  })));
  return {
    host,
    text: (selector: string) => host.querySelector(selector)?.textContent ?? null,
    node: (selector: string) => host.querySelector(selector),
    buttons: () => [...host.querySelectorAll('button')].map(button => button.textContent ?? ''),
    unmount() {
      flushSync(() => root.unmount());
      host.remove();
    },
  };
}

test('the three exposure sentences are in the DOM before any code is drawn', () => {
  const card = render({ state: 'qr', qr: QR, expiresAt: 1 });
  try {
    const note = card.node('.ui-pairing-note');
    const code = card.node('svg.ui-qr');
    assert.ok(note, 'the note is a paragraph the owner reads, not a title attribute');
    assert.equal(note!.textContent, EXPOSURE_NOTE);
    assert.equal(EXPOSURE_NOTE.split('. ').length, 3, 'and it is three sentences');
    assert.ok(code, 'the code is drawn');
    // The order in the document is the order of reading: nothing is scanned before it is explained.
    assert.equal(note!.compareDocumentPosition(code!) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING, dom.window.Node.DOCUMENT_POSITION_FOLLOWING, 'the note precedes the code');
  } finally {
    card.unmount();
  }
});

test('an unpaired source is a card with one way in, and no error to read', () => {
  const asked: string[] = [];
  const card = render({ state: 'unpaired' }, { onPair: () => asked.push('pair') });
  try {
    assert.equal(card.text('.ui-pairing-state'), 'WhatsApp is not linked on this machine yet.');
    assert.equal(card.node('[role="alert"]'), null, 'unpaired is a state, so nothing is an alert');
    assert.deepEqual(card.buttons(), ['Show the QR code'], 'the QR is the default path and the only action offered');
    card.node('.ui-pairing button')!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    assert.deepEqual(asked, ['pair']);
  } finally {
    card.unmount();
  }
});

test('a QR state draws the code, says how long it lives, and offers the phone fallback', () => {
  const card = render({ state: 'qr', qr: QR, expiresAt: 1 });
  try {
    assert.match(card.text('.ui-pairing-hint') ?? '', /changes every twenty seconds/);
    assert.deepEqual(card.buttons(), ['Use a phone number instead'], 'the code is the fallback, so it is not the first button');
  } finally {
    card.unmount();
  }
});

test('a requested code is shown instead of a QR, in characters the phone can be typed from', () => {
  const card = render({ state: 'code', code: 'ABCD-1234' });
  try {
    assert.equal(card.text('.ui-pairing-code'), 'ABCD-1234');
    assert.equal(card.node('svg.ui-qr'), null, 'the code replaces the QR rather than sitting beside it');
    assert.deepEqual(card.buttons(), ['Show the QR code instead']);
  } finally {
    card.unmount();
  }
});

test('a logged-out device offers a re-pair, and nothing that reads as a retry', () => {
  const asked: string[] = [];
  const card = render({ state: 'logged-out' }, { onRePair: () => asked.push('re-pair') });
  try {
    assert.match(card.text('.ui-pairing-state') ?? '', /no longer linked/);
    assert.deepEqual(card.buttons(), ['Pair again'], 'one deliberate act, not a retry loop');
    card.node('.ui-pairing button')!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    assert.deepEqual(asked, ['re-pair']);
  } finally {
    card.unmount();
  }
});

test('what the socket said is drawn as a status line, and a connected source draws nothing at all', () => {
  const reported = render({ state: 'connecting', message: 'Pairing code request failed: nope' });
  try {
    assert.equal(reported.text('.ui-pairing-message'), 'Pairing code request failed: nope');
  } finally {
    reported.unmount();
  }
  const connected = render({ state: 'connected' });
  try {
    assert.equal(connected.node('.ui-pairing'), null, 'a paired source has nothing to pair');
  } finally {
    connected.unmount();
  }
});

/** jsdom owns the globals React reads. Installed once, kept for the whole file. */
function install(page: JSDOM): void {
  const keys = ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'MouseEvent'] as const;
  // `navigator` is a getter on the Node global, so globals are defined rather than assigned.
  const define = (key: string, value: unknown) => Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  define('window', page.window);
  define('document', page.window.document);
  for (const key of keys) {
    const value = (page.window as any)[key];
    if (value !== undefined) define(key, value);
  }
}
