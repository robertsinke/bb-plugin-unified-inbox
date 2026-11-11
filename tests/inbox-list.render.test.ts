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
  const browserTabs: { kind?: string; url?: string }[] = [];
  const app = {
    slots: { experimental_tab: (config: { component: unknown }) => { panel = config.component; }, settingsSection: () => {} },
  };
  const stub = {
    definePluginApp: (define: (app: unknown) => void) => { define(app); return panel; },
    experimental_Icon: () => null,
    experimental_useAppPanel: () => ({ openTab() {} }),
    ThreadChat: () => null,
    useRpc: () => ({ call: rpc }),
    useSdk: () => ({ threads: { tabs: {
      get: async () => ({ tabs: browserTabs, revision: 1 }),
      update: async (input: { tabs: { kind?: string; url?: string }[] }) => {
        browserTabs.splice(0, browserTabs.length, ...input.tabs);
        return { tabs: input.tabs, revision: 2 };
      },
    } } }),
    useBbNavigate: () => ({ openUrl: () => {}, toThread: () => {} }),
    useComposers: () => [],
  };
  return { stub, browserTabs, panel: () => panel };
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

function mountInbox(answer: (name: string) => unknown, threadId: string | null = null) {
  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { flushSync } = require('react-dom');
  const calls: { name: string; input: unknown }[] = [];
  const { stub, browserTabs } = sdk(async (name: string, input?: unknown) => {
    calls.push({ name, input });
    return answer(name);
  });
  const Inbox = loadComponent('app.tsx', { '@get-bb/plugin-sdk/app': stub }).default;
  const host = dom.window.document.createElement('div');
  dom.window.document.body.append(host);
  const root = createRoot(host);
  flushSync(() => root.render(React.createElement(Inbox, { threadId })));
  return {
    host,
    calls,
    browserTabs,
    flush: () => flushSync(() => {}),
    done: () => { flushSync(() => root.unmount()); host.remove(); },
  };
}

const menuLabels = (host: Element) => [...host.querySelectorAll('[role="menuitem"]')].map(entry => entry.textContent?.trim());

test('a new inbox with no accounts and no verdict has no Needed or None label', async () => {
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
    assert.deepEqual(menuLabels(view.host), ['All', 'Unread', 'New', 'Send log', 'Refresh']);
    assert.equal(view.host.textContent?.includes('Needed'), false);
    assert.equal(view.host.textContent?.includes('None'), false);
    assert.equal(view.host.textContent?.includes('Decisions'), false);
  } finally {
    view.done();
  }
});

test('a conversation with no stored verdict keeps Needed and None out of the menu', async () => {
  const view = mountInbox(name => {
    if (name === 'cached') return { items: [MAIL_ROW] };
    return rpcAnswer(name);
  });
  try {
    await wait(50);
    view.flush();
    assert.equal(view.host.querySelector('.ui-row-name')?.textContent, 'Ada Lovelace');
    assert.equal(menuLabels(view.host).includes('Needed'), false);
    assert.equal(menuLabels(view.host).includes('None'), false);
  } finally {
    view.done();
  }
});

test('a conversation that already has a verdict shows Needed and None', async () => {
  const view = mountInbox(name => {
    if (name === 'cached') return { items: [{ ...MAIL_ROW, needsAttention: 'yes' }] };
    return rpcAnswer(name);
  });
  try {
    await wait(50);
    view.flush();
    const labels = menuLabels(view.host);
    assert.equal(labels.includes('Needed'), true);
    assert.equal(labels.includes('None'), true);
    assert.equal(view.host.querySelector('.ui-row [data-attention="yes"]')?.textContent, 'Needed');
  } finally {
    view.done();
  }
});

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
    assert.equal(view.host.querySelector('[data-attention]'), null);
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

