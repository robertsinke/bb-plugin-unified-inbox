import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { messagesAfterMail, messagesAfterSend } from '../src/sent-message.ts';

test('shows the sent WhatsApp text before the server has stored it', () => {
  const shown = messagesAfterSend([{ sender: 'Ada', text: 'Hi', date: 1 }], 'On my way', 2);
  assert.deepEqual(shown.at(-1), { sender: 'You', text: 'On my way', date: 2, fromMe: true });
});

test('does not duplicate a sent message the reload already returned', () => {
  const stored = [{ sender: 'You', text: 'On my way', date: 2, fromMe: true }];
  assert.deepEqual(messagesAfterSend(stored, 'On my way', 3), stored);
});

type MailRow = { sender: string; text: string; date: number; fromMe?: boolean; gmailId?: string; attachments?: string[] };

test('shows a Gmail reply before the thread reload has stored it', () => {
  const before: MailRow[] = [{ sender: 'Ada', text: 'The plan', date: 1 }];
  const shown = messagesAfterMail(before, before, { text: 'On it.', attachmentNames: [] }, 10);
  assert.deepEqual(shown.at(-1), { sender: 'You', text: 'On it.', date: 10, fromMe: true });
});

test('a stored Gmail reply replaces the temporary line, including when the body quotes the thread', () => {
  const before: MailRow[] = [{ sender: 'Ada', text: 'The plan', date: 1 }];
  const stored: MailRow[] = [...before, { sender: 'Me <me@example.com>', text: 'On it.\n\nOn Mon Ada wrote:\n> The plan', date: 50, gmailId: 'm2' }];
  const shown = messagesAfterMail(before, stored, { text: 'On it.', attachmentNames: [] }, 60);
  assert.equal(shown.length, 2);
  assert.equal(shown.some(message => message.fromMe), false);
});

test('one new Gmail row is the send even when its text is only a snippet', () => {
  const before: MailRow[] = [{ sender: 'Ada', text: 'The plan', date: 1 }];
  const stored: MailRow[] = [...before, { sender: 'Me <me@example.com>', text: 'Sent the file', date: 50, gmailId: 'm2', attachments: ['plan.pdf'] }];
  const shown = messagesAfterMail(before, stored, { text: '', attachmentNames: ['plan.pdf'] }, 60);
  assert.equal(shown.length, 2);
  assert.equal(shown.some(message => message.fromMe), false);
});
