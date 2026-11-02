import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clearMailDraft,
  inboxDraftKey,
  mailDraftKey,
  readInboxDraft,
  readMailDraft,
  writeInboxDraft,
  writeMailDraft,
  type InboxDraftStorage,
  type InboxMailDraft,
} from '../src/inbox-drafts.ts';

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

test('a mail draft round-trips through storage, with and without reply context', () => {
  const storage = memoryStorage();
  const reply: InboxMailDraft = {
    account: 'personal',
    to: 'ana@example.com',
    cc: 'bo@example.com',
    bcc:'',subject: 'Re: launch',
    text: 'Short answer: yes.',
    threadId: 'thread-1',
    inReplyTo: '<m1@example.com>',
    references: '<m0@example.com> <m1@example.com>',
  };
  const threadKey = mailDraftKey({ account: 'personal', threadId: 'thread-1' });
  assert.equal(writeMailDraft(storage, threadKey, reply), true);
  assert.deepEqual(readMailDraft(storage, threadKey), reply);

  const fresh: InboxMailDraft = { account: 'business', to: '', cc: '', bcc:'',subject: 'Hello', text: 'Body' };
  const composeKey = mailDraftKey({ account: 'business', newMessageKey: 'compose-1' });
  assert.equal(writeMailDraft(storage, composeKey, fresh), true);
  assert.deepEqual(readMailDraft(storage, composeKey), fresh);

  assert.equal(clearMailDraft(storage, threadKey), true);
  assert.equal(readMailDraft(storage, threadKey), undefined);
});

test('malformed or foreign stored values read as no mail draft instead of throwing', () => {
  const storage = memoryStorage();
  const key = mailDraftKey({ account: 'personal', threadId: 'thread-1' });
  const corrupt = ['{not json', 'null', '[]', '"a draft"', '{}', '{"account":"personal","to":"a","cc":"b","subject":"c"}', '{"account":"personal","to":"a","cc":"b","subject":"c","text":"d","threadId":7}'];
  for (const raw of corrupt) {
    storage.setItem(key, raw);
    assert.equal(readMailDraft(storage, key), undefined, raw);
  }
});

test('an absent mail draft and a disabled storage both read as no draft', () => {
  const key = mailDraftKey({ account: 'personal', threadId: 'thread-1' });
  assert.equal(readMailDraft(memoryStorage(), key), undefined);
  const broken: InboxDraftStorage = {
    getItem() { throw new Error('disabled'); },
    setItem() { throw new Error('disabled'); },
    removeItem() { throw new Error('disabled'); },
  };
  assert.equal(readMailDraft(broken, key), undefined);
  assert.equal(writeMailDraft(broken, key, { account: 'personal', to: '', cc: '', bcc:'',subject: 's', text: 't' }), false);
  assert.equal(clearMailDraft(broken, key), false);
  assert.equal(writeMailDraft(undefined, key, { account: 'personal', to: '', cc: '', bcc:'',subject: 's', text: 't' }), false);
});

test('reply text and mail drafts for the same conversation never collide', () => {
  const storage = memoryStorage();
  const replyKey = inboxDraftKey({ account: 'personal', id: 'thread-1' });
  const threadKey = mailDraftKey({ account: 'personal', threadId: 'thread-1' });
  const composeKey = mailDraftKey({ account: 'personal', newMessageKey: 'thread-1' });
  assert.equal(new Set([replyKey, threadKey, composeKey]).size, 3);

  const draft: InboxMailDraft = { account: 'personal', to: 'ana@example.com', cc: '', bcc:'',subject: 'Re: launch', text: 'body', threadId: 'thread-1' };
  writeInboxDraft(storage, replyKey, 'chat reply text');
  writeMailDraft(storage, threadKey, draft);
  assert.equal(readInboxDraft(storage, replyKey), 'chat reply text');
  assert.deepEqual(readMailDraft(storage, threadKey), draft);

  clearMailDraft(storage, threadKey);
  assert.equal(readMailDraft(storage, threadKey), undefined);
  assert.equal(readInboxDraft(storage, replyKey), 'chat reply text');
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

test('a blind copy survives a reload with the rest of the draft', () => {
  const storage = memoryStorage();
  writeMailDraft(storage, 'unified-inbox.mail-draft.v1:personal:t1', { account: 'personal', to: 'a@example.com', cc: 'b@example.com', bcc: 'c@example.com', subject: 'Hi', text: 'Hello' });
  const back = readMailDraft(storage, 'unified-inbox.mail-draft.v1:personal:t1');
  assert.equal(back?.bcc, 'c@example.com', 'the draft the owner returns to still knows who was blind-copied');
});
