import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { bm25Rank, conversationText } from '../src/bm25.ts';

test('BM25 ranks the conversation that contains the rare term first', () => {
  const ranked = bm25Rank('invoice', [
    { id: 'a', text: 'lunch plans for friday' },
    { id: 'b', text: 'please pay the invoice attached' },
    { id: 'c', text: 'invoice invoice invoice from the vendor' },
  ]);
  assert.deepEqual(ranked.map(row => row.id), ['c', 'b']);
  assert.ok(ranked[0].score > ranked[1].score);
});

test('an empty query matches nothing', () => {
  assert.deepEqual(bm25Rank('  ', [{ id: 'a', text: 'hello there' }]), []);
});

test('cached message text is part of the search document', () => {
  const text = conversationText({ title: 'Hello', preview: 'See below', messages: [{ sender: 'Ada', text: 'the ledger is ready', subject: 'Books' }] });
  assert.match(text, /ledger/);
  assert.match(text, /Books/);
});
