import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { bm25Rank, bm25RankPrepared, conversationText, prepareDocument } from '../src/bm25.ts';

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

test('recipients and attachment names are searchable', () => {
  const text = conversationText({
    title: 'Quarterly report',
    recipients: 'ada@example.com, finance@example.com',
    attachments: ['Brochure.pdf'],
    preview: 'See attached',
    messages: [{ sender: 'Ada', subject: 'Q3', to: 'bob@example.com', cc: 'finance@example.com', text: 'numbers', attachments: ['Q3 report.pdf'] }],
  });
  assert.match(text, /bob@example\.com/);
  assert.match(text, /finance@example\.com/);
  assert.match(text, /Brochure\.pdf/);
  assert.match(text, /Q3 report\.pdf/);
});

test('a query prefix matches while the word is still being typed', () => {
  const docs = [
    { id: 'marnix', text: 'Marnix: Ja' },
    { id: 'jan', text: 'Jan: Nee' },
    { id: 'marnie', text: 'Marnie: Later' },
  ];
  assert.deepEqual(bm25Rank('Marn', docs).map(row => row.id).sort(), ['marnie', 'marnix']);
  assert.deepEqual(bm25Rank('Marni', docs).map(row => row.id).sort(), ['marnie', 'marnix']);
  assert.deepEqual(bm25Rank('Marnix', docs).map(row => row.id), ['marnix']);
  assert.deepEqual(bm25Rank('zzz', docs), []);
});

test('a full-token match outranks an otherwise equal prefix-only match', () => {
  const ranked = bm25Rank('marn', [
    { id: 'prefix', text: 'marnix' },
    { id: 'exact', text: 'marn' },
  ]);
  assert.deepEqual(ranked.map(row => row.id), ['exact', 'prefix']);
  assert.ok(ranked[0].score > ranked[1].score);
});

test('prepared documents rank the same as raw documents', () => {
  const docs = [
    { id: 'a', text: 'Marnix: Ja' },
    { id: 'b', text: 'Jan: Nee' },
    { id: 'c', text: 'Marnie: Later' },
  ];
  const prepared = docs.map(doc => prepareDocument(doc.id, doc.text));
  assert.deepEqual(bm25RankPrepared('Marn', prepared), bm25Rank('Marn', docs));
});

test('one-character queries are ignored', () => {
  assert.deepEqual(bm25Rank('M', [{ id: 'a', text: 'Marnix' }]), []);
});