test('a new WhatsApp chat asks for a phone number and sends through the existing reply', async () => {
  const view = mountInbox(name => {
    if (name === 'whatsapp_resolve') return { jid: '31612345678@s.whatsapp.net' };
    if (name === 'action') return { status: 'sent' };
    return rpcAnswer(name);
  });
  try {
    await wait(50);
    view.flush();
    const open = [...view.host.querySelectorAll('button')].find(button => button.textContent === 'New');
    assert.ok(open);
    view.flush();
    open.click();
    view.flush();
    assert.equal(view.host.textContent?.includes("aren't supported"), false);
    const phone = view.host.querySelector('.ui-whatsapp-phone');
    const message = view.host.querySelector('.ui-whatsapp-text');
    assert.ok(phone);
    assert.ok(message);
    view.flush();
    type(phone, '+31 6 12345678');
    const area = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')?.set;
    view.flush();
    area?.call(message, 'Hello');
    message.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    view.flush();
    const send = [...view.host.querySelectorAll('button')].find(button => button.textContent === 'Send');
    assert.ok(send);
    send.click();
    await wait(50);
    view.flush();
    assert.deepEqual(view.calls.filter(call => call.name === 'whatsapp_resolve' || call.name === 'action'), [
      { name: 'whatsapp_resolve', input: { phone: '+31 6 12345678' } },
      { name: 'action', input: { account: 'whatsapp', id: '31612345678@s.whatsapp.net', action: 'reply', text: 'Hello', allow: 'send' } },
    ]);
  } finally {
    view.done();
  }
});

test('an unpaired WhatsApp account shows the settings sentence and no phone field', async () => {
  const view = mountInbox(name => {
    if (name === 'whatsapp_pairing') return { state: 'unpaired' };
    return rpcAnswer(name);
  });
  try {
    await wait(50);
    view.flush();
    const open = [...view.host.querySelectorAll('button')].find(button => button.textContent === 'New');
    assert.ok(open);
    open.click();
    view.flush();
    assert.equal(view.host.textContent?.includes(WHATSAPP_SETTINGS_COPY), true);
    assert.equal(view.host.querySelector('.ui-whatsapp-phone'), null);
  } finally {
    view.done();
  }
});

const MAILBOX = 'ada@example.com';
const PNG = 'data:image/png;base64,qq';

async function openMail(view: ReturnType<typeof mountInbox>) {
  await wait(50);
  view.flush();
  const row = view.host.querySelector('.ui-row-open-hit');
  assert.ok(row);
  row.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  for (let tries = 0; tries < 40 && !view.host.querySelector('.ui-message'); tries += 1) await wait(10);
  view.flush();
}

test('a PNG attachment is drawn and the mail HTML stays free of that data URL', async () => {
  const view = mountInbox(name => {
    if (name === 'sources') return { [MAILBOX]: { label: 'Ada', icon: 'Mail', pollIntervalMs: 45_000, pageSize: 10 } };
    if (name === 'capabilities') return { [MAILBOX]: { send: true, markRead: true, archive: false, invitations: false, media: true, attachments: true, threads: false, followsList: true } };
    if (name === 'cached') return { items: [{ account: MAILBOX, id: 't1', title: 'Plan', sender: 'Ada', preview: 'See the photo', date: 1, unread: false }] };
    if (name === 'cached_open' || name === 'open') return { messages: [{ sender: 'Ada', text: 'See the photo', date: 1, html: '<p>See the photo</p><img src="cid:logo"><img src="https://cdn.example/a.png">', attachments: ['photo.png', 'note.pdf', 'mark.svg'], inline: [{ contentId: 'logo', filename: 'logo.png' }], gmailId: 'g1' }] };
    if (name === 'sync') return { items: [], updatedAt: 0 };
    if (name === 'media') {
      const filename = String((view.calls.at(-1)?.input as { filename?: string } | undefined)?.filename ?? '');
      if (filename === 'photo.png' || filename === 'logo.png') return { dataUrl: PNG, mime: 'image/png', filename };
      throw new Error(`unexpected file ${filename}`);
    }
    return null;
  });
  try {
    await openMail(view);
    for (let tries = 0; tries < 40 && !view.host.querySelector('.ui-mail-image'); tries += 1) await wait(10);
    view.flush();
    assert.equal(view.host.querySelector('.ui-mail-image')?.getAttribute('src'), PNG);
    assert.equal(view.host.querySelector('.ui-attachment')?.textContent, 'photo.png');
    const frame = view.host.querySelector('.ui-mail-frame');
    assert.match(frame?.getAttribute('srcdoc') ?? '', /See the photo/);
    assert.equal(frame?.getAttribute('srcdoc')?.includes('data:image'), false);
    assert.equal(frame?.getAttribute('srcdoc')?.includes('cid:logo'), true);
    assert.equal(frame?.getAttribute('srcdoc')?.includes('https://cdn.example/a.png'), true);
    const files = [...new Set(view.calls.filter(call => call.name === 'media').map(call => (call.input as { filename?: string }).filename))];
    assert.deepEqual(files.sort(), ['logo.png', 'photo.png']);
  } finally {
    view.done();
  }
});

