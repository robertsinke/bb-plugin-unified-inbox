// A Gmail send asks inside the panel, then the reply is in the open thread. The system confirm
// is not part of that path.
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

const MAIL = { account: 'gmail-personal', id: 't1', title: 'Plan', sender: 'Ada Lovelace', preview: 'The plan', date: 1, unread: false };
const PRIOR = { sender: 'Ada Lovelace <ada@example.com>', text: 'The plan', date: 1, subject: 'Plan', messageId: '<m1@example.com>', suggestedTo: 'ada@example.com' };

let sends = 0;
let confirms = 0;

function caps() {
  return Object.fromEntries(Object.keys(DECLARED).map(account => [account, {
    send: true,
    markRead: true,
    archive: false,
    invitations: false,
    media: false,
    attachments: true,
    threads: account !== 'gmail-personal' && account !== 'gmail-business',
    followsList: true,
    react: false,
    reactRemove: false,
    quoteReply: false,
  }]));
}

function rpc(name: string, input: any): unknown {
  if (name === 'capabilities') return caps();
  if (name === 'sources') return DECLARED;
  if (name === 'cached') return { items: [MAIL] };
  if (name === 'cached_open') return { messages: [PRIOR] };
  if (name === 'open') return { messages: [PRIOR] };
  if (name === 'sync') return { items: [], updatedAt: 0 };
  if (name === 'send_audit') return { rows: [] };
  if (name === 'send_gmail') { sends += 1; return { status: 'Sent.' }; }
  return null;
}

function sdk() {
  let panel: any = null;
  const app = { slots: { experimental_tab: (config: { component: unknown }) => { panel = config.component; } } };
  return {
    definePluginApp: (define: (app: unknown) => void) => { define(app); return panel; },
    experimental_Icon: () => null,
    ThreadChat: () => null,
    useRpc: () => ({ call: (method: string, input?: unknown) => Promise.resolve(rpc(method, input)) }),
    useSdk: () => ({ threads: { tabs: { get: async () => ({ tabs: [], revision: 1 }), update: async () => ({ tabs: [], revision: 2 }) } } }),
    useBbNavigate: () => ({ openUrl: () => {}, toThread: () => {} }),
    useComposers: () => [],
  };
}

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function mount() {
  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { flushSync } = require('react-dom');
  const Inbox = loadComponent('app.tsx', { '@get-bb/plugin-sdk/app': sdk() }).default;
  const host = dom.window.document.createElement('div');
  dom.window.document.body.append(host);
  const root = createRoot(host);
  flushSync(() => root.render(React.createElement(Inbox, { threadId: null })));
  await wait(60);
  return { host, flush: () => flushSync(() => {}), done: () => { flushSync(() => root.unmount()); host.remove(); } };
}

function click(element: Element): void {
  element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
}

test('a Gmail reply asks in the panel, then the sent line is in the thread', async () => {
  dom.window.confirm = () => { confirms += 1; return true; };
  const { host, flush, done } = await mount();
  try {
    const row = [...host.querySelectorAll('.ui-row')].find(element => element.querySelector('.ui-row-name')?.textContent === 'Ada Lovelace');
    assert.ok(row, 'the conversation is a row');
    click(row!.querySelector('.ui-row-open-hit')!);
    for (let tries = 0; tries < 100 && !host.querySelector('.ui-message'); tries += 1) await wait(5);
    assert.ok(host.querySelector('.ui-message'), 'the thread is open');

    const reply = [...host.querySelectorAll('.ui-conversation-actions [role="menuitem"]')].find(item => item.textContent?.trim() === 'Reply');
    assert.ok(reply, 'Reply is in the conversation menu');
    click(reply!);
    flush();
    assert.ok(host.querySelector('.ui-mail-composer'), 'the mail draft is open');

    const box = host.querySelector('.ui-mail-body') as any;
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')?.set;
    setter?.call(box, 'On it.');
    flush();
    box.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    flush();
    (host.querySelector('.ui-mail-composer') as HTMLFormElement).dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    flush();

    const ask = host.querySelector('.ui-send-ask');
    assert.equal(ask?.querySelector('p')?.textContent, 'Send from Personal Gmail to ada@example.com?');
    assert.equal(sends, 0, 'the question does not send');
    assert.equal(confirms, 0, 'the question is not the system dialog');

    click(ask!.querySelector('.ui-send-ask-cancel')!);
    flush();
    assert.equal(host.querySelector('.ui-send-ask'), null, 'Cancel leaves the draft');
    assert.equal(sends, 0);

    (host.querySelector('.ui-mail-composer') as HTMLFormElement).dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    flush();
    click(host.querySelector('.ui-send-ask-send')!);
    await wait(60);
    flush();

    assert.equal(sends, 1, 'Send is the confirmation');
    assert.equal(confirms, 0);
    const lines = [...host.querySelectorAll('.ui-message')].map(message => message.textContent);
    assert.ok(lines.some(line => line?.includes('On it.')), 'the reply is in the thread');
    assert.ok(lines.some(line => line?.includes('The plan')), 'the earlier message stays');
  } finally {
    done();
  }
});

function install(page: JSDOM): void {
  const keys = ['window', 'document', 'navigator', 'HTMLElement', 'HTMLTextAreaElement', 'Element', 'Node', 'Event', 'MouseEvent', 'localStorage'] as const;
  const define = (key: string, value: unknown) => Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  define('window', page.window);
  define('document', page.window.document);
  for (const key of keys) {
    const value = (page.window as any)[key];
    if (value !== undefined) define(key, value);
  }
}
