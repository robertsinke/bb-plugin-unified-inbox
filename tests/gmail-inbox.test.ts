import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { gmailSnippet, latestReceivedMessage, sentReplySnippet } from '../src/gmail-inbox.ts';

test('inbox summary uses the newest received message instead of a later sent reply', () => {
  const received = { id: 'received-new', internalDate: '200', labelIds: ['INBOX'], from: 'Ada <ada@example.test>', snippet: 'Latest incoming' };
  const selected = latestReceivedMessage([
    { id: 'received-old', internalDate: '100', labelIds: ['INBOX'], snippet: 'Earlier incoming' },
    { id: 'sent-reply', internalDate: '300', labelIds: ['SENT'], snippet: 'My reply' },
    received,
  ]);
  assert.equal(selected, received);
  assert.deepEqual({ date: Number(selected?.internalDate), sender: selected?.from, preview: selected?.snippet }, {
    date: 200, sender: 'Ada <ada@example.test>', preview: 'Latest incoming',
  });
});

test('an empty received preview is not replaced with a sent reply preview', () => {
  const selected = latestReceivedMessage([
    { internalDate: '200', labelIds: ['INBOX'], snippet: '' },
    { internalDate: '300', labelIds: ['SENT'], snippet: 'My reply' },
  ]);
  assert.equal(selected?.snippet, '');
});

test('inbox summary keeps the latest received message when thread messages are not chronological', () => {
  const newest = { id: 'received-new', internalDate: '500', labelIds: ['INBOX'] };
  assert.equal(latestReceivedMessage([
    newest,
    { id: 'sent-later', internalDate: '700', labelIds: ['SENT'] },
    { id: 'received-old', internalDate: '200', labelIds: ['INBOX'] },
  ]), newest);
});

test('a Gmail snippet is text, so an escaped apostrophe is an apostrophe', () => {
  assert.equal(gmailSnippet('I&#39;m working with 80+ startups'), "I'm working with 80+ startups");
  assert.equal(gmailSnippet('Tom &amp; Jerry &lt;3 &quot;hi&quot;'), 'Tom & Jerry <3 "hi"');
  assert.equal(gmailSnippet('already I\'m fine'), "already I'm fine");
  assert.equal(gmailSnippet('keep &amp;amp; and &unknown;'), 'keep &amp; and &unknown;');
});

test('a sent reply newer than the inbox message is visible to classification', () => {
  const messages = [
    { internalDate: '200', labelIds: ['INBOX'], snippet: 'Can you review this?' },
    { internalDate: '300', labelIds: ['SENT'], snippet: 'On my way' },
  ];
  assert.equal(sentReplySnippet(messages), 'On my way');
  assert.equal(sentReplySnippet([
    { internalDate: '400', labelIds: ['INBOX'], snippet: 'Thanks' },
    { internalDate: '300', labelIds: ['SENT'], snippet: 'On my way' },
  ]), undefined);
});

test('inbox summary falls back to the final message only when a thread has no received messages', () => {
  const sent = { id: 'sent', internalDate: '300', labelIds: ['SENT'] };
  assert.equal(latestReceivedMessage([sent]), sent);
  assert.equal(latestReceivedMessage([]), undefined);
});
