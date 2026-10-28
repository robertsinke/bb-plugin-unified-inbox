import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { messagesAfterSend } from '../src/sent-message.ts';

test('shows the sent WhatsApp text before the server has stored it', () => {
  const shown = messagesAfterSend([{ sender: 'Ada', text: 'Hi', date: 1 }], 'On my way', 2);
  assert.deepEqual(shown.at(-1), { sender: 'You', text: 'On my way', date: 2, fromMe: true });
});

test('does not duplicate a sent message the reload already returned', () => {
  const stored = [{ sender: 'You', text: 'On my way', date: 2, fromMe: true }];
  assert.deepEqual(messagesAfterSend(stored, 'On my way', 3), stored);
});