test('a PDF and an SVG stay chips', async () => {
  const view = mountInbox(name => {
    if (name === 'sources') return { [MAILBOX]: { label: 'Ada', icon: 'Mail', pollIntervalMs: 45_000, pageSize: 10 } };
    if (name === 'capabilities') return { [MAILBOX]: { send: true, markRead: true, archive: false, invitations: false, media: true, attachments: true, threads: false, followsList: true } };
    if (name === 'cached') return { items: [{ account: MAILBOX, id: 't1', title: 'Plan', sender: 'Ada', preview: 'Files', date: 1, unread: false }] };
    if (name === 'cached_open' || name === 'open') return { messages: [{ sender: 'Ada', text: 'Files', date: 1, html: '<p>Files</p>', attachments: ['note.pdf', 'mark.svg'], gmailId: 'g1' }] };
    if (name === 'sync') return { items: [], updatedAt: 0 };
    return null;
  });
  try {
    await openMail(view);
    await wait(30);
    view.flush();
    assert.equal(view.host.querySelector('.ui-mail-image'), null);
    assert.deepEqual([...view.host.querySelectorAll('.ui-attachment')].map(chip => chip.textContent), ['note.pdf', 'mark.svg']);
    assert.equal(view.calls.some(call => call.name === 'media'), false);
  } finally {
    view.done();
  }
});

test('a saved image names the Downloads folder and a failed image keeps the mail text', async () => {
  const saved = mountInbox(name => {
    if (name === 'sources') return { [MAILBOX]: { label: 'Ada', icon: 'Mail', pollIntervalMs: 45_000, pageSize: 10 } };
    if (name === 'capabilities') return { [MAILBOX]: { send: true, markRead: true, archive: false, invitations: false, media: true, attachments: true, threads: false, followsList: true } };
    if (name === 'cached') return { items: [{ account: MAILBOX, id: 't1', title: 'Plan', sender: 'Ada', preview: 'See the photo', date: 1, unread: false }] };
    if (name === 'cached_open' || name === 'open') return { messages: [{ sender: 'Ada', text: 'See the photo', date: 1, html: '<p>See the photo</p>', attachments: ['photo.png'], gmailId: 'g1' }] };
    if (name === 'sync') return { items: [], updatedAt: 0 };
    if (name === 'media') return { savedPath: '/tmp/photo.png', mime: 'image/png', filename: 'photo.png' };
    return null;
  });
  try {
    await openMail(saved);
    for (let tries = 0; tries < 40 && !saved.host.textContent?.includes('Downloads folder'); tries += 1) await wait(10);
    saved.flush();
    assert.match(saved.host.textContent ?? '', /photo.png is in your Downloads folder/);
    assert.equal(saved.host.querySelector('.ui-mail-image'), null);
  } finally {
    saved.done();
  }

  const failed = mountInbox(name => {
    if (name === 'sources') return { [MAILBOX]: { label: 'Ada', icon: 'Mail', pollIntervalMs: 45_000, pageSize: 10 } };
    if (name === 'capabilities') return { [MAILBOX]: { send: true, markRead: true, archive: false, invitations: false, media: true, attachments: true, threads: false, followsList: true } };
    if (name === 'cached') return { items: [{ account: MAILBOX, id: 't1', title: 'Plan', sender: 'Ada', preview: 'See the photo', date: 1, unread: false }] };
    if (name === 'cached_open' || name === 'open') return { messages: [{ sender: 'Ada', text: 'See the photo', date: 1, html: '<p>See the photo</p>', attachments: ['photo.png'], gmailId: 'g1' }] };
    if (name === 'sync') return { items: [], updatedAt: 0 };
    if (name === 'media') throw new Error('Could not open this attachment.');
    return null;
  });
  try {
    await openMail(failed);
    for (let tries = 0; tries < 40 && !failed.host.querySelector('.ui-attachment-error'); tries += 1) await wait(10);
    failed.flush();
    assert.match(failed.host.querySelector('.ui-attachment-error')?.textContent ?? '', /Could not open this attachment/);
    assert.match(failed.host.querySelector('.ui-mail-frame')?.getAttribute('srcdoc') ?? '', /See the photo/);
  } finally {
    failed.done();
  }
});

