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

const { flushSync } = require('react-dom');

function mount(mail: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { MailComposer } = loadComponent('src/mail-composer.tsx', { '@get-bb/plugin-sdk/app': { experimental_Icon: () => null } });

  const calls: { sent: number; discarded: number; fields: unknown[]; attached: unknown[]; detached: number[]; taken: string[] } = {
    sent: 0, discarded: 0, fields: [], attached: [], detached: [], taken: [],
  };
  const draft = { account: 'gmail-personal', to: '', cc: '', bcc: '', subject: '', text: '', attachments: [], ...mail };
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

/**
 * jsdom ships no DataTransfer and no DragEvent, so a drag is an ordinary event carrying the transfer
 * the browser would: the form reads `event.dataTransfer.files`, and that is all this hands it.
 */
function dragTo(document: Document, type: string, files: unknown[] = []): any {
  const event = new (document.defaultView as any).Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: { files }, configurable: true });
  return event;
}

/** A FileReader answers a task later, so the drop's callback lands after the dispatch returns. */
async function until(check: () => boolean): Promise<void> {
  for (let tries = 0; tries < 200 && !check(); tries += 1) await new Promise(resolve => setTimeout(resolve, 5));
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
    const discard = document.querySelector('.ui-mail-actions [aria-label="Discard"]') as any;
    discard.dispatchEvent(new (document.defaultView as any).MouseEvent('click', { bubbles: true }));
    assert.equal(calls.discarded, 1, 'the form does not confirm by itself; the panel owns that question');

    const form = document.querySelector('.ui-mail-composer') as any;
    form.dispatchEvent(new (document.defaultView as any).Event('submit', { bubbles: true, cancelable: true }));
    assert.equal(calls.sent, 1);
  } finally {
    done();
  }
});

test('the send control is dead until there is a recipient and something to say, then it is the panel’s to confirm', () => {
  const empty = mount({});
  try {
    const send = empty.document.querySelector('.ui-prompt-send') as any;
    assert.equal(send.disabled, true, 'nothing to send yet');
  } finally {
    empty.done();
  }

  const ready = mount({ to: 'a@example.com', text: 'Hello' });
  try {
    const send = ready.document.querySelector('.ui-prompt-send') as any;
    assert.equal(send.disabled, false, 'Gmail sending is enabled, so the control is live');
    (ready.document.querySelector('.ui-mail-composer') as any).dispatchEvent(new (ready.dom.window as any).Event('submit', { bubbles: true, cancelable: true }));
    assert.equal(ready.calls.sent, 1, 'and the form only reports the press');
  } finally {
    ready.done();
  }

  const fileOnly = mount({ to: 'a@example.com', attachments: [{ name: 'plan.pdf', mimeType: 'application/pdf', size: 4, data: 'aGVsbG8=' }] });
  try {
    assert.equal((fileOnly.document.querySelector('.ui-prompt-send') as any).disabled, false, 'a file with no words is still a message');
  } finally {
    fileOnly.done();
  }
});

test('a file dragged onto the draft is taken the way a picked one is, and the drag never leaves the panel', async () => {
  const { document, calls, done, dom } = mount({});
  try {
    const form = document.querySelector('.ui-mail-composer') as any;
    const described = document.getElementById(form.getAttribute('aria-describedby'))?.textContent ?? '';
    assert.match(described, /dropped/, 'a screen reader is told the draft takes dropped files, and Attach stays the keyboard path');

    // Uncancelled, the browser opens the dropped file and the panel is gone: this is the drag being claimed.
    assert.equal(form.dispatchEvent(dragTo(document, 'dragover')), false, 'dragover is cancelled');
    await until(() => form.classList.contains('is-dropping'));
    assert.ok(form.classList.contains('is-dropping'), 'and the form shows it is the drop target');

    const file = new dom.window.File(['hello'], 'plan.txt', { type: 'text/plain' });
    assert.equal(form.dispatchEvent(dragTo(document, 'drop', [file])), false, 'so is the drop');
    await until(() => calls.attached.length > 0);

    assert.deepEqual(calls.attached, [{ name: 'plan.txt', mimeType: 'text/plain', size: 5, data: 'aGVsbG8=' }], 'the bytes arrive once, read exactly as the picker reads them');
    await until(() => !form.classList.contains('is-dropping'));
    assert.equal(form.classList.contains('is-dropping'), false, 'and the drop state is cleared');
  } finally {
    done();
  }
});

