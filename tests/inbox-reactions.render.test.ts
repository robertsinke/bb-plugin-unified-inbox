// The open thread: incoming reactions and quote text, the four buttons, and a reply aimed at one message.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';

const require = createRequire(import.meta.url);

import { loadComponent } from './jsdom-harness.ts';
import { REACTION_SET } from '../src/reaction-set.ts';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost', pretendToBeVisual: true });
install(dom);

const DECLARED = {
  'gmail-personal': { label: 'Personal Gmail', icon: 'Mail', pollIntervalMs: 45_000, pageSize: 10 },
  'gmail-business': { label: 'Inhouse Gmail', icon: 'Mail', pollIntervalMs: 45_000, pageSize: 10 },
  whatsapp: { label: 'WhatsApp', icon: 'MessageCircle', pollIntervalMs: 8_000, pageSize: 50 },
  imessage: { label: 'Messages', icon: 'MessageCircle', pollIntervalMs: 8_000, pageSize: 20 },
  linkedin: { label: 'LinkedIn', icon: 'MessageCircle', pollIntervalMs: 45_000 },
};

const CHAT_CAPS = {
  send: true, markRead: true, archive: false, invitations: false, media: true, attachments: false,
  threads: true, followsList: true, react: true, reactRemove: true, quoteReply: true, pollVote: false,
};

type Flags = Partial<typeof CHAT_CAPS>;

const WHATSAPP = { account: 'whatsapp', id: '31612345678@s.whatsapp.net', title: 'Ada Lovelace', preview: 'See you', date: 1_700_000_000_000, unread: false };
const LINKEDIN = { account: 'linkedin', id: '2-conversation-key', title: 'Grace Hopper', sender: 'Grace Hopper', preview: 'Hi', date: 1_700_000_000_000, unread: false };
const GMAIL = { account: 'gmail-personal', id: 'thread-1', title: 'Budget', sender: 'Ada', preview: 'Hello', date: 1_700_000_000_000, unread: false };

const THREAD = [
  { sender: 'Ada', text: 'See you', date: 1, messageId: 'm1', reactions: [{ sender: 'Grace', label: '👍' }, { sender: '', label: '😂' }, { sender: 'You', label: '❤️' }] },
  { sender: 'Ada', text: 'later', date: 2, messageId: 'm2', quote: { sender: 'Grace', text: 'earlier' } },
  { sender: 'You', text: 'mine', date: 3, fromMe: true, messageId: 'm3', reactions: [{ sender: 'You', label: '❤️' }, { sender: 'Grace', label: '👍' }] },
  { sender: 'Ada', text: 'marker', date: 4, replyContext: true },
  { sender: 'Ada', text: 'emphasis', date: 5, messageId: 'm5', reactions: [{ sender: 'Ada', label: '‼️' }] },
  { sender: 'Ada', text: 'no id', date: 6, reactions: [{ sender: 'Ada', label: '👍' }] },
];

function caps(overrides: Record<string, Flags> = {}) {
  const base: Flags = { ...CHAT_CAPS, react: false, reactRemove: false, quoteReply: false };
  const accounts: Record<string, Flags> = {
    'gmail-personal': { ...base, archive: true, attachments: true, threads: false, media: false },
    'gmail-business': { ...base, archive: true, attachments: true, threads: false, media: false },
    whatsapp: { ...CHAT_CAPS, pollVote: true },
    imessage: { ...CHAT_CAPS, attachments: true },
    linkedin: { ...base, invitations: true, followsList: false },
  };
  for (const [account, flags] of Object.entries(overrides)) accounts[account] = { ...accounts[account], ...flags };
  return accounts;
}

type Call = { name: string; input: unknown };

function rpcAnswer(rows: unknown[], messages: unknown[], action: (input: any) => Promise<unknown>, flags?: Record<string, Flags>, older?: () => Promise<unknown>) {
  const calls: Call[] = [];
  const call = (name: string, input: any): unknown => {
    calls.push({ name, input });
    if (name === 'capabilities') return caps(flags);
    if (name === 'sources') return DECLARED;
    if (name === 'cached') return { items: rows };
    if (name === 'cached_open') return { messages: [] };
    if (name === 'open') return input?.before && older ? older() : { messages, ...(older ? { cursor: 'older' } : {}) };
    if (name === 'action') return action(input);
    if (name === 'sync') return { items: [], updatedAt: 0 };
    if (name === 'send_audit') return { rows: [] };
    if (name === 'whatsapp_pairing') return { state: 'connected' };
    return null;
  };
  return { call, calls };
}