const click = (element: Element) => element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
const menuText = (root: Element) => [...root.querySelectorAll('[role="menuitem"]')].map(entry => entry.textContent?.trim());
const clickMenu = (root: Element, label: string) => {
  const item = [...root.querySelectorAll('[role="menuitem"]')].find(entry => entry.textContent?.trim() === label);
  assert.ok(item, label);
  click(item);
};

const SOURCES = [
  { account: 'gmail-personal', id: 'g', title: 'Mail', sender: 'Ada', preview: 'a', date: 4, unread: false },
  { account: 'whatsapp', id: 'w', title: 'Bo', preview: 'b', date: 3, unread: false },
  { account: 'imessage', id: 'm', title: 'Cy', preview: 'c', date: 2, unread: false },
  { account: 'linkedin', id: 'l', title: 'Dee', sender: 'Dee', preview: 'd', date: 1, unread: false },
];

test('each source row offers Mute, then Unmute, and the row stays', async () => {
  const view = mountInbox(name => {
    if (name === 'cached') return { items: SOURCES };
    if (name === 'mute') return { muted: true };
    if (name === 'unmute') return { muted: false };
    return rpcAnswer(name);
  });
  try {
    await wait(50);
    view.flush();
    const rows = [...view.host.querySelectorAll('.ui-row')];
    assert.equal(rows.length, 4);
    for (const row of rows) {
      const labels = menuText(row);
      const read = labels.indexOf('Mark unread');
      assert.equal(labels[read + 1], 'Mute', 'Mute sits next to Mark unread');
      assert.equal(labels.includes('Unmute'), false);
    }
    for (const row of [...view.host.querySelectorAll('.ui-row')]) clickMenu(row, 'Mute');
    await wait(30);
    view.flush();
    assert.equal(view.host.querySelectorAll('.ui-row').length, 4, 'mute does not drop a row');
    for (const row of view.host.querySelectorAll('.ui-row')) {
      const labels = menuText(row);
      assert.equal(labels.includes('Unmute'), true);
      assert.equal(labels.includes('Mute'), false);
      assert.equal(row.querySelector('.ui-mute-mark')?.textContent, 'Mute');
    }
  } finally {
    view.done();
  }
});

test('the open conversation offers Mute, then Unmute', async () => {
  const view = mountInbox(name => {
    if (name === 'cached') return { items: [MAIL_ROW] };
    if (name === 'mute') return { muted: true };
    if (name === 'unmute') return { muted: false };
    return rpcAnswer(name);
  });
  try {
    await wait(50);
    view.flush();
    click(view.host.querySelector('.ui-row-open-hit')!);
    await wait(50);
    view.flush();
    const header = view.host.querySelector('.ui-conversation-header');
    assert.ok(header);
    let labels = menuText(header);
    assert.equal(labels[labels.indexOf('Mark unread') + 1], 'Mute');
    clickMenu(header, 'Mute');
    await wait(30);
    view.flush();
    const open = view.host.querySelector('.ui-conversation-header')!;
    labels = menuText(open);
    assert.equal(labels.includes('Unmute'), true);
    assert.equal(labels.includes('Mute'), false);
    assert.equal(open.querySelector('.ui-mute-mark')?.textContent, 'Mute');
    clickMenu(open, 'Unmute');
    await wait(30);
    view.flush();
    assert.equal(view.host.querySelector('.ui-conversation-header .ui-mute-mark'), null);
    assert.equal(menuText(view.host.querySelector('.ui-conversation-header')!).includes('Mute'), true);
  } finally {
    view.done();
  }
});

