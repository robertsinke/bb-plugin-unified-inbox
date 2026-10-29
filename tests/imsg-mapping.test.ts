import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findImsgAttachment, imsgChatId, mapImsgChats, mapImsgHistory } from '../src/imsg-mapping.ts';

test('maps local chat identity, service, unread and timestamps', () => {
  assert.deepEqual(mapImsgChats({ chats: [{ id: 7, display_name: 'Group', service: 'iMessage', unread_count: 2, last_message_at: '2026-01-02T12:00:00Z' }] }), [{
    account: 'imessage', id: '7', title: 'Group', preview: 'iMessage', date: Date.parse('2026-01-02T12:00:00Z'), unread: true,
  }]);
  assert.throws(() => mapImsgChats({ chats: [{ id: 1 }] }));
  assert.throws(() => mapImsgChats({ chats: 'bad' }));
});

test('maps history in chronological order without exposing attachment paths', () => {
  const items = mapImsgHistory({ messages: [
    { id: 2, guid: 'two', is_from_me: true, created_at: '2026-01-02T00:00:00Z', attachments: [{ filename: '/private/file' }] },
    { id: 1, sender: 'Alice', text: 'Hello', created_at: '2026-01-01T00:00:00Z', reactions: [{ sender: 'Alice', emoji: '👍', type: 'like' }] },
  ] });
  assert.equal(items[0].text, 'Hello');
  assert.deepEqual(items[0].reactions, [{ sender: 'Alice', label: '👍' }]);
  assert.equal(items[1].text, '');
  assert.deepEqual(items[1].imsgAttachments, [{ index: 0, name: 'Attachment', available: false }]);
  assert.equal(items[1].sender, 'You');
  assert.equal(JSON.stringify(items).includes('/private/'), false);
});

test('attachment selectors resolve only against the freshly fetched history', () => {
  const history = { messages: [{ id: 8, attachments: [{ filename: '/private/image', transfer_name: '/private/photo.png', mime_type: 'image/png', missing: false }] }] };
  const mapped = mapImsgHistory(history);
  assert.deepEqual(mapped[0].imsgAttachments, [{ index: 0, name: 'photo.png', available: true }]);
  assert.equal(JSON.stringify(mapped).includes('/private/'), false);
  assert.deepEqual(findImsgAttachment(history, '8', 0), { filename: '/private/image', mime: 'image/png' });
  assert.throws(() => findImsgAttachment(history, '9', 0));
  assert.throws(() => findImsgAttachment(history, '8', 1));
});

test('maps current edits, unsends and reply context without retaining retracted content', () => {
  const messages = mapImsgHistory({ messages: [
    { id: 1, sender: 'handle', sender_name: 'Alice', text: 'new', edited_at: '2026-01-01T00:00:00Z', reply_to_guid: 'parent' },
    { id: 2, text: 'stale secret', unsent_at: '2026-01-01T00:00:00Z', attachments: [{ filename: '/secret', mime_type: 'image/png' }], reactions: [{ emoji: '👍' }] },
  ] });
  assert.equal(messages[0].sender, 'Alice');
  assert.equal(messages[0].edited, true);
  assert.equal(messages[0].replyContext, true);
  assert.equal(messages[1].text, 'Message unsent');
  assert.deepEqual(messages[1].imsgAttachments, []);
  assert.deepEqual(messages[1].reactions, []);
  assert.throws(() => findImsgAttachment({ messages: [{ id: 2, unsent_at: '2026-01-01', attachments: [{ filename: '/secret', mime_type: 'image/png' }] }] }, '2', 0));
});

test('chat selector must be an unambiguous safe positive integer', () => {
  assert.equal(imsgChatId('42'), 42);
  for (const id of ['0', '-1', '01', '1e3', '1.5', '9007199254740992']) assert.throws(() => imsgChatId(id));
});