function sdk(rpc: (method: string, input: unknown) => unknown) {
  let panel: any = null;
  const app = {
    slots: { experimental_tab: (config: { component: unknown }) => { panel = config.component; }, settingsSection: () => {} },
  };
  return {
    definePluginApp: (define: (app: unknown) => void) => { define(app); return panel; },
    experimental_Icon: () => null,
    experimental_useAppPanel: () => ({ openTab() {} }),
    ThreadChat: () => null,
    useRpc: () => ({ call: (method: string, input?: unknown) => Promise.resolve(rpc(method, input)) }),
    useSdk: () => ({ threads: { tabs: { get: async () => ({ tabs: [], revision: 1 }), update: async () => ({ tabs: [], revision: 2 }) } } }),
    useBbNavigate: () => ({ openUrl: () => {}, toThread: () => {} }),
    useComposers: () => [],
  };
}

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function mount(rows: unknown[], messages: unknown[], action: (input: any) => Promise<unknown> = async () => ({ status: 'Sent' }), flags?: Record<string, Flags>, older?: () => Promise<unknown>) {
  const rpc = rpcAnswer(rows, messages, action, flags, older);
  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { flushSync } = require('react-dom');
  const Inbox = loadComponent('app.tsx', { '@get-bb/plugin-sdk/app': sdk(rpc.call) }).default;
  const host = dom.window.document.createElement('div');
  dom.window.document.body.append(host);
  const root = createRoot(host);
  flushSync(() => root.render(React.createElement(Inbox, { threadId: null })));
  await wait(60);
  return {
    host,
    calls: rpc.calls,
    flush: () => flushSync(() => {}),
    done: () => { flushSync(() => root.unmount()); host.remove(); },
  };
}

async function openRow(host: HTMLElement, name: string, ready: string): Promise<void> {
  const row = [...host.querySelectorAll('.ui-row')].find(element => element.querySelector('.ui-row-name')?.textContent === name);
  assert.ok(row, `${name} is a row on screen`);
  (row!.querySelector('.ui-row-open-hit') as HTMLElement).dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  for (let tries = 0; tries < 100 && !host.querySelector(ready); tries += 1) await wait(5);
  assert.ok(host.querySelector(ready), `${name} is open`);
}

function bubble(host: ParentNode, text: string): HTMLElement {
  const found = [...host.querySelectorAll('.ui-bubble')].find(element => element.querySelector('.ui-bubble-text')?.textContent?.includes(text));
  assert.ok(found, text);
  return found as HTMLElement;
}

function press(root: ParentNode, emoji: string): void {
  const button = [...root.querySelectorAll('.ui-reaction-set button')].find(element => element.textContent === emoji);
  assert.ok(button, emoji);
  button!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
}

async function typeReply(host: HTMLElement, text: string, flush: () => void): Promise<void> {
  const box = host.querySelector('#ui-reply-text') as HTMLTextAreaElement;
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')?.set;
  setter?.call(box, text);
  box.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  flush();
  (host.querySelector('.ui-chat-composer') as HTMLElement).dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await wait(60);
  flush();
}

function sent(calls: Call[], action: string) {
  return calls.filter(call => call.name === 'action' && (call.input as { action?: string }).action === action).map(call => call.input);
}

test('scrolling to the top loads older messages and shows a centered, non-clickable status', async () => {
  let resolvePage!: (value: unknown) => void;
  const page = new Promise(resolve => { resolvePage = resolve; });
  const { host, calls, done } = await mount([WHATSAPP], THREAD, undefined, undefined, () => page);
  try {
    await openRow(host, 'Ada Lovelace', '.ui-chat-day');
    const scroller = host.querySelector('.ui-thread-scroll') as HTMLElement;
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 1000 });
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 400 });
    const status = host.querySelector('[role="status"].ui-chat-day');
    assert.ok(status);
    assert.equal(status.tagName, 'DIV');
    assert.match(status.textContent!, /scroll up/i);
    assert.equal([...host.querySelectorAll('button')].some(button => /load older messages/i.test(button.textContent ?? '')), false);
    scroller.scrollTop = 0;
    scroller.dispatchEvent(new dom.window.Event('scroll', { bubbles: true }));
    await wait(20);
    assert.match(host.querySelector('[role="status"].ui-chat-day')?.textContent ?? '', /loading older/i);
    assert.equal(calls.filter(call => call.name === 'open' && (call.input as any)?.before === 'older').length, 1);
    resolvePage({ messages: [{ sender: 'Ada', text: 'older message', date: 0, messageId: 'old' }] });
    await wait(20);
    assert.ok(host.textContent?.includes('older message'));
    assert.equal(host.querySelector('[role="status"].ui-chat-day'), null);
  } finally { resolvePage({ messages: [] }); done(); }
});

