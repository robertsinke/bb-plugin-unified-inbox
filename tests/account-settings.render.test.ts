// The settings section is the connect screen: four source blocks, and no secret leaves the page.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';

import { loadComponent } from './jsdom-harness.ts';

const require = createRequire(import.meta.url);
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost' });
install(dom);

const { PAIRING_POLL_MS } = loadComponent('src/account-settings.tsx', {
  '@get-bb/plugin-sdk/app': { useRpc: () => ({ call: async () => null }) },
});
const { EXPOSURE_NOTE } = loadComponent('src/whatsapp-pairing.tsx');
const { flushSync } = require('react-dom');
const React = require('react');
const { createRoot } = require('react-dom/client');

const QR = '2@abcdefghijklmnop,0123456789abcdef+QR+payload==';

type Call = { name: string; input: unknown };
type Status = {
  clientConfigured: boolean;
  mailboxes: Array<{ account: string; present: boolean; hasRefreshToken: boolean; lastError?: { at: number; message: string } }>;
  whatsapp: { state: string; qr?: string; expiresAt?: number; code?: string; message?: string };
  linkedin: { lastAttemptAt: number | null; lastSuccessAt: number | null; lastError: string | null; cacheFallback: boolean };
  messages: string;
};

function status(overrides: Partial<Status> = {}): Status {
  return {
    clientConfigured: true,
    mailboxes: [{ account: 'ada@example.com', present: true, hasRefreshToken: true }],
    whatsapp: { state: 'connected' },
    linkedin: { lastAttemptAt: 1, lastSuccessAt: 2, lastError: null, cacheFallback: false },
    messages: 'Messages is available.',
    ...overrides,
  };
}

