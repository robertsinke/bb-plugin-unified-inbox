// The list as the owner sees it: a search draws the conversation it matched, and the footnote says
// what each source declares. Both were panel-side lies — the list dropped a hit it had never loaded,
// and the sentence named a page size no source had declared since Gmail moved to ten.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';

const require = createRequire(import.meta.url);

import { loadComponent } from './jsdom-harness.ts';
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost', pretendToBeVisual: true });
install(dom);

const DECLARED = {
  'gmail-personal': { label: 'Personal Gmail', icon: 'Mail', pollIntervalMs: 45_000, pageSize: 10 },
  'gmail-business': { label: 'Inhouse Gmail', icon: 'Mail', pollIntervalMs: 45_000, pageSize: 10 },
  whatsapp: { label: 'WhatsApp', icon: 'MessageCircle', pollIntervalMs: 8_000, pageSize: 50 },
  imessage: { label: 'Messages', icon: 'MessageCircle', pollIntervalMs: 8_000, pageSize: 20 },
  linkedin: { label: 'LinkedIn', icon: 'MessageCircle', pollIntervalMs: 45_000, pageSize: 20 },
};

/** A hit for a conversation the list never loaded: it exists only in the store's own corpus. */
const HIT = { account: 'whatsapp', id: '15559999999@s.whatsapp.net', title: 'Grace Hopper', preview: 'the lighthouse keeper wrote back', date: 1_700_000_000_000, unread: false };

/**
 * The plugin SDK, reduced to what the panel asks of it: `definePluginApp` hands back the component
 * the tab slot would have drawn, and the hooks answer with the fakes below.
 */
function sdk(rpc: (method: string, ...args: unknown[]) => Promise<any>) {
  let panel: any = null;
  const app = {
    slots: { experimental_tab: (config: { component: unknown }) => { panel = config.component; }, settingsSection: () => {} },
  };
  const stub = {
    definePluginApp: (define: (app: unknown) => void) => { define(app); return panel; },
    experimental_Icon: () => null,
    experimental_useAppPanel: () => ({ openTab() {} }),
    ThreadChat: () => null,
    useRpc: () => ({ call: rpc }),
    useSdk: () => ({ threads: { tabs: { get: async () => ({ tabs: [], revision: 1 }), update: async () => ({ tabs: [], revision: 2 }) } } }),
    useBbNavigate: () => ({ openUrl: () => {}, toThread: () => {} }),
    useComposers: () => [],
  };
  return { stub, panel: () => panel };
}

function rpcAnswer(name: string): unknown {
  if (name === 'capabilities') return Object.fromEntries(Object.keys(DECLARED).map(account => [account, { send: true, markRead: true, archive: false, invitations: false, media: true, attachments: true, threads: true, followsList: true }]));
  if (name === 'sources') return DECLARED;
  if (name === 'cached') return { items: [] };
  if (name === 'search') return { ids: [{ account: HIT.account, id: HIT.id, score: 2 }], items: [HIT], truncated: false };
  if (name === 'sync') return { items: [], updatedAt: 0 };
  if (name === 'cached_open' || name === 'open') return { messages: [] };
  return null;
}

