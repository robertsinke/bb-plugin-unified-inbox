import assert from 'node:assert/strict';
import test from 'node:test';
import { inboxDraftKey, readInboxDraft, writeInboxDraft, type InboxDraftStorage } from '../src/inbox-drafts.ts';

function memoryStorage(): InboxDraftStorage {
  const values = new Map<string, string>();
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: key => { values.delete(key); },
  };
}

test('draft keys are isolated by source and conversation', () => {
  assert.notEqual(inboxDraftKey({ account: 'whatsapp', id: 'room:1' }), inboxDraftKey({ account: 'whatsapp', id: 'room:2' }));
  assert.notEqual(inboxDraftKey({ account: 'whatsapp', id: 'same' }), inboxDraftKey({ account: 'linkedin', id: 'same' }));
  assert.match(inboxDraftKey({ account: 'whatsapp', id: 'room:1' }), /room%3A1$/);
});

test('draft text persists and clearing removes only that conversation', () => {
  const storage = memoryStorage();
  const first = inboxDraftKey({ account: 'whatsapp', id: 'one' });
  const second = inboxDraftKey({ account: 'whatsapp', id: 'two' });
  assert.equal(writeInboxDraft(storage, first, 'keep this draft'), true);
  assert.equal(writeInboxDraft(storage, second, 'another draft'), true);
  assert.equal(readInboxDraft(storage, first), 'keep this draft');
  assert.equal(writeInboxDraft(storage, first, ''), true);
  assert.equal(readInboxDraft(storage, first), undefined);
  assert.equal(readInboxDraft(storage, second), 'another draft');
});

test('storage failures degrade safely without losing the in-memory caller state', () => {
  const broken: InboxDraftStorage = {
    getItem() { throw new Error('disabled'); },
    setItem() { throw new Error('disabled'); },
    removeItem() { throw new Error('disabled'); },
  };
  const key = inboxDraftKey({ account: 'whatsapp', id: 'one' });
  assert.equal(readInboxDraft(broken, key), undefined);
  assert.equal(writeInboxDraft(broken, key, 'draft'), false);
  assert.equal(writeInboxDraft(undefined, key, 'draft'), false);
});
