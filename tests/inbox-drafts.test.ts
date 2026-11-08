import assert from 'node:assert/strict';
import test from 'node:test';
import type { MailDraft } from '../src/inbox-session.ts';
import {
  clearMailDraft,
  inboxDraftKey,
  mailDraftKey,
  migrateDraftAccountIds,
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
    account: 'gmail-personal',
    to: 'ana@example.com',
    cc: 'bo@example.com',
    bcc:'',subject: 'Re: launch',
    text: 'Short answer: yes.',
    threadId: 'thread-1',
    inReplyTo: '<m1@example.com>',
    references: '<m0@example.com> <m1@example.com>',
  };
  const threadKey = mailDraftKey({ account: 'gmail-personal', threadId: 'thread-1' });
  assert.equal(writeMailDraft(storage, threadKey, reply), true);
  assert.deepEqual(readMailDraft(storage, threadKey), reply);

  const fresh: InboxMailDraft = { account: 'gmail-business', to: '', cc: '', bcc:'',subject: 'Hello', text: 'Body' };
  const composeKey = mailDraftKey({ account: 'gmail-business', newMessageKey: 'compose-1' });
  assert.equal(writeMailDraft(storage, composeKey, fresh), true);
  assert.deepEqual(readMailDraft(storage, composeKey), fresh);

  assert.equal(clearMailDraft(storage, threadKey), true);
  assert.equal(readMailDraft(storage, threadKey), undefined);
});

test('malformed or foreign stored values read as no mail draft instead of throwing', () => {
  const storage = memoryStorage();
  const key = mailDraftKey({ account: 'gmail-personal', threadId: 'thread-1' });
  const corrupt = ['{not json', 'null', '[]', '"a draft"', '{}', '{"account":"gmail-personal","to":"a","cc":"b","subject":"c"}', '{"account":"gmail-personal","to":"a","cc":"b","subject":"c","text":"d","threadId":7}'];
  for (const raw of corrupt) {
    storage.setItem(key, raw);
    assert.equal(readMailDraft(storage, key), undefined, raw);
  }
});

test('an absent mail draft and a disabled storage both read as no draft', () => {
  const key = mailDraftKey({ account: 'gmail-personal', threadId: 'thread-1' });
  assert.equal(readMailDraft(memoryStorage(), key), undefined);
  const broken: InboxDraftStorage = {
    getItem() { throw new Error('disabled'); },
    setItem() { throw new Error('disabled'); },
    removeItem() { throw new Error('disabled'); },
  };
  assert.equal(readMailDraft(broken, key), undefined);
  assert.equal(writeMailDraft(broken, key, { account: 'gmail-personal', to: '', cc: '', bcc:'',subject: 's', text: 't' }), false);
  assert.equal(clearMailDraft(broken, key), false);
  assert.equal(writeMailDraft(undefined, key, { account: 'gmail-personal', to: '', cc: '', bcc:'',subject: 's', text: 't' }), false);
});

test('reply text and mail drafts for the same conversation never collide', () => {
  const storage = memoryStorage();
  const replyKey = inboxDraftKey({ account: 'gmail-personal', id: 'thread-1' });
  const threadKey = mailDraftKey({ account: 'gmail-personal', threadId: 'thread-1' });
  const composeKey = mailDraftKey({ account: 'gmail-personal', newMessageKey: 'thread-1' });
  assert.equal(new Set([replyKey, threadKey, composeKey]).size, 3);

  const draft: InboxMailDraft = { account: 'gmail-personal', to: 'ana@example.com', cc: '', bcc:'',subject: 'Re: launch', text: 'body', threadId: 'thread-1' };
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
  writeMailDraft(storage, 'unified-inbox.mail-draft.v1:gmail-personal:t1', { account: 'gmail-personal', to: 'a@example.com', cc: 'b@example.com', bcc: 'c@example.com', subject: 'Hi', text: 'Hello' });
  const back = readMailDraft(storage, 'unified-inbox.mail-draft.v1:gmail-personal:t1');
  assert.equal(back?.bcc, 'c@example.com', 'the draft the owner returns to still knows who was blind-copied');
});