test('a page too short to scroll fetches the next page without a click', async () => {
  const proto = dom.window.HTMLElement.prototype;
  const height = Object.getOwnPropertyDescriptor(proto, 'clientHeight');
  const scrollHeight = Object.getOwnPropertyDescriptor(proto, 'scrollHeight');
  Object.defineProperty(proto, 'clientHeight', { configurable: true, get: () => 400 });
  Object.defineProperty(proto, 'scrollHeight', { configurable: true, get: () => 300 });
  const view = await mount([WHATSAPP], THREAD, undefined, undefined, async () => ({ messages: [{ sender: 'Ada', text: 'older message', date: 0, messageId: 'old' }] }));
  try {
    await openRow(view.host, 'Ada Lovelace', '.ui-chat-day');
    await wait(20);
    assert.equal(view.calls.filter(call => call.name === 'open' && (call.input as any)?.before === 'older').length, 1);
    assert.ok(view.host.textContent?.includes('older message'));
  } finally {
    view.done();
    if (height) Object.defineProperty(proto, 'clientHeight', height); else delete (proto as any).clientHeight;
    if (scrollHeight) Object.defineProperty(proto, 'scrollHeight', scrollHeight); else delete (proto as any).scrollHeight;
  }
});

test('a bubble shows reactions and quote text, and a click sends one reaction or one aimed reply', async () => {
  const { host, calls, flush, done } = await mount([WHATSAPP], THREAD);
  try {
    await openRow(host, 'Ada Lovelace', '.ui-chat-composer');
    flush();
    assert.equal(sent(calls, 'react').length, 0, 'drawing a reaction does not send one');
    assert.equal(sent(calls, 'reply').length, 0);

    const seen = bubble(host, 'See you');
    assert.match(seen.querySelector('[aria-label="Reactions"]')?.textContent ?? '', /👍/);
    assert.match(seen.querySelector('[aria-label="Reactions"]')?.textContent ?? '', /😂/);
    assert.equal(seen.querySelectorAll('.ui-reaction-set button').length, REACTION_SET.length);
    const quoted = bubble(host, 'later');
    assert.match(quoted.textContent ?? '', /Grace/);
    assert.match(quoted.textContent ?? '', /earlier/);
    assert.equal(bubble(host, 'marker').textContent?.includes('Reply to an earlier message'), true);
    const emphasis = bubble(host, 'emphasis');
    assert.match(emphasis.querySelector('[aria-label="Reactions"]')?.textContent ?? '', /‼️/);
    assert.equal([...emphasis.querySelectorAll('.ui-reaction-set button')].some(button => button.textContent === '‼️'), false);
    assert.equal(bubble(host, 'no id').querySelector('.ui-reaction-set'), null, 'a message with no id has no reaction buttons');

    press(seen, '👍');
    await wait(40);
    flush();
    assert.deepEqual(sent(calls, 'react').at(-1), {
      account: 'whatsapp', id: WHATSAPP.id, action: 'react', messageId: 'm1', emoji: '👍', allow: 'send',
    });
    press(seen, '❤️');
    await wait(40);
    flush();
    assert.deepEqual(sent(calls, 'react').at(-1), {
      account: 'whatsapp', id: WHATSAPP.id, action: 'react', messageId: 'm1', emoji: '❤️', allow: 'send', remove: true,
    });

    const mine = bubble(host, 'mine');
    assert.equal(mine.querySelectorAll('.ui-reaction-set button').length, REACTION_SET.length);
    assert.equal([...mine.querySelectorAll('button')].some(button => button.textContent === 'Reply'), true);

    const reply = [...quoted.querySelectorAll('button')].find(button => button.textContent === 'Reply');
    assert.ok(reply);
    reply!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    flush();
    assert.match(host.querySelector('.ui-chat-composer')?.textContent ?? '', /Ada later/);
    await typeReply(host, 'ok', flush);
    assert.deepEqual(sent(calls, 'reply').at(-1), {
      account: 'whatsapp', id: WHATSAPP.id, action: 'reply', text: 'ok', allow: 'send', messageId: 'm2',
    });
    assert.equal(host.querySelector('.ui-chat-composer')?.textContent?.includes('Clear'), false, 'a send that worked drops the quote line');

    await typeReply(host, 'next', flush);
    assert.deepEqual(sent(calls, 'reply').at(-1), {
      account: 'whatsapp', id: WHATSAPP.id, action: 'reply', text: 'next', allow: 'send',
    });
  } finally {
    done();
  }
});

