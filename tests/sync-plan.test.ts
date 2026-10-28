import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { gmailCursorUnchanged, gmailIdsToFetch, whatsappListUnchanged } from '../src/sync-plan.ts';

test('an unchanged Gmail history cursor skips thread downloads', () => {
  assert.equal(gmailCursorUnchanged('10', '10'), true);
  assert.equal(gmailCursorUnchanged('10', '11'), false);
  assert.equal(gmailCursorUnchanged(null, '10'), false);
});

test('only new or revised Gmail threads are fetched', () => {
  const known = [
    { id: 'a', historyId: '1', preview: 'old' },
    { id: 'b', historyId: '', preview: 'same' },
  ];
  const ids = gmailIdsToFetch(known, [
    { id: 'a', historyId: '1', snippet: 'old' },
    { id: 'b', historyId: '', snippet: 'same' },
    { id: 'c', historyId: '3', snippet: 'new' },
    { id: 'a', historyId: '2', snippet: 'edited' },
  ]);
  assert.deepEqual(ids, ['c', 'a']);
});

test('a WhatsApp list with the same stamps needs no rewrite', () => {
  const row = { id: 'jid', date: 5, preview: 'hi', unread: true };
  assert.equal(whatsappListUnchanged([row], [row]), true);
  assert.equal(whatsappListUnchanged([row], [{ ...row, preview: 'hey' }]), false);
});
