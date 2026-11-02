import assert from 'node:assert/strict';
import test from 'node:test';

import { composerMode, draftForConversation } from '../src/composer-mode.ts';

const base = { selected: true, draft: false, draftForThisThread: false, threaded: true };

test('a reply and a forward are both written in the conversation the owner is looking at', () => {
  const reply = composerMode({ ...base, draft: true, draftForThisThread: true });
  const forward = composerMode({ ...base, draft: true });
  assert.equal(reply, 'mail');
  assert.equal(
    forward,
    'mail',
    'a forward carries no thread id; when this answered "none" the menu item opened nothing at all',
  );
});

test('a chat source gets the chat composer, and a document source with no draft gets neither', () => {
  assert.equal(composerMode(base), 'chat');
  assert.equal(composerMode({ ...base, threaded: false }), 'none');
});

test('a new message takes the panel when nothing is open', () => {
  assert.equal(composerMode({ selected: false, draft: true, draftForThisThread: false, threaded: false }), 'compose');
  assert.equal(composerMode({ selected: false, draft: false, draftForThisThread: false, threaded: false }), 'none');
});

test('a draft names its conversation only when it has one', () => {
  assert.equal(draftForConversation('t1', 't1'), true);
  assert.equal(draftForConversation('t1', 't2'), false, 'a reply to another thread is not written in this one');
  assert.equal(draftForConversation(undefined, 't1'), false, 'a forward belongs to no thread yet');
  assert.equal(draftForConversation(undefined, undefined), false, 'and neither does a new message');
});