test('a muted row stays in All, its source, Needed, and None, and the chip stays', async () => {
  const needed = { ...MAIL_ROW, id: 'need', sender: 'Ada Lovelace', needsAttention: 'yes' };
  const none = { ...MAIL_ROW, id: 'none', sender: 'Grace Hopper', title: 'Later', date: MAIL_ROW.date - 1, needsAttention: 'no' };
  const view = mountInbox(name => {
    if (name === 'cached') return { items: [needed, none] };
    if (name === 'mute') return { muted: true };
    return rpcAnswer(name);
  });
  try {
    await wait(50);
    view.flush();
    for (const row of [...view.host.querySelectorAll('.ui-row')]) clickMenu(row, 'Mute');
    await wait(30);
    view.flush();
    const names = () => [...view.host.querySelectorAll('.ui-row-name')].map(row => row.textContent);
    assert.deepEqual(names(), ['Ada Lovelace', 'Grace Hopper']);
    assert.equal(view.host.querySelectorAll('.ui-row .ui-mute-mark').length, 2);
    assert.equal(view.host.querySelector('.ui-row [data-attention="yes"]')?.textContent, 'Needed');
    assert.equal(view.host.querySelector('.ui-row [data-attention="no"]')?.textContent, 'None');
    clickMenu(view.host.querySelector('.ui-mail-bar')!, 'Personal Gmail');
    view.flush();
    assert.deepEqual(names(), ['Ada Lovelace', 'Grace Hopper']);
    clickMenu(view.host.querySelector('.ui-mail-bar')!, 'Needed');
    view.flush();
    assert.deepEqual(names(), ['Ada Lovelace']);
    assert.equal(view.host.querySelector('.ui-row .ui-mute-mark')?.textContent, 'Mute');
    assert.equal(view.host.querySelector('.ui-row [data-attention="yes"]')?.textContent, 'Needed');
    clickMenu(view.host.querySelector('.ui-mail-bar')!, 'None');
    view.flush();
    assert.deepEqual(names(), ['Grace Hopper']);
    assert.equal(view.host.querySelector('.ui-row .ui-mute-mark')?.textContent, 'Mute');
    assert.equal(view.host.querySelector('.ui-row [data-attention="no"]')?.textContent, 'None');
    clickMenu(view.host.querySelector('.ui-mail-bar')!, 'All');
    view.flush();
    assert.deepEqual(names(), ['Ada Lovelace', 'Grace Hopper']);
  } finally {
    view.done();
  }
});

test('a failed mute restores Mute and keeps the row', async () => {
  const view = mountInbox(name => {
    if (name === 'cached') return { items: [{ ...MAIL_ROW, needsAttention: 'yes' }] };
    if (name === 'mute') throw new Error('offline');
    return rpcAnswer(name);
  });
  try {
    await wait(50);
    view.flush();
    const row = view.host.querySelector('.ui-row')!;
    clickMenu(row, 'Mute');
    await wait(30);
    view.flush();
    const labels = menuText(view.host.querySelector('.ui-row')!);
    assert.equal(labels.includes('Mute'), true);
    assert.equal(labels.includes('Unmute'), false);
    assert.equal(view.host.querySelectorAll('.ui-row').length, 1);
    assert.equal(view.host.querySelector('.ui-row-name')?.textContent, 'Ada Lovelace');
    assert.equal(view.host.querySelector('.ui-row [data-attention="yes"]')?.textContent, 'Needed');
    assert.equal(view.host.querySelector('.ui-row .ui-mute-mark'), null);
  } finally {
    view.done();
  }
});

