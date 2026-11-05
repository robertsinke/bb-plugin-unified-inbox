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
  linkedin: { label: 'LinkedIn', icon: 'MessageCircle', pollIntervalMs: 45_000 },
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
    slots: { experimental_tab: (config: { component: unknown }) => { panel = config.component; } },
  };
  const stub = {
    definePluginApp: (define: (app: unknown) => void) => { define(app); return panel; },
    experimental_Icon: () => null,
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

test('a hit the list never loaded is drawn with its own title, and the footnote names each declared page', async () => {
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

    // Nothing loaded yet: the list is empty, and the footnote already says what each source loads.
    assert.deepEqual([...host.querySelectorAll('.ui-row-name')].map(row => row.textContent), []);
    const footnote = host.querySelector('.ui-footnote')?.textContent ?? '';
    for (const [size, label] of [['10', 'Personal Gmail'], ['10', 'Inhouse Gmail'], ['50', 'WhatsApp'], ['20', 'Messages']]) {
      assert.ok(footnote.includes(`${size} ${label}`), `the footnote says ${label} loads ${size}: ${footnote}`);
    }
    assert.ok(!footnote.includes('LinkedIn'), 'a source that declares no page promises none');

    // Type a query; the panel searches once the typing pauses, on its own heartbeat.
    const search = host.querySelector('.ui-search');
    assert.ok(search, 'the panel draws its search box');
    flushSync(() => type(search, 'lighthouse'));
    await wait(1_400);
    flushSync(() => {});

    const rows = [...host.querySelectorAll('.ui-row')];
    assert.equal(rows.length, 1, 'the hit is a row on screen');
    assert.equal(host.querySelector('.ui-row-name')?.textContent, 'Grace Hopper', 'drawn with the title the hit carried, not a placeholder');
    assert.equal(host.querySelector('.ui-row-snippet')?.textContent, 'the lighthouse keeper wrote back');
    assert.ok(host.querySelector('.ui-row-open-hit'), 'and it can be opened');
  } finally {
    flushSync(() => root.unmount());
    host.remove();
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