test('a drop carrying no file is ignored, and the draft it was dropped on stays', async () => {
  const { document, calls, done } = mount({ to: 'a@example.com', text: 'Half written' });
  try {
    const form = document.querySelector('.ui-mail-composer') as any;
    form.dispatchEvent(dragTo(document, 'dragover'));
    await until(() => form.classList.contains('is-dropping'));

    form.dispatchEvent(dragTo(document, 'drop', [])); // a dragged link or a snippet, not a file
    await new Promise(resolve => setTimeout(resolve, 20));

    assert.deepEqual(calls.attached, [], 'nothing is attached');
    assert.deepEqual(calls.fields, [], 'the draft is untouched');
    assert.equal(calls.discarded, 0, 'and it is not thrown away');
    assert.equal((document.querySelector('.ui-mail-body') as any)?.value, 'Half written', 'the words are still there');
    await until(() => !form.classList.contains('is-dropping'));
    assert.equal(form.classList.contains('is-dropping'), false, 'the highlight clears when the drag ends');
  } finally {
    done();
  }
});

test('a drag over the form claims it, and the tint says so until the pointer leaves', async () => {
  const { document, dom, done } = mount({});
  try {
    const form = document.querySelector('.ui-mail-composer') as any;
    const dataTransfer = { files: [{ name: 'plan.txt' }] };
    const dragover: any = new (dom.window as any).Event('dragover', { bubbles: true, cancelable: true });
    Object.assign(dragover, { dataTransfer });
    form.dispatchEvent(dragover);
    assert.equal(dragover.defaultPrevented, true, 'the browser would otherwise open the file and the panel is gone');
    // `dragover` is a continuous event, so React batches its update into the next tick.
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.match(form.className, /is-dropping/, 'and the form shows it is the target');

    const leave: any = new (dom.window as any).Event('dragleave', { bubbles: true, cancelable: true });
    Object.assign(leave, { relatedTarget: document.body });
    form.dispatchEvent(leave);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.doesNotMatch(form.className, /is-dropping/, 'leaving the form ends it');
  } finally {
    done();
  }
});

/** The sentence a send whose outcome nobody knows comes back with: the form repeats it, it does not rewrite it. */
const UNKNOWN = 'Send failed or its outcome is unknown. Check Gmail Sent before trying again.';

test('opening a draft puts the cursor in the message', () => {
  const { document, done } = mount({ text: '\n\n---------- Forwarded message ----------\nHello' });
  try {
    const body = document.querySelector('.ui-mail-body') as HTMLTextAreaElement;
    assert.equal(document.activeElement, body, 'reply, reply-all and forward land in the message');
    assert.equal(body.selectionStart, 0, 'the cursor sits above any quoted text');
    assert.equal(body.selectionEnd, 0);
  } finally {
    done();
  }
});

test('a draft has no file hint, and only a send result takes the notice', () => {
  const drafting = mount({});
  try {
    assert.equal(drafting.document.querySelector('.ui-notice'), null, 'nothing has been sent, so nothing is reported');
    assert.equal(drafting.document.querySelector('.ui-composer-hint'), null, 'the draft does not explain itself under the controls');
  } finally {
    drafting.done();
  }

  const failed = mount({ to: 'a@example.com', text: 'Half written' }, { status: UNKNOWN });
  try {
    const notice = failed.document.querySelector('.ui-notice');
    assert.equal(notice?.textContent, UNKNOWN, 'a send that did not confirm keeps its sentence, word for word');
    assert.equal(notice?.getAttribute('role'), 'status', 'and it is announced, because it is the one thing worth reading');
    assert.equal(failed.document.querySelector('.ui-composer-hint'), null, 'the hint steps aside for it');
    assert.equal((failed.document.querySelector('.ui-mail-body') as any)?.value, 'Half written', 'the draft it could not send is still there');
  } finally {
    failed.done();
  }
});