test('a muted row with no decision leaves the filter menu at All, Unread, and the sources', async () => {
  const view = mountInbox(name => {
    if (name === 'cached') return { items: [{ ...MAIL_ROW, muted: true }] };
    return rpcAnswer(name);
  });
  try {
    await wait(50);
    view.flush();
    const labels = menuText(view.host.querySelector('.ui-mail-bar')!);
    assert.deepEqual(labels, ['All', 'Unread', 'WhatsApp', 'Personal Gmail', 'Inhouse Gmail', 'Messages', 'LinkedIn', 'New', 'Send log', 'Refresh']);
    assert.equal(view.host.querySelector('.ui-row .ui-mute-mark')?.textContent, 'Mute');
  } finally {
    view.done();
  }
});

test('a LinkedIn name opens the stored profile and other names stay text', async () => {
  const same = { account: 'linkedin', id: 'urn:li:msg_conversation:(urn:li:fsd_profile:A,2-B)', title: 'Ada Lovelace', sender: 'Ada Lovelace', preview: 'Hello', date: 3, unread: false, profileUrl: 'https://www.linkedin.com/in/ada-lovelace' };
  const titled = { account: 'linkedin', id: 'urn:li:msg_conversation:(urn:li:fsd_profile:A,2-C)', title: 'Project', sender: 'Ada Lovelace', preview: 'Hello', date: 2, unread: false, profileUrl: 'https://www.linkedin.com/in/ada-lovelace' };
  const plain = { account: 'linkedin', id: 'urn:li:msg_conversation:(urn:li:fsd_profile:A,2-D)', title: 'Grace Hopper', sender: 'Grace Hopper', preview: 'Hi', date: 1, unread: false };
  const view = mountInbox(name => {
    if (name === 'cached') return { items: [same, titled, plain, MAIL_ROW] };
    if (name === 'open' || name === 'cached_open') return { messages: [] };
    return rpcAnswer(name);
  }, 'thread-1');
  try {
    await wait(50);
    view.flush();
    assert.equal(view.host.querySelectorAll('.ui-row .ui-profile-link').length, 0, 'the list name is not a profile link');
    const openNamed = async (name: string) => {
      const row = [...view.host.querySelectorAll('.ui-row')].find(entry => entry.querySelector('.ui-row-open-hit')?.getAttribute('aria-label') === `Open ${name}`);
      assert.ok(row, name);
      click(row.querySelector('.ui-row-open-hit')!);
      await wait(50);
      view.flush();
    };
    const back = async () => {
      click(view.host.querySelector('[aria-label="Back to inbox"]')!);
      await wait(30);
      view.flush();
    };
    await openNamed('Ada Lovelace');
    const header = view.host.querySelector('.ui-conversation-header')!;
    const name = header.querySelector('h3 .ui-profile-link');
    assert.equal(name?.textContent, 'Ada Lovelace');
    assert.equal(name?.getAttribute('href'), null);
    assert.equal(header.querySelector('.ui-conversation-meta')?.tagName, 'SPAN');
    name?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, metaKey: true }));
    await wait(30);
    view.flush();
    assert.equal(view.calls.some(call => call.name === 'open_profile'), false);
    assert.equal(view.browserTabs.some(tab => tab.kind === 'browser' && tab.url === same.profileUrl), true);
    await back();
    await openNamed('Project');
    const second = view.host.querySelector('.ui-conversation-header')!;
    assert.equal(second.querySelector('h3 .ui-profile-link'), null);
    assert.equal(second.querySelector('h3 .ui-conversation-name')?.textContent, 'Project');
    assert.equal(second.querySelector('.ui-conversation-meta')?.tagName, 'BUTTON');
    assert.equal(second.querySelector('.ui-conversation-meta')?.textContent, 'Ada Lovelace');
    await back();
    await openNamed('Plan');
    assert.equal(view.host.querySelector('.ui-conversation-header .ui-profile-link'), null);
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