/** React reads its own value tracker, so a value the browser would set is set the way it does. */
function type(input: any, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
}

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test('a hit the list never loaded is drawn with its own title', async () => {
  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { flushSync } = require('react-dom');
  const { stub } = sdk(async (name: string) => rpcAnswer(name));
  const Inbox = loadComponent('app.tsx', { '@get-bb/plugin-sdk/app': stub }).default;

  const host = dom.window.document.createElement('div');
  dom.window.document.body.append(host);
  const root = createRoot(host);
  try {
    flushSync(() => root.render(React.createElement(Inbox, { threadId: null })));
    await wait(50);

    assert.deepEqual([...host.querySelectorAll('.ui-row-name')].map(row => row.textContent), []);
    assert.equal(host.querySelector('.ui-footnote'), null);
    assert.equal(host.querySelector('.ui-more'), null);

    // Type a query; the panel searches once the typing pauses, on its own heartbeat.
    const search = host.querySelector('.ui-search');
    assert.ok(search, 'the panel draws its search box');
    flushSync(() => type(search, 'lighthouse'));
    await wait(1_400);
    flushSync(() => {});

    const rows = [...host.querySelectorAll('.ui-row')];
    assert.equal(rows.length, 1, 'the hit is a row on screen');
    assert.equal(host.querySelector('.ui-row-name')?.textContent, 'Grace Hopper', 'drawn with the title the hit carried, not a placeholder');
    assert.equal(host.querySelector('.ui-row-body')?.textContent, 'the lighthouse keeper wrote back');
    assert.ok(host.querySelector('.ui-row-open-hit'), 'and it can be opened');
  } finally {
    flushSync(() => root.unmount());
    host.remove();
  }
});

const SETTINGS_COPY = 'Open BB Settings for Unified Inbox to connect an account.';
const WHATSAPP_SETTINGS_COPY = 'Open BB Settings for Unified Inbox to connect WhatsApp.';

const MAIL_ROW = { account: 'gmail-personal', id: 't1', title: 'Plan', sender: 'Ada Lovelace', preview: 'The plan', date: 1_700_000_000_000, unread: false };

function mountInbox(answer: (name: string) => unknown) {
  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { flushSync } = require('react-dom');
  const calls: { name: string; input: unknown }[] = [];
  const { stub } = sdk(async (name: string, input?: unknown) => {
    calls.push({ name, input });
    return answer(name);
  });
  const Inbox = loadComponent('app.tsx', { '@get-bb/plugin-sdk/app': stub }).default;
  const host = dom.window.document.createElement('div');
  dom.window.document.body.append(host);
  const root = createRoot(host);
  flushSync(() => root.render(React.createElement(Inbox, { threadId: null })));
  return {
    host,
    calls,
    flush: () => flushSync(() => {}),
    done: () => { flushSync(() => root.unmount()); host.remove(); },
  };
}

test('an inbox with no rows and no source error names BB Settings and this plugin', async () => {
  const view = mountInbox(name => {
    if (name === 'sources' || name === 'capabilities') return {};
    if (name === 'cached') return { items: [] };
    if (name === 'sync') return { items: [], updatedAt: 0 };
    return null;
  });
  try {
    await wait(50);
    view.flush();
    assert.equal(view.host.querySelector('.ui-empty')?.textContent, SETTINGS_COPY);
    assert.equal(view.host.querySelector('.ui-pairing'), null);
    assert.equal(view.host.querySelector('svg.ui-qr'), null);
    assert.equal(view.host.querySelector('a'), null, 'the sentence does not deep-link');
    assert.equal(view.calls.some(call => call.name === 'whatsapp_pairing' && call.input !== null), false);
  } finally {
    view.done();
  }
});

test('rows stay on screen when WhatsApp is unpaired, with the settings sentence and no QR', async () => {
  const view = mountInbox(name => {
    if (name === 'capabilities') return rpcAnswer('capabilities');
    if (name === 'sources') return rpcAnswer('sources');
    if (name === 'cached') return { items: [MAIL_ROW] };
    if (name === 'sync') return { items: [], updatedAt: 0 };
    if (name === 'whatsapp_pairing') return { state: 'unpaired', qr: '2@must-not-render', expiresAt: 99_000 };
    return rpcAnswer(name);
  });
  try {
    await wait(50);
    view.flush();
    assert.equal(view.host.querySelector('.ui-row-name')?.textContent, 'Ada Lovelace');
    assert.equal(view.host.querySelector('.ui-settings-hint')?.textContent, WHATSAPP_SETTINGS_COPY);
    assert.equal(view.host.querySelector('.ui-pairing'), null);
    assert.equal(view.host.querySelector('svg.ui-qr'), null);
    assert.equal(view.host.textContent?.includes('2@must-not-render'), false);
    const pairing = view.calls.filter(call => call.name === 'whatsapp_pairing');
    assert.deepEqual(pairing.map(call => call.input), [null], 'the inbox reads status once and does not pair');
    const seen = pairing.length;
    await wait(100);
    view.flush();
    assert.equal(view.calls.filter(call => call.name === 'whatsapp_pairing').length, seen, 'that read is not a poll');
  } finally {
    view.done();
  }
});

