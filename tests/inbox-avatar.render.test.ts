// A row's picture, drawn. The face path had no test at either end — the address book was asked, the
// URL was stored, and nothing checked that a list row turns it into an image — so "I don't see the
// avatars" could not be answered from the code. These three rows answer it.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';

const require = createRequire(import.meta.url);

import { loadComponent } from './jsdom-harness.ts';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost', pretendToBeVisual: true });

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

install(dom);

const DECLARED = {
  'gmail-personal': { label: 'Personal Gmail', icon: 'Mail', pollIntervalMs: 45_000, pageSize: 10 },
  'gmail-business': { label: 'Inhouse Gmail', icon: 'Mail', pollIntervalMs: 45_000, pageSize: 10 },
  whatsapp: { label: 'WhatsApp', icon: 'MessageCircle', pollIntervalMs: 8_000, pageSize: 50 },
  imessage: { label: 'Messages', icon: 'MessageCircle', pollIntervalMs: 8_000, pageSize: 20 },
  linkedin: { label: 'LinkedIn', icon: 'MessageCircle', pollIntervalMs: 45_000, pageSize: 20 },
};

/** The shape Google answered for the owner's own contact photo: host admitted, path `/cm/`. */
const GOOGLE_FACE = 'https://lh3.googleusercontent.com/cm/AGPWSu-buzqe2KdW3KWTTUllwA_JUPmZ9foO';
const GROUP_FACE = 'https://pps.whatsapp.net/v/t61.24694-24/47123456_789012345678901_1234567890123456789_n.jpg';

const ROWS = [
  { account: 'gmail-personal', id: 'thread-face', title: 'Unified inbox: HTTPS transport', preview: 'the row that has a photo', date: 1_700_000_300_000, unread: false, sender: 'Robert Sinke', avatarUrl: GOOGLE_FACE },
  { account: 'gmail-personal', id: 'thread-initials', title: 'Build finished', preview: 'from a machine, which has no face', date: 1_700_000_200_000, unread: false, sender: 'GitHub' },
  { account: 'whatsapp', id: '120363000000000002@g.us', title: 'Club', preview: 'a group with a picture', date: 1_700_000_100_000, unread: false, participants: ['Bea Stone', 'Louisa', 'Max'], avatarUrl: GROUP_FACE },
];

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
  return { stub };
}

function rpcAnswer(name: string): unknown {
  if (name === 'capabilities') return Object.fromEntries(Object.keys(DECLARED).map(account => [account, { send: true, markRead: true, archive: false, invitations: false, media: true, attachments: true, threads: true, followsList: true }]));
  if (name === 'sources') return DECLARED;
  if (name === 'cached') return { items: ROWS };
  if (name === 'search') return { ids: [], items: [], truncated: false };
  if (name === 'sync') return { items: [], updatedAt: 0 };
  if (name === 'cached_open' || name === 'open') return { messages: [] };
  return null;
}

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test('a row with a face draws it, and a row without one draws initials rather than a broken image', async () => {
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

    const rows = [...host.querySelectorAll('.ui-row')];
    assert.equal(rows.length, 3, 'all three conversations are drawn');

    const pictureIn = (index: number) => rows[index].querySelector('img.ui-avatar-photo') as HTMLImageElement | null;

    // The Gmail row whose sender has a Google photo: an image, pointing at the URL the plugin stored.
    assert.equal(pictureIn(0)?.getAttribute('src'), GOOGLE_FACE, 'the Gmail face is drawn from the row, not replaced by initials');
    assert.equal(pictureIn(0)?.getAttribute('referrerpolicy') ?? pictureIn(0)?.referrerPolicy, 'no-referrer', 'the image is fetched without a referrer');

    // A sender with no photo keeps its initials and asks the browser for nothing.
    assert.equal(pictureIn(1), null, 'a row with no face draws no image');
    assert.ok(rows[1].querySelector('.ui-avatar-photo') === null);
    assert.ok((rows[1].textContent ?? '').includes('G'), 'the initials are still there');

    // A group with a picture draws the picture, not the four-cell mosaic it used to fall back to.
    assert.equal(pictureIn(2)?.getAttribute('src'), GROUP_FACE, 'a group picture replaces the mosaic');
    assert.equal(rows[2].querySelectorAll('.ui-avatar-cell').length, 0, 'and the mosaic is not drawn beside it');
  } finally {
    flushSync(() => root.unmount());
    host.remove();
  }
});