function mount(handler: (name: string, input: unknown) => unknown) {
  const calls: Call[] = [];
  const call = (name: string, input: unknown) => {
    calls.push({ name, input });
    return handler(name, input);
  };
  const stub = { useRpc: () => ({ call }) };
  const { AccountSettings: Section } = loadComponent('src/account-settings.tsx', { '@get-bb/plugin-sdk/app': stub });
  const host = dom.window.document.createElement('div');
  dom.window.document.body.append(host);
  const root = createRoot(host);
  flushSync(() => root.render(React.createElement(Section)));
  let gone = false;
  return {
    host,
    calls,
    named(name: string) { return calls.filter(item => item.name === name); },
    async settle() {
      await new Promise(resolve => setTimeout(resolve, 30));
      flushSync(() => {});
    },
    click(label: string) {
      const button = [...host.querySelectorAll('button')].find(item => item.textContent === label);
      assert.ok(button, label);
      flushSync(() => button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
    },
    unmount() {
      if (gone) return;
      gone = true;
      flushSync(() => root.unmount());
      host.remove();
    },
  };
}

test('the settings section does not import the inbox, and cancel is not an agent tool', () => {
  const source = readFileSync(new URL('../src/account-settings.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /from ['"][^'"]*inbox/);
  assert.doesNotMatch(source, /from ['"](?:\.\/|\.\.\/)app['"]/);
  const tools = readFileSync(new URL('../src/inbox-agent-tools.ts', import.meta.url), 'utf8');
  assert.equal(tools.includes('gmail_connect_cancel'), false);
});

test('the plugin app registers the accounts section', () => {
  let section: { id?: string; title?: string; description?: string; component?: { name?: string } } | undefined;
  loadComponent('app.tsx', {
    '@get-bb/plugin-sdk/app': {
      definePluginApp: (define: (app: { slots: { experimental_tab: () => void; settingsSection: (value: typeof section) => void } }) => void) => {
        define({ slots: { experimental_tab: () => {}, settingsSection: value => { section = value; } } });
      },
      experimental_Icon: () => null,
      ThreadChat: () => null,
      useRpc: () => ({ call: async () => null }),
      useSdk: () => ({}),
      useBbNavigate: () => ({}),
      useComposers: () => [],
    },
  });
  assert.equal(section?.id, 'accounts');
  assert.equal(section?.title, 'Accounts');
  assert.match(section?.description ?? '', /client id and secret/);
  assert.equal(section?.component?.name, 'AccountSettings');
});

test('status with one mailbox, a connected WhatsApp, a LinkedIn success, and Messages renders four blocks and no QR', async () => {
  const view = mount(name => name === 'connection_status' ? status() : null);
  try {
    await view.settle();
    assert.equal(view.host.querySelectorAll('.ui-account-block').length, 4);
    assert.equal(view.host.querySelector('svg.ui-qr'), null);
    assert.match(view.host.textContent ?? '', /ada@example\.com/);
    assert.match(view.host.textContent ?? '', /WhatsApp is connected on this machine/);
    assert.match(view.host.textContent ?? '', /LinkedIn is connected/);
    assert.doesNotMatch(view.host.textContent ?? '', /unverified-app/);
    assert.match(view.host.textContent ?? '', /does not grant that permission/);
    assert.match(view.host.textContent ?? '', /Messages is available/);
    assert.equal(view.host.querySelector('.ui-messages-status')?.parentElement?.querySelector('button'), null);
    assert.deepEqual([...view.host.querySelectorAll('button')].map(button => button.textContent).filter(text => text === 'Unpair'), ['Unpair']);
  } finally {
    view.unmount();
  }
});

test('LinkedIn with no read yet says sign-in is still required', async () => {
  const view = mount(name => name === 'connection_status' ? status({
    linkedin: { lastAttemptAt: null, lastSuccessAt: null, lastError: null, cacheFallback: false },
  }) : null);
  try {
    await view.settle();
    assert.match(view.host.textContent ?? '', /Sign-in is still required/);
    assert.equal(view.host.textContent?.includes('The last read worked'), false);
  } finally {
    view.unmount();
  }
});

test('a missing client disables Add and sends no connect call', async () => {
  const view = mount(name => name === 'connection_status' ? status({ clientConfigured: false, mailboxes: [] }) : null);
  try {
    await view.settle();
    const add = [...view.host.querySelectorAll('button')].find(button => button.textContent === 'Add');
    assert.equal(add?.disabled, true);
    assert.match(view.host.textContent ?? '', /People API/);
    assert.match(view.host.textContent ?? '', /7 days/);
    assert.match(view.host.textContent ?? '', /unverified-app/);
    view.click('Add');
    assert.equal(view.named('gmail_connect').length, 0);
  } finally {
    view.unmount();
  }
});

test('Add sends no replace flag, and a success reads status again', async () => {
  let reads = 0;
  const view = mount(name => {
    if (name === 'gmail_connect') return { account: 'bea@example.com', replaced: false, alreadyConnected: false };
    if (name === 'connection_status') {
      reads += 1;
      return status(reads > 1 ? { mailboxes: [{ account: 'bea@example.com', present: true, hasRefreshToken: true }] } : {});
    }
    return null;
  });
  try {
    await view.settle();
    view.click('Add');
    await view.settle();
    assert.deepEqual(view.named('gmail_connect').map(call => call.input), [null]);
    assert.equal(view.named('connection_status').length, 2);
    assert.match(view.host.textContent ?? '', /bea@example\.com/);
  } finally {
    view.unmount();
  }
});

test('Add says the mailbox is already connected when Google returns a listed address', async () => {
  const view = mount(name => {
    if (name === 'connection_status') return status();
    if (name === 'gmail_connect') return { account: 'ada@example.com', replaced: false, alreadyConnected: true };
    return null;
  });
  try {
    await view.settle();
    view.click('Add');
    await view.settle();
    assert.deepEqual(view.named('gmail_connect').map(call => call.input), [null]);
    assert.match(view.host.textContent ?? '', /This mailbox is already connected/);
    assert.ok(view.host.querySelector('[data-account="ada@example.com"]'));
  } finally {
    view.unmount();
  }
});

test('Add stays disabled while the browser is open, and Cancel calls gmail_connect_cancel', async () => {
  let rejectConnect: (error: Error) => void = () => {};
  const view = mount(name => {
    if (name === 'connection_status') return status({ mailboxes: [] });
    if (name === 'gmail_connect') return new Promise((_resolve, reject) => { rejectConnect = reject; });
    if (name === 'gmail_connect_cancel') return { cancelled: true };
    return null;
  });
  try {
    await view.settle();
    view.click('Add');
    const add = [...view.host.querySelectorAll('button')].find(button => button.textContent === 'Add');
    assert.equal(add?.disabled, true);
    assert.match(view.host.textContent ?? '', /The system browser is open/);
    view.click('Cancel');
    assert.deepEqual(view.named('gmail_connect_cancel').map(call => call.input), [null]);
    rejectConnect(new Error('Gmail sign-in was cancelled. Nothing was written.'));
    await view.settle();
    assert.match(view.host.textContent ?? '', /Gmail sign-in was cancelled/);
  } finally {
    view.unmount();
  }
});

test('a timeout and an unnamed account stay on the Gmail block', async () => {
  const errors = [
    'Gmail sign-in timed out. Nothing was written.',
    'Gmail sign-in could not read the mailbox address. Nothing was written.',
  ];
  for (const message of errors) {
    const view = mount(name => {
      if (name === 'connection_status') return status({ mailboxes: [] });
      if (name === 'gmail_connect') return Promise.reject(new Error(message));
      return null;
    });
    try {
      await view.settle();
      view.click('Add');
      await view.settle();
      assert.match(view.host.textContent ?? '', new RegExp(message.replace(/[.]/g, '\\.')));
      assert.equal(view.named('gmail_remove').length, 0);
    } finally {
      view.unmount();
    }
  }
});

test('leaving the page during sign-in does not cancel and does not remove a mailbox', async () => {
  const view = mount(name => {
    if (name === 'connection_status') return status();
    if (name === 'gmail_connect') return new Promise(() => {});
    return null;
  });
  try {
    await view.settle();
    view.click('Add');
    view.unmount();
    assert.equal(view.named('gmail_connect_cancel').length, 0);
    assert.equal(view.named('gmail_remove').length, 0);
  } finally {
    view.unmount();
  }
});

test('a legacy id and invalid_grant include the Testing-client sentence', async () => {
  const view = mount(name => name === 'connection_status' ? status({
    mailboxes: [{ account: 'gmail-personal', present: true, hasRefreshToken: true, lastError: { at: 1, message: 'invalid_grant' } }],
  }) : null);
  try {
    await view.settle();
    const row = view.host.querySelector('[data-account="gmail-personal"]');
    assert.match(row?.textContent ?? '', /gmail-personal/);
    assert.match(row?.textContent ?? '', /invalid_grant/);
    assert.match(row?.textContent ?? '', /A Testing client expires after 7 days/);
  } finally {
    view.unmount();
  }
});

test('Reconnect confirm sends replace true, and dismiss sends nothing', async () => {
  const dismissed = mount(name => name === 'connection_status' ? status() : null);
  try {
    await dismissed.settle();
    dismissed.click('Reconnect');
    assert.match(dismissed.host.textContent ?? '', /replaces the local file for the Google account that answers/);
    assert.match(dismissed.host.textContent ?? '', /A Testing client expires after 7 days/);
    dismissed.click('Dismiss');
    assert.equal(dismissed.named('gmail_connect').length, 0);
  } finally {
    dismissed.unmount();
  }

  const view = mount(name => {
    if (name === 'connection_status') return status();
    if (name === 'gmail_connect') return { account: 'ada@example.com', replaced: true, alreadyConnected: false };
    return null;
  });
  try {
    await view.settle();
    view.click('Reconnect');
    view.click('Confirm');
    await view.settle();
    assert.deepEqual(view.named('gmail_connect').map(call => call.input), [{ replace: true }]);
  } finally {
    view.unmount();
  }
});

test('Remove confirmation calls gmail_remove, and dismiss sends nothing', async () => {
  const dismissed = mount(name => name === 'connection_status' ? status() : null);
  try {
    await dismissed.settle();
    dismissed.click('Remove');
    assert.match(dismissed.host.textContent ?? '', /deletes the local credential/);
    dismissed.click('Dismiss');
    assert.equal(dismissed.named('gmail_remove').length, 0);
    assert.ok(dismissed.host.querySelector('[data-account="ada@example.com"]'));
  } finally {
    dismissed.unmount();
  }

  let rows = [{ account: 'ada@example.com', present: true, hasRefreshToken: true }];
  const view = mount((name, input) => {
    if (name === 'gmail_remove') {
      assert.deepEqual(input, { account: 'ada@example.com' });
      rows = [];
      return { removed: true };
    }
    if (name === 'connection_status') return status({ mailboxes: rows });
    return null;
  });
  try {
    await view.settle();
    view.click('Remove');
    view.click('Confirm');
    await view.settle();
    assert.equal(view.named('gmail_remove').length, 1);
    assert.equal(view.host.querySelector('[data-account="ada@example.com"]'), null);
  } finally {
    view.unmount();
  }
});

test('a QR snapshot shows the ban warning, and pair calls whatsapp_pairing', async () => {
  const shown = mount(name => name === 'connection_status' ? status({ whatsapp: { state: 'qr', qr: QR, expiresAt: 1 } }) : null);
  try {
    await shown.settle();
    assert.equal(shown.host.querySelector('.ui-pairing-note')?.textContent, EXPOSURE_NOTE);
    assert.ok(shown.host.querySelector('svg.ui-qr'));
  } finally {
    shown.unmount();
  }

  const view = mount(name => {
    if (name === 'connection_status') return status({ whatsapp: { state: 'unpaired' } });
    if (name === 'whatsapp_pairing') return { state: 'connecting' };
    return null;
  });
  try {
    await view.settle();
    view.click('Show the QR code');
    assert.deepEqual(view.named('whatsapp_pairing').map(call => call.input), [{ op: 'pair' }]);
  } finally {
    view.unmount();
  }
});

test('connected WhatsApp renders Unpair and not a QR; dismiss sends nothing; confirm unpairs', async () => {
  const dismissed = mount(name => name === 'connection_status' ? status() : null);
  try {
    await dismissed.settle();
    assert.equal(dismissed.host.querySelector('svg.ui-qr'), null);
    dismissed.click('Unpair');
    assert.equal(dismissed.host.textContent?.includes(EXPOSURE_NOTE), true);
    dismissed.click('Dismiss');
    assert.equal(dismissed.named('whatsapp_pairing').length, 0);
    assert.equal(dismissed.host.textContent?.includes('WhatsApp is connected'), true);
  } finally {
    dismissed.unmount();
  }

  const view = mount(name => {
    if (name === 'connection_status') return status();
    if (name === 'whatsapp_pairing') return { state: 'unpaired' };
    return null;
  });
  try {
    await view.settle();
    assert.equal(view.host.querySelector('svg.ui-qr'), null);
    view.click('Unpair');
    view.click('Confirm');
    await view.settle();
    assert.deepEqual(view.named('whatsapp_pairing').map(call => call.input), [{ op: 'unpair' }]);
  } finally {
    view.unmount();
  }
});

test('unmount during a QR does not send unpair or close, and the poll stops', async () => {
  const polls = watchPairingPoll();
  const view = mount(name => {
    if (name === 'connection_status') return status({ whatsapp: { state: 'qr', qr: QR, expiresAt: 1 } });
    if (name === 'whatsapp_pairing') return { state: 'qr', qr: QR, expiresAt: 2 };
    return null;
  });
  try {
    await view.settle();
    assert.equal(polls.length, 1);
    polls[0].fn();
    await view.settle();
    assert.deepEqual(view.named('whatsapp_pairing').map(call => call.input), [null]);
    view.unmount();
    assert.equal(polls[0].cleared, true);
    assert.equal(JSON.stringify(view.calls).includes('unpair'), false);
    assert.equal(JSON.stringify(view.calls).includes('close'), false);
  } finally {
    view.unmount();
    polls.restore();
  }
});

test('a connected snapshot does not poll pairing', async () => {
  const polls = watchPairingPoll();
  const view = mount(name => name === 'connection_status' ? status() : null);
  try {
    await view.settle();
    assert.equal(polls.length, 0);
    assert.equal(view.named('whatsapp_pairing').length, 0);
  } finally {
    view.unmount();
    polls.restore();
  }
});

test('an empty Messages line uses the install instruction and has no grant button', async () => {
  const view = mount(name => name === 'connection_status' ? status({ messages: '' }) : null);
  try {
    await view.settle();
    assert.equal(view.host.querySelector('.ui-messages-status'), null);
    assert.match(view.host.querySelector('.ui-messages-install')?.textContent ?? '', /does not install imsg/);
    assert.match(view.host.querySelector('.ui-messages-install')?.textContent ?? '', /Full Disk Access/);
    assert.equal(view.host.querySelector('.ui-messages-install')?.parentElement?.querySelector('button'), null);
  } finally {
    view.unmount();
  }
});

test('LinkedIn sign-in shows the opening line, then the last read, and does not show the profile', async () => {
  let release: (value: unknown) => void = () => {};
  let reads = 0;
  const profile = '/tmp/secret-cookie-jar';
  const view = mount(name => {
    if (name === 'connection_status') {
      reads += 1;
      return status({
        linkedin: reads === 1
          ? { lastAttemptAt: 1, lastSuccessAt: null, lastError: 'Sign in to LinkedIn once.', cacheFallback: false }
          : { lastAttemptAt: 2, lastSuccessAt: 3, lastError: null, cacheFallback: false },
      });
    }
    if (name === 'linkedin_signin') return new Promise(resolve => { release = resolve; });
    return null;
  });
  try {
    await view.settle();
    assert.match(view.host.textContent ?? '', /Sign in to LinkedIn once/);
    view.click('Sign in');
    const button = [...view.host.querySelectorAll('button')].find(item => item.textContent === 'Sign in');
    assert.equal(button?.disabled, true);
    assert.match(view.host.textContent ?? '', /The sign-in window is opening/);
    release({ profile, message: `opened ${profile}` });
    await view.settle();
    assert.match(view.host.textContent ?? '', /LinkedIn is connected/);
    assert.doesNotMatch(view.host.textContent ?? '', /unverified-app/);
    assert.match(view.host.textContent ?? '', /does not grant that permission/);
    assert.equal(view.host.textContent?.includes(profile), false);
    assert.match(view.host.textContent ?? '', /ada@example\.com/);
  } finally {
    view.unmount();
  }
});

test('a LinkedIn sign-in failure stays on that row and leaves the Gmail row', async () => {
  const view = mount(name => {
    if (name === 'connection_status') return status();
    if (name === 'linkedin_signin') return Promise.reject(new Error('LinkedIn sign-in failed.'));
    return null;
  });
  try {
    await view.settle();
    view.click('Sign in');
    await view.settle();
    assert.match(view.host.querySelector('.ui-linkedin-status')?.textContent ?? '', /LinkedIn sign-in failed/);
    assert.ok(view.host.querySelector('[data-account="ada@example.com"]'));
    assert.equal(view.named('connection_status').length, 1);
  } finally {
    view.unmount();
  }
});

type Poll = { fn: () => void; cleared: boolean };

function watchPairingPoll(): Poll[] & { restore: () => void } {
  const realSet = globalThis.setInterval;
  const realClear = globalThis.clearInterval;
  const polls: Poll[] = [];
  let seq = 1_000_000;
  globalThis.setInterval = ((fn: TimerHandler, ms?: number, ...rest: unknown[]) => {
    if (ms === PAIRING_POLL_MS && typeof fn === 'function') {
      const id = seq++;
      polls.push({ fn: () => { fn(); }, cleared: false });
      return id as unknown as ReturnType<typeof setInterval>;
    }
    return realSet(fn, ms as number, ...(rest as []));
  }) as typeof setInterval;
  globalThis.clearInterval = ((id?: ReturnType<typeof setInterval>) => {
    const index = typeof id === 'number' ? id - 1_000_000 : -1;
    const row = polls[index];
    if (row) { row.cleared = true; return; }
    realClear(id as ReturnType<typeof setInterval>);
  }) as typeof clearInterval;
  return Object.assign(polls, {
    restore() {
      globalThis.setInterval = realSet;
      globalThis.clearInterval = realClear;
    },
  });
}

function install(page: JSDOM): void {
  const keys = ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'MouseEvent'] as const;
  const define = (key: string, value: unknown) => Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  define('window', page.window);
  define('document', page.window.document);
  for (const key of keys) {
    const value = (page.window as unknown as Record<string, unknown>)[key];
    if (value !== undefined) define(key, value);
  }
}
