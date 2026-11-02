import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { inboxMentionContext, mentionId, parseMentionId, threadComposer } from '../src/inbox-mention.ts';

test('the tag goes to the thread beside the inbox', () => {
  const beside = { scope: { kind: 'thread', threadId: 'thr_beside' } };
  const other = { scope: { kind: 'thread', threadId: 'thr_other' } };
  const queued = { scope: { kind: 'queued-message', threadId: 'thr_beside', queuedMessageId: 'q1' } };
  assert.equal(threadComposer([other, queued, beside], 'thr_beside'), beside);
  assert.equal(threadComposer([queued, other], 'thr_missing'), other);
  assert.equal(threadComposer([queued], null), undefined);
});

test('mention ids round-trip and reject unknown sources', () => {
  assert.deepEqual(parseMentionId(mentionId('whatsapp', '1203@g.us')), { account: 'whatsapp', id: '1203@g.us' });
  assert.deepEqual(parseMentionId('personal:18f2c'), { account: 'personal', id: '18f2c' });
  assert.throws(() => parseMentionId('nonsense'), /known conversation/);
  assert.throws(() => parseMentionId(':x'), /known conversation/);
  assert.throws(() => parseMentionId('whatsapp:'), /known conversation/);
});

test('context names the conversation and keeps the newest messages', () => {
  const messages = Array.from({ length: 14 }, (_, index) => ({ sender: index === 13 ? 'You' : 'Alice', text: `message ${index}`, date: 1_700_000_000_000 + index * 60_000 }));
  const context = inboxMentionContext({ account: 'whatsapp', label: 'WhatsApp', id: '1203@g.us', title: 'Alice', messages });
  assert.match(context, /Inbox conversation: Alice \(WhatsApp\)/);
  assert.match(context, /Conversation id: 1203@g.us/);
  assert.match(context, /You: message 13/);
  assert.doesNotMatch(context, /message 1\b/);
  assert.match(context, /printf '%s' '\{"account":"whatsapp","id":"1203@g\.us","action":"reply"/);
  assert.match(context, /"allow":"send"/, 'the documented send carries the gate\'s one approval word');
  assert.match(context, /bb plugin rpc call unified-inbox action --input-file/);
});

test('a media-only message keeps its placeholder', () => {
  const context = inboxMentionContext({ account: 'business', label: 'Inhouse Gmail', id: '18f2c', preview: 'Invoice', messages: [{ sender: 'Vendor', text: '', date: 1_700_000_000_000, media: { kind: 'image' } }] });
  assert.match(context, /Vendor: \[image\]/);
});

test('the footer tells an agent what each source can actually do now', () => {
  const messages = [{ sender: 'Ada', text: 'hi', date: 1_700_000_000_000 }];

  const imessage = inboxMentionContext({ account: 'imessage', label: 'Messages', id: 'iMessage;-;+15551234567', title: 'Ada', messages });
  assert.doesNotMatch(imessage, /not available/i, 'Messages sending shipped');
  assert.match(imessage, /allow.*send/, 'and it says how: the same explicit send statement');

  const linkedin = inboxMentionContext({ account: 'linkedin', label: 'LinkedIn', id: 'urn:li:msg_conversation:(a,2-b)', title: 'Andrea', messages });
  assert.doesNotMatch(linkedin, /read-only/i, 'LinkedIn sends now');
  assert.match(linkedin, /record/i, 'a reply needs its recorded action first, and the footer says so');
  assert.doesNotMatch(linkedin, /nothing can be sent/i);

  const gmail = inboxMentionContext({ account: 'personal', label: 'Personal Gmail', id: '18f2c', title: 'Vendor', messages });
  assert.match(gmail, /send_gmail/, 'Gmail sends through its own RPC, and the footer names it');
  assert.match(gmail, /"allow":"send"/, 'with the same approval word as the chat sources');
  assert.doesNotMatch(gmail, /cannot be sent|read-only/i, 'sending was enabled on 2026-11-03');
});

test('long threads stay inside the context budget', () => {
  const messages = Array.from({ length: 12 }, () => ({ sender: 'Alice', text: 'x'.repeat(400), date: 1_700_000_000_000 }));
  const context = inboxMentionContext({ account: 'whatsapp', label: 'WhatsApp', id: 'abc', title: 'Alice', messages });
  assert.ok(context.length <= 4000, `context was ${context.length} characters`);
  assert.match(context, /bb plugin rpc call unified-inbox action --input-file/);
});