test('an unread filter with no unread rows keeps the unread sentence', async () => {
  const view = mountInbox(name => {
    if (name === 'cached') return { items: [{ ...MAIL_ROW, unread: false }] };
    return rpcAnswer(name);
  });
  try {
    await wait(50);
    view.flush();
    const unread = [...view.host.querySelectorAll('[role="menuitem"]')].find(item => item.textContent === 'Unread');
    assert.ok(unread, 'the filter lists Unread');
    view.flush();
    unread.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    view.flush();
    assert.equal(view.host.querySelector('.ui-empty')?.textContent, 'No unread messages in this view.');
    assert.equal(view.host.textContent?.includes(SETTINGS_COPY), false);
  } finally {
    view.done();
  }
});

test('a search with no hits keeps the search sentence', async () => {
  const view = mountInbox(name => {
    if (name === 'search') return { ids: [], items: [], truncated: false };
    if (name === 'cached') return { items: [MAIL_ROW] };
    return rpcAnswer(name);
  });
  try {
    await wait(50);
    view.flush();
    const search = view.host.querySelector('.ui-search');
    assert.ok(search);
    view.flush();
    type(search, 'missing');
    await wait(1_400);
    view.flush();
    assert.equal(view.host.querySelector('.ui-empty')?.textContent, 'No conversations match this search.');
    assert.equal(view.host.textContent?.includes(SETTINGS_COPY), false);
  } finally {
    view.done();
  }
});

test('a Gmail refresh failure stays one error line per mailbox', async () => {
  const mailboxes = {
    'ada@example.com': { label: 'ada@example.com', icon: 'Mail', pollIntervalMs: 45_000, pageSize: 10 },
    'grace@example.com': { label: 'grace@example.com', icon: 'Mail', pollIntervalMs: 45_000, pageSize: 10 },
  };
  const failure = (account: string) => ({
    lastAttemptAt: 1,
    lastSuccessAt: null,
    lastError: `gmail ${account} request failed (401)`,
    cacheFallback: true,
  });
  const view = mountInbox(name => {
    if (name === 'sources') return mailboxes;
    if (name === 'capabilities') return {};
    if (name === 'cached') return {
      items: [],
      freshness: {
        'ada@example.com': failure('ada@example.com'),
        'grace@example.com': failure('grace@example.com'),
      },
    };
    return null;
  });
  try {
    await wait(50);
    view.flush();
    const lines = [...view.host.querySelectorAll('.ui-errors p')].map(line => line.textContent);
    assert.equal(lines.length, 2);
    assert.ok(lines.some(line => line?.includes('ada@example.com') && line.includes('401')));
    assert.ok(lines.some(line => line?.includes('grace@example.com') && line.includes('401')));
    assert.equal(view.host.textContent?.includes(SETTINGS_COPY), false);
    assert.equal(view.host.querySelector('.ui-empty')?.textContent, 'No conversations in this view.');
  } finally {
    view.done();
  }
});

/** jsdom owns the globals React reads. Installed once, kept for the whole file. */
function install(page: JSDOM): void {
  const keys = ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'MouseEvent', 'localStorage'] as const;
  // `navigator` is a getter on the Node global, so globals are defined rather than assigned.
  const define = (key: string, value: unknown) => Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  define('window', page.window);
  define('document', page.window.document);
  for (const key of keys) {
    const value = (page.window as any)[key];
    if (value !== undefined) define(key, value);
  }
}
