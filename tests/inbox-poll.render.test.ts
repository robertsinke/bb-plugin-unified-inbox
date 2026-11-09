// A WhatsApp poll is one card. Choosing an option sends the next selection.
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

const CHAT = {
  send: true, markRead: true, archive: false, invitations: false, media: true, attachments: false,
  threads: true, followsList: true, react: true, reactRemove: true, quoteReply: true, pollVote: false,
};

const ROW = { account: 'whatsapp', id: '31612345678@s.whatsapp.net', title: 'Ada Lovelace', preview: 'Poll', date: 1_700_000_000_000, unread: false };

const THREAD = [
  { sender: 'Ada', text: 'See you', date: 1, messageId: 'm1' },
  {
    sender: 'Ada',
    text: '',
    date: 2,
    messageId: 'poll1',
    poll: {
      question: 'Lunch?',
      selectableCount: 1,
      options: [
        { name: 'Yes', count: 1, selected: false },
        { name: 'No', count: 2, selected: true },
      ],
    },
  },
];

function caps(pollVote: boolean) {
  return {
    'gmail-personal': { ...CHAT, archive: true, attachments: true, threads: false, media: false },
    'gmail-business': { ...CHAT, archive: true, attachments: true, threads: false, media: false },
    whatsapp: { ...CHAT, pollVote },
    imessage: { ...CHAT, attachments: true },
    linkedin: { ...CHAT, invitations: true, followsList: false, threads: true },
  };
}

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function mount(pollVote: boolean) {
  const calls: Array<{ name: string; input: unknown }> = [];
  const call = (name: string, input: unknown) => {
    calls.push({ name, input });
    if (name === 'capabilities') return caps(pollVote);
    if (name === 'sources') return DECLARED;
    if (name === 'cached') return { items: [ROW] };
    if (name === 'cached_open') return { messages: [] };
    if (name === 'open') return { messages: THREAD };
    if (name === 'action') return Promise.resolve({ status: 'Sent.' });
    if (name === 'sync') return { items: [], updatedAt: 0 };
    if (name === 'send_audit') return { rows: [] };
    if (name === 'whatsapp_pairing') return { state: 'connected' };
    return null;
  };
  let panel: any = null;
  const app = { slots: { experimental_tab: (config: { component: unknown }) => { panel = config.component; }, settingsSection: () => {} } };
  const sdk = {
    definePluginApp: (define: (app: unknown) => void) => { define(app); return panel; },
    experimental_Icon: () => null,
    experimental_useAppPanel: () => ({ openTab() {} }),
    ThreadChat: () => null,
    useRpc: () => ({ call: (method: string, input?: unknown) => Promise.resolve(call(method, input)) }),
    useSdk: () => ({ threads: { tabs: { get: async () => ({ tabs: [], revision: 1 }), update: async () => ({ tabs: [], revision: 2 }) } } }),
    useBbNavigate: () => ({ openUrl: () => {}, toThread: () => {} }),
    useComposers: () => [],
  };
  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { flushSync } = require('react-dom');
  const Inbox = loadComponent('app.tsx', { '@get-bb/plugin-sdk/app': sdk }).default;
  const host = dom.window.document.createElement('div');
  dom.window.document.body.append(host);
  const root = createRoot(host);
  flushSync(() => root.render(React.createElement(Inbox, { threadId: null })));
  await wait(60);
  const row = [...host.querySelectorAll('.ui-row')].find(element => element.textContent?.includes('Ada Lovelace'));
  assert.ok(row);
  (row!.querySelector('.ui-row-open-hit') as HTMLElement).dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  for (let tries = 0; tries < 100 && !host.querySelector('.ui-poll'); tries += 1) await wait(5);
  return {
    host,
    calls,
    done: () => { flushSync(() => root.unmount()); host.remove(); },
  };
}

test('a poll card shows the question and counts, and a choice sends that selection', async () => {
  const { host, calls, done } = await mount(true);
  try {
    const card = host.querySelector('.ui-poll');
    assert.ok(card);
    assert.equal(card!.querySelector('.ui-poll-question')?.textContent, 'Lunch?');
    const buttons = [...card!.querySelectorAll('.ui-poll-option')];
    assert.deepEqual(buttons.map(button => button.textContent), ['Yes1', 'No2']);
    assert.equal((buttons[1] as HTMLButtonElement).getAttribute('aria-pressed'), 'true');
    assert.equal(host.querySelector('.ui-bubble-text')?.textContent, 'See you');
    assert.ok(host.querySelector('.ui-reaction-set'), 'a normal message still offers reactions');
    (buttons[0] as HTMLButtonElement).dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await wait(20);
    const vote = calls.find(entry => entry.name === 'action');
    assert.deepEqual(vote?.input, {
      account: 'whatsapp',
      id: ROW.id,
      action: 'vote',
      messageId: 'poll1',
      options: ['Yes'],
      allow: 'send',
    });
  } finally {
    done();
  }
});

test('a source that cannot vote still shows the counts, and a click sends nothing', async () => {
  const { host, calls, done } = await mount(false);
  try {
    const button = host.querySelector('.ui-poll-option') as HTMLButtonElement;
    assert.equal(button.disabled, true);
    button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await wait(20);
    assert.equal(calls.some(entry => entry.name === 'action'), false);
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
