// The one rule both composers obey: a send that worked says nothing, and the notice under the
// composer belongs to the send that failed or whose outcome nobody knows. The draft line a source
// that cannot send leaves behind is not a send result, so it stays.
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

const CHAT = { account: 'whatsapp', id: '31612345678@s.whatsapp.net', title: 'Ada Lovelace', preview: 'The plan', date: 1_700_000_000_000, unread: false };
const INVITE_SOURCE = { account: 'linkedin', id: '2-conversation-key', title: 'Grace Hopper', sender: 'Grace Hopper', preview: 'Hi', date: 1_700_000_000_000, unread: false };

/** The sentence a Gmail send carries when nothing confirmed it left: the panel repeats it verbatim. */
const UNKNOWN = 'Send failed or its outcome is unknown. Check Gmail Sent before trying again.';

function caps(send: Record<string, boolean>) {
  return Object.fromEntries(Object.keys(DECLARED).map(account => [account, { send: send[account] ?? true, markRead: true, archive: false, invitations: false, media: true, attachments: true, threads: true, followsList: true }]));
}

/** The panel asks for one method at a time; the answer is chosen by name, and `action` by its action. */
function rpcAnswer(rows: unknown[], reply: () => Promise<unknown>) {
  return (name: string, input: any): unknown => {
    if (name === 'capabilities') return caps({ linkedin: false });
    if (name === 'sources') return DECLARED;
    if (name === 'cached') return { items: rows };
    if (name === 'cached_open') return { messages: [] };
    if (name === 'open') return { messages: [{ sender: 'Ada Lovelace', text: 'The plan', date: 1_700_000_000_000 }] };
    if (name === 'action') return input?.action === 'reply' ? reply() : { status: 'Done' };
    if (name === 'sync') return { items: [], updatedAt: 0 };
    if (name === 'send_audit') return { rows: [] };
    return null;
  };
}

function sdk(rpc: (method: string, input: unknown) => unknown) {
  let panel: any = null;
  const app = {
    slots: { experimental_tab: (config: { component: unknown }) => { panel = config.component; }, settingsSection: () => {} },
  };
  const stub = {
    definePluginApp: (define: (app: unknown) => void) => { define(app); return panel; },
    experimental_Icon: () => null,
    experimental_useAppPanel: () => ({ openTab() {} }),
    ThreadChat: () => null,
    useRpc: () => ({ call: (method: string, input?: unknown) => Promise.resolve(rpc(method, input)) }),
    useSdk: () => ({ threads: { tabs: { get: async () => ({ tabs: [], revision: 1 }), update: async () => ({ tabs: [], revision: 2 }) } } }),
    useBbNavigate: () => ({ openUrl: () => {}, toThread: () => {} }),
    useComposers: () => [],
  };
  return stub;
}

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function mount(rows: unknown[], reply: () => Promise<unknown>) {
  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { flushSync } = require('react-dom');
  const Inbox = loadComponent('app.tsx', { '@get-bb/plugin-sdk/app': sdk(rpcAnswer(rows, reply)) }).default;
  const host = dom.window.document.createElement('div');
  dom.window.document.body.append(host);
  const root = createRoot(host);
  flushSync(() => root.render(React.createElement(Inbox, { threadId: null })));
  await wait(60);
  return {
    host,
    flush: () => flushSync(() => {}),
    done: () => { flushSync(() => root.unmount()); host.remove(); },
  };
}

/** A row opens the thread it names, the way the owner opens it. */
async function openRow(host: HTMLElement, name: string): Promise<void> {
  const row = [...host.querySelectorAll('.ui-row')].find(element => element.querySelector('.ui-row-name')?.textContent === name);
  assert.ok(row, `${name} is a row on screen`);
  (row!.querySelector('.ui-row-open-hit') as HTMLElement).dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  for (let tries = 0; tries < 100 && !host.querySelector('.ui-chat-composer'); tries += 1) await wait(5);
  assert.ok(host.querySelector('.ui-chat-composer'), `${name}'s reply box is on screen`);
}

/** Type and press Enter, as the owner does: the textarea drives the session's draft. */
async function reply(host: HTMLElement, text: string, flush: () => void): Promise<void> {
  const box = host.querySelector('#ui-reply-text') as any;
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')?.set;
  setter?.call(box, text);
  flush();
  box.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  flush();
  (host.querySelector('.ui-chat-composer') as HTMLElement).dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await wait(60);
  flush();
}

test('a reply that worked leaves nothing under the composer, and a reply that did not keeps its sentence', async () => {
  let answer = async () => ({ status: 'Sent.' });
  const { host, flush, done } = await mount([CHAT], () => answer());
  try {
    await openRow(host, 'Ada Lovelace');

    await reply(host, 'On my way', flush);
    assert.equal(host.querySelector('.ui-notice'), null, 'the send that worked says nothing');
    assert.ok([...host.querySelectorAll('.ui-chat-outgoing')].some(bubble => bubble.textContent?.includes('On my way')), 'and the message is in the thread, where the owner can see it');

    // The same box, the same place: now there is something to say, and it is said once, verbatim.
    answer = async () => { throw new Error(UNKNOWN); };
    await reply(host, 'Second try', flush);
    const notice = host.querySelector('.ui-notice');
    assert.ok(notice, 'a send whose outcome is unknown still speaks');
    assert.equal(notice!.textContent, UNKNOWN, 'in the exact words, not a softer rewrite');
    assert.equal(host.querySelectorAll('.ui-notice').length, 1, 'one notice, not a stack');
  } finally {
    done();
  }
});

test('a source that cannot send keeps its draft line, and that line is not a send result', async () => {
  const { host, flush, done } = await mount([INVITE_SOURCE], async () => ({ status: 'Sent.' }));
  try {
    await openRow(host, 'Grace Hopper');
    const notice = host.querySelector('.ui-chat-composer .ui-notice');
    assert.equal(notice?.textContent, 'Kept as a draft on this machine; this source cannot send from here.', 'the box says what it does with the words, because it cannot send them');
    assert.equal(host.querySelectorAll('.ui-notice').length, 1, 'and there is no second box reporting a send that never happened');
    assert.equal(host.querySelector('.ui-notice[role="status"]'), null, 'a draft kept is a state, not something being announced as a result');
  } finally {
    done();
  }
});

/** jsdom owns the globals React reads. Installed once, kept for the whole file. */
function install(page: JSDOM): void {
  const keys = ['window', 'document', 'navigator', 'HTMLElement', 'HTMLTextAreaElement', 'Element', 'Node', 'Event', 'MouseEvent', 'localStorage'] as const;
  // `navigator` is a getter on the Node global, so globals are defined rather than assigned.
  const define = (key: string, value: unknown) => Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  define('window', page.window);
  define('document', page.window.document);
  for (const key of keys) {
    const value = (page.window as any)[key];
    if (value !== undefined) define(key, value);
  }
}
