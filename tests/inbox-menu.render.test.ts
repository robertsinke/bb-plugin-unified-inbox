// The inbox's filter is no longer a control of its own: it is a group inside the one ⋯ menu the
// header already had. This render pins the three things folding could break — the five entries are
// there in order, choosing one asks the session for that filter, and the trigger still says what
// the list is narrowed to, in its name and in its dot.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';

const require = createRequire(import.meta.url);

import { loadComponent } from './jsdom-harness.ts';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost' });
install(dom);

const { flushSync } = require('react-dom');

const DECLARED = {
  'gmail-personal': { label: 'Personal Gmail', icon: 'Mail', pollIntervalMs: 45_000 },
  'gmail-business': { label: 'Inhouse Gmail', icon: 'Mail', pollIntervalMs: 45_000 },
  whatsapp: { label: 'WhatsApp', icon: 'MessageCircle', pollIntervalMs: 8_000 },
  imessage: { label: 'Messages', icon: 'MessageCircle', pollIntervalMs: 8_000 },
  linkedin: { label: 'LinkedIn', icon: 'MessageCircle', pollIntervalMs: 45_000 },
};

function mount({
  filter = 'all',
  extra = '',
  sources = DECLARED as Record<string, unknown> | null,
} = {}) {
  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { ItemMenu, filterActions, menuTrigger } = loadComponent('src/inbox-menu.tsx', {
    '@get-bb/plugin-sdk/app': { experimental_Icon: () => null },
  });

  const chosen: string[] = [];
  const trigger = menuTrigger(sources, filter, extra);
  const element = React.createElement(ItemMenu, {
    label: trigger.label,
    marker: trigger.marker,
    group: { heading: 'Filter', actions: filterActions({ filter, onFilter: (next: string) => chosen.push(next), sources, sourceIcon: () => null }) },
    actions: [
      { label: 'New', run: () => chosen.push('new') },
      { label: 'Refresh', run: () => chosen.push('refresh') },
    ],
  });
  const host = dom.window.document.createElement('div');
  dom.window.document.body.append(host);
  const root = createRoot(host);
  flushSync(() => root.render(element));
  const document = dom.window.document;
  const done = () => {
    flushSync(() => root.unmount());
    host.remove();
  };
  return { document, chosen, trigger, done };
}

const entries = (document: Document) => [...document.querySelectorAll('[role="menuitem"]')].map(entry => entry.textContent?.trim());
const click = (document: Document, element: any) => element.dispatchEvent(new (document.defaultView as any).MouseEvent('click', { bubbles: true }));

test('the filter is the menu’s first group: the sources, the attention labels, then the actions', () => {
  const { document, done } = mount();
  try {
    assert.deepEqual(entries(document), ['All', 'Unread', 'Needed', 'None', 'Unclear', 'WhatsApp', 'Personal Gmail', 'Inhouse Gmail', 'Messages', 'LinkedIn', 'New', 'Refresh'], 'the filter entries lead, then the actions, in one list');
    const menu = document.querySelector('[role="menu"]')!;
    assert.deepEqual([...menu.children].map(child => child.className || child.getAttribute('role') || child.tagName), ['ui-menu-group', 'ui-menu-sep', 'ui-menu-item', 'ui-menu-item'], 'a group the owner can tell apart from the actions below it');
    assert.equal(menu.querySelector('[role="group"]')?.getAttribute('aria-label'), 'Filter');
  } finally { done(); }
});

test('choosing an entry asks the session for that filter, and only that entry reads as the choice', () => {
  const { document, chosen, done } = mount({ filter: 'unread' });
  try {
    const items = [...document.querySelectorAll('[role="menuitem"]')] as any[];
    assert.deepEqual(items.filter(item => item.getAttribute('aria-pressed') === 'true').map((item: any) => item.textContent?.trim()), ['Unread'], 'the active filter is the only entry marked pressed');
    click(document, items.find(item => item.textContent?.trim() === 'LinkedIn'));
    click(document, items.find(item => item.textContent?.trim() === 'Refresh'));
    assert.deepEqual(chosen, ['linkedin', 'refresh'], 'a filter entry narrows the list; an action still acts');
  } finally { done(); }
});

test('the trigger says what the list is narrowed to, and carries it as a dot', () => {
  const all = mount();
  try {
    assert.equal(all.trigger.label, 'this inbox', 'the menu is named for the inbox, not for one action');
    assert.equal(all.trigger.marker, undefined, 'nothing is narrowed, so nothing stands out');
    assert.equal(all.document.querySelector('.ui-menu-marker'), null);
    assert.equal(all.document.querySelector('[aria-haspopup="menu"]')?.getAttribute('aria-label'), 'More actions for this inbox');
  } finally { all.done(); }

  const narrowed = mount({ filter: 'gmail-business' });
  try {
    assert.equal(narrowed.trigger.label, 'this inbox, filtered to Inhouse Gmail', 'the accessible name still carries the filter');
    assert.equal(narrowed.trigger.marker, 'filtered to Inhouse Gmail');
    assert.ok(narrowed.document.querySelector('.ui-menu-marker'), 'the trigger shows a dot without being opened');
    assert.equal(narrowed.document.querySelector('[aria-haspopup="menu"]')?.getAttribute('title'), 'filtered to Inhouse Gmail');
  } finally { narrowed.done(); }
});

test('a standing problem keeps its dot, and shares the sentence with the filter', () => {
  const { trigger, done } = mount({ filter: 'unread', extra: 'Some messages couldn’t load: WhatsApp could not refresh.' });
  try {
    assert.equal(trigger.marker, 'filtered to unread · Some messages couldn’t load: WhatsApp could not refresh.', 'one dot, and it says both things');
  } finally { done(); }

  const unknown = mount({ filter: 'all', sources: null });
  try {
    assert.equal(unknown.trigger.marker, undefined, 'a source that never declared itself adds nothing');
  } finally { unknown.done(); }
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