test('a thread with no from-me label sends the emoji and does not remove', async () => {
  const messages = [{ sender: 'Ada', text: 'orphan', date: 1, messageId: 'm9', reactions: [{ sender: 'You', label: '👍' }] }];
  const { host, calls, flush, done } = await mount([WHATSAPP], messages);
  try {
    await openRow(host, 'Ada Lovelace', '.ui-chat-composer');
    flush();
    press(bubble(host, 'orphan'), '👍');
    await wait(40);
    flush();
    assert.deepEqual(sent(calls, 'react').at(-1), {
      account: 'whatsapp', id: WHATSAPP.id, action: 'react', messageId: 'm9', emoji: '👍', allow: 'send',
    });
  } finally {
    done();
  }
});

test('react false keeps the labels and hides the buttons; quoteReply false hides Reply', async () => {
  const messages = [{ sender: 'Grace', text: 'Hi', date: 1, messageId: 'm1', reactions: [{ sender: 'Ada', label: '👍' }, { sender: 'Ada', label: '❓' }] }];
  const labels = await mount([LINKEDIN], messages, async () => ({ status: 'Sent' }), { linkedin: { react: false, quoteReply: true, threads: true, send: true } });
  try {
    await openRow(labels.host, 'Grace Hopper', '.ui-chat-composer');
    labels.flush();
    const one = bubble(labels.host, 'Hi');
    assert.match(one.querySelector('[aria-label="Reactions"]')?.textContent ?? '', /👍/);
    assert.match(one.querySelector('[aria-label="Reactions"]')?.textContent ?? '', /❓/);
    assert.equal(one.querySelector('.ui-reaction-set'), null);
    assert.equal([...one.querySelectorAll('button')].some(button => button.textContent === 'Reply'), true);
  } finally {
    labels.done();
  }

  const replies = await mount([LINKEDIN], messages, async () => ({ status: 'Sent' }), { linkedin: { react: true, quoteReply: false, threads: true, send: true } });
  try {
    await openRow(replies.host, 'Grace Hopper', '.ui-chat-composer');
    replies.flush();
    const one = bubble(replies.host, 'Hi');
    assert.equal([...one.querySelectorAll('button')].some(button => button.textContent === 'Reply'), false);
    assert.equal(one.querySelectorAll('.ui-reaction-set button').length, REACTION_SET.length);
    await typeReply(replies.host, 'ok', replies.flush);
    assert.deepEqual(sent(replies.calls, 'reply').at(-1), {
      account: 'linkedin', id: LINKEDIN.id, action: 'reply', text: 'ok', allow: 'send',
    });
  } finally {
    replies.done();
  }
});

test('a refused reaction is one call, and a refused reply keeps the typed text', async () => {
  const refused = 'Nothing was sent.';
  let mode: 'react' | 'reply' = 'react';
  const { host, calls, flush, done } = await mount([WHATSAPP], THREAD, async input => {
    if (input.action === mode) throw new Error(refused);
    return { status: 'Sent' };
  });
  try {
    await openRow(host, 'Ada Lovelace', '.ui-chat-composer');
    flush();
    press(bubble(host, 'See you'), '👍');
    await wait(40);
    flush();
    assert.equal(sent(calls, 'react').length, 1);
    assert.equal(host.querySelector('.ui-notice[role="status"]')?.textContent, refused);

    mode = 'reply';
    const reply = [...bubble(host, 'later').querySelectorAll('button')].find(button => button.textContent === 'Reply');
    reply!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    flush();
    await typeReply(host, 'ok', flush);
    assert.equal(sent(calls, 'reply').length, 1);
    assert.equal((host.querySelector('#ui-reply-text') as HTMLTextAreaElement).value, 'ok');
    assert.match(host.querySelector('.ui-chat-composer')?.textContent ?? '', /Clear/);
  } finally {
    done();
  }
});

test('the Gmail composer does not render the four reactions', async () => {
  const { host, flush, done } = await mount(
    [GMAIL],
    [{ sender: 'Ada', text: 'Hello', date: 1, subject: 'Budget' }],
    async () => ({ status: 'Sent' }),
    { 'gmail-personal': { threads: false, react: true, quoteReply: true, send: true } },
  );
  try {
    await openRow(host, 'Ada', '.ui-message');
    flush();
    const reply = [...host.querySelectorAll('.ui-conversation-header [role="menuitem"]')].find(item => item.textContent === 'Reply');
    assert.ok(reply, 'mail still has its conversation reply');
    reply!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    flush();
    const composer = host.querySelector('.ui-mail-composer');
    assert.ok(composer, 'the mail composer is the Gmail reply');
    const buttons = [...host.querySelectorAll('button')].map(button => button.textContent ?? '');
    for (const item of REACTION_SET) assert.equal(buttons.includes(item.emoji), false, item.label);
    assert.equal(host.querySelector('.ui-reaction-set'), null);
  } finally {
    done();
  }
});

/** jsdom owns the globals React reads. Installed once, kept for the whole file. */
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
