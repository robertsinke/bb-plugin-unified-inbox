import assert from 'node:assert/strict';
import test from 'node:test';

import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';

const require = createRequire(import.meta.url);

import { loadComponent } from './jsdom-harness.ts';

/**
 * A render test, not a contract test: the composer is mounted in a real DOM and the owner's controls
 * are found the way the owner finds them. The harness transpiles the component; the plugin SDK is
 * stubbed, because what is being tested is the form, not the host.
 */
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost' });
install(dom);

function mount(mail: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { flushSync } = require('react-dom');
  const { MailComposer } = loadComponent('src/mail-composer.tsx', { '@get-bb/plugin-sdk/app': { experimental_Icon: () => null } });

  const calls: { sent: number; discarded: number; fields: unknown[]; attached: unknown[]; detached: number[]; taken: string[] } = {
    sent: 0, discarded: 0, fields: [], attached: [], detached: [], taken: [],
  };
  const draft = { account: 'personal', to: '', cc: '', bcc: '', subject: '', text: '', attachments: [], ...mail };
  const element = React.createElement(MailComposer, {
    mail: draft,
    accountLabel: 'Personal Gmail',
    busy: false,
    status: '',
    sendIcon: null,
    onField: (patch: unknown) => calls.fields.push(patch),
    onAttach: (file: unknown) => calls.attached.push(file),
    onDetach: (index: number) => calls.detached.push(index),
    onDiscard: () => { calls.discarded += 1; },
    onSend: () => { calls.sent += 1; },
    ...overrides,
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
  return { root, document, calls, dom, done };
}

/** jsdom owns the globals React reads. Installed once, kept for the whole file. */
function install(dom: JSDOM): void {
  const keys = ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'MouseEvent', 'File', 'FileList', 'FileReader', 'DataTransfer'] as const;
  // `navigator` is a getter on the Node global, so globals are defined rather than assigned.
  const define = (key: string, value: unknown) => Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  define('window', dom.window);
  define('document', dom.window.document);
  for (const key of keys) {
    const value = (dom.window as any)[key];
    if (value !== undefined) define(key, value);
  }
}

test('the composer shows every address field, the body, and the file control', () => {
  const { document, calls, done } = mount({});
  try {
    const labels = [...document.querySelectorAll('.ui-mail-fields label')].map(label => label.textContent?.trim());
    assert.deepEqual(labels, ['To', 'Cc', 'Bcc', 'Subject'], 'the four fields a mail draft needs, in that order');
    assert.ok(document.querySelector('.ui-mail-body'), 'the body is where the owner types');
    assert.ok(document.querySelector('input[type="file"]'), 'a file can be picked');
    assert.equal(document.querySelector('.ui-mail-composer')?.getAttribute('aria-label'), 'Personal Gmail draft');
  } finally {
    done();
  }
});

test('a draft with files shows each one by name and size, and each can be taken back off', () => {
  const { document, calls, done } = mount({
    attachments: [
      { name: 'plan.pdf', mimeType: 'application/pdf', size: 2048, data: 'aGVsbG8=' },
      { name: 'notes.txt', mimeType: 'text/plain', size: 12, data: 'aGVsbG8=' },
    ],
  });
  try {
    const chips = [...document.querySelectorAll('.ui-attachment-chip')].map(chip => [...chip.children].map(part => part.textContent?.trim()).join(' | '));
    assert.deepEqual(chips, ['plan.pdf | 2 KB | ×', 'notes.txt | 12 B | ×'], 'a size reads as a size, and the small one is not rounded up to a kilobyte');

    const drops = [...document.querySelectorAll('.ui-attachment-drop')] as any[];
    drops[1].dispatchEvent(new (document.defaultView as any).MouseEvent('click', { bubbles: true }));
    assert.deepEqual(calls.detached, [1], 'removing the second file names the second file');
  } finally {
    done();
  }
});

test('a file already in the conversation is offered, and taking it is the media reader’s job, not the form’s', () => {
  const { document, calls, done } = mount({}, {
    fromThread: { names: ['plan.pdf'], taking: '', onTake: (name: string) => calls.taken.push(name) },
  });
  try {
    const offer = document.querySelector('.ui-attachment-take') as any;
    assert.equal(offer?.textContent?.trim(), '+ plan.pdf');
    offer.dispatchEvent(new (document.defaultView as any).MouseEvent('click', { bubbles: true }));
    assert.deepEqual(calls.taken, ['plan.pdf']);
  } finally {
    done();
  }
});

test('submitting and discarding are the panel’s decisions, and the form only reports them', () => {
  const { document, calls, done } = mount({ to: 'a@example.com', text: 'Hello' });
  try {
    const buttons = [...document.querySelectorAll('.ui-mail-actions .ui-text-button')] as any[];
    const discard = buttons.find(button => button.textContent?.trim() === 'Discard')!;
    discard.dispatchEvent(new (document.defaultView as any).MouseEvent('click', { bubbles: true }));
    assert.equal(calls.discarded, 1, 'the form does not confirm by itself; the panel owns that question');

    const form = document.querySelector('.ui-mail-composer') as any;
    form.dispatchEvent(new (document.defaultView as any).Event('submit', { bubbles: true, cancelable: true }));
    assert.equal(calls.sent, 1);
  } finally {
    done();
  }
});