test('a stored draft keeps its words and leaves the file bytes behind', () => {
  const storage = memoryStorage();
  const key = 'unified-inbox.mail-draft.v1:gmail-personal:t1';
    // exactly what the session hands the writer: a live draft, which carries files
  const live: MailDraft = { account: 'gmail-personal', to: 'a@example.com', cc: '', bcc: '', subject: 'Hi', text: 'See attached', attachments: [{ name: 'plan.pdf', mimeType: 'application/pdf', size: 4, data: 'aGVsbG8=' }] };
  writeMailDraft(storage, key, live);
  const raw = storage.getItem(key) ?? '';
  assert.equal(raw.includes('aGVsbG8='), false, 'a stored draft does not carry file bytes');
  const back = readMailDraft(storage, key);
  assert.equal(back?.text, 'See attached', 'the words survive; the file bytes do not');
});

test('drafts stored under the old gmail account ids are renamed', () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
    get length() { return values.size; },
    key: (index: number) => [...values.keys()][index] ?? null,
  };
  const reply = 'unified-inbox.reply-draft.v1:personal:thread%201';
  const mail = 'unified-inbox.mail-draft.v1:business:thread:t1';
  const kept = mailDraftKey({ account: 'gmail-personal', threadId: 't1' });
  const oldMail = 'unified-inbox.mail-draft.v1:personal:thread:t1';
  storage.setItem(reply, 'see you');
  storage.setItem(mail, JSON.stringify({ account: 'business', to: 'a@example.com', cc: '', bcc: '', subject: 'Hi', text: 'Hello' }));
  storage.setItem(kept, JSON.stringify({ account: 'gmail-personal', to: 'a@example.com', cc: '', bcc: '', subject: 'Newer', text: 'Stay' }));
  storage.setItem(oldMail, JSON.stringify({ account: 'personal', to: 'a@example.com', cc: '', bcc: '', subject: 'Old', text: 'Go' }));
  migrateDraftAccountIds(storage);
  assert.equal(readInboxDraft(storage, inboxDraftKey({ account: 'gmail-personal', id: 'thread 1' })), 'see you');
  assert.equal(storage.getItem(reply), null);
  assert.equal(readMailDraft(storage, mailDraftKey({ account: 'gmail-business', threadId: 't1' }))?.account, 'gmail-business');
  assert.equal(readMailDraft(storage, mailDraftKey({ account: 'gmail-business', threadId: 't1' }))?.text, 'Hello');
  assert.equal(readMailDraft(storage, kept)?.text, 'Stay');
  assert.equal(storage.getItem(oldMail), null);
});

function keyedStorage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
    get length() { return values.size; },
    key: (index: number) => [...values.keys()][index] ?? null,
  };
}

test('a legacy draft is copied with the key helpers and the old key is removed after the copy', () => {
  const storage = keyedStorage();
  const reply = inboxDraftKey({ account: 'gmail-personal', id: 'thread 1' });
  const mail = mailDraftKey({ account: 'gmail-personal', threadId: 't1' });
  storage.setItem(reply, 'see you');
  storage.setItem(mail, JSON.stringify({ account: 'gmail-personal', to: 'bob@example.com', cc: '', bcc: '', subject: 'Hi', text: 'Hello' }));
  migrateDraftAccountIds(storage, { 'gmail-personal': 'ada@example.com' });
  assert.equal(readInboxDraft(storage, inboxDraftKey({ account: 'ada@example.com', id: 'thread 1' })), 'see you');
  assert.equal(storage.getItem(reply), null);
  assert.equal(readMailDraft(storage, mailDraftKey({ account: 'ada@example.com', threadId: 't1' }))?.account, 'ada@example.com');
  assert.equal(storage.getItem(mail), null);
});

test('a failed draft copy leaves the old key', () => {
  const values = new Map<string, string>();
  const reply = inboxDraftKey({ account: 'gmail-personal', id: 'thread 1' });
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (key.includes('ada%40')) throw new Error('disk full');
      values.set(key, value);
    },
    removeItem: (key: string) => { values.delete(key); },
    get length() { return values.size; },
    key: (index: number) => [...values.keys()][index] ?? null,
  };
  storage.setItem(reply, 'see you');
  migrateDraftAccountIds(storage, { 'gmail-personal': 'ada@example.com' });
  assert.equal(storage.getItem(reply), 'see you');
  assert.equal(storage.getItem(inboxDraftKey({ account: 'ada@example.com', id: 'thread 1' })), null);
});
