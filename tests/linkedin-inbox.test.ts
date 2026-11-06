import assert from 'node:assert/strict';
import test from 'node:test';
import { isInvitationId, isConversationId, linkedinItems, linkedinMessages } from '../src/linkedin-inbox.ts';

const conversation = { id: 'urn:li:msg_conversation:(urn:li:fsd_profile:A,2-B)', title: 'Nils Holm', preview: 'You: Hi Nils', date: 1_800_000_000_000, unread: true };
const invitation = { id: 'urn:li:fsd_invitation:7000000000000000003', title: 'Bea Stone', preview: 'Hello. Would you like to meet?', date: 1_800_000_100_000, unread: true, sender: 'Bea Stone' };

test('linkedinItems merges conversations and invitations newest first', () => {
  const items = linkedinItems({ conversations: [conversation], invitations: [invitation] });
  assert.deepEqual(items.map(item => item.id), [invitation.id, conversation.id]);
  assert.equal(items[0].title, 'Bea Stone');
  assert.equal(items[1].unread, true);
});

test('linkedinItems keeps an invitation without a note explicit', () => {
  const items = linkedinItems({ invitations: [{ ...invitation, preview: 'Invitation — no note' }] });
  assert.equal(items[0].preview, 'Invitation — no note');
});

test('linkedinItems drops rows without an id and rows repeated across both surfaces', () => {
  const items = linkedinItems({ conversations: [{ title: 'No id' }, conversation], invitations: [{ ...conversation, title: 'Duplicate' }] });
  assert.equal(items.length, 1);
  assert.equal(items[0].title, 'Nils Holm');
});

test('linkedinItems falls back to a usable title and truncates long previews', () => {
  const items = linkedinItems({ conversations: [{ id: 'urn:li:msg_conversation:x', preview: 'a'.repeat(1000) }] });
  assert.equal(items[0].title, 'LinkedIn conversation');
  assert.equal(items[0].preview.length, 300);
});

test('linkedinItems treats a missing or unusable date as unknown rather than current time', () => {
  const items = linkedinItems({ conversations: [{ id: 'urn:li:msg_conversation:x', date: 'nope' }] });
  assert.equal(items[0].date, 0);
});

test('linkedinItems never renders a boolean flag as a preview', () => {
  const items = linkedinItems({ conversations: [{ id: 'urn:li:msg_conversation:(a,2-b)', title: 'Someone', preview: 'true', date: 1 }] });
  assert.equal(items[0].preview, '');
  // The same flag on a connection request leaves nothing to show, so the row is not an inbox row.
  assert.deepEqual(linkedinItems({ invitations: [{ id: 'urn:li:fs_relInvitation:1', title: 'Someone', preview: 'true', date: 1 }] }), []);
});

test('linkedinItems returns no rows and no error for an empty payload', () => {
  assert.deepEqual(linkedinItems({}), []);
  assert.deepEqual(linkedinItems({ conversations: null, invitations: undefined }), []);
});

test('linkedinMessages orders oldest first and drops empty bodies', () => {
  const messages = linkedinMessages({ messages: [{ sender: 'Bea', text: 'second', date: 2, fromMe: false }, { sender: 'You', text: 'third', date: 3, fromMe: true }, { sender: 'Bea', text: '   ', date: 1 }] });
  assert.deepEqual(messages.map(message => message.text), ['second', 'third']);
  assert.equal(messages[1].fromMe, true);
  assert.equal(messages[0].sender, 'Bea');
});

test('linkedinMessages keeps an unnamed sender readable', () => {
  const messages = linkedinMessages({ messages: [{ text: 'hello', date: 1 }] });
  assert.equal(messages[0].sender, 'LinkedIn');
});

test('LinkedIn profile photos are kept only from LinkedIn CDN URLs', () => {
  const row = linkedinItems({ conversations: [
    { ...conversation, avatarUrl: 'https://media.licdn.com/dms/image/photo' },
    { ...invitation, id: 'unsafe', avatarUrl: 'https://evil.example/photo' },
  ] }).find(item => item.id === conversation.id);
  assert.equal(row?.avatarUrl, 'https://media.licdn.com/dms/image/photo');
  assert.equal(linkedinItems({ conversations: [{ ...conversation, avatarUrl: 'https://evil.example/photo' }] })[0]?.avatarUrl, undefined);
});

test('a photo message with no text is still a message, and keeps the URL its thumbnail needs', () => {
  const photo = 'https://media.licdn.com/dms/image/v2/D4E22AQphoto/900/0/1700000000000?e=1';
  const messages = linkedinMessages({ messages: [
    { id: 'urn:li:msg_message:(urn:li:msg_conversation:(a,2-b),2-c)', sender: 'Bea', text: '', date: 1, fromMe: false, mediaUrl: photo, activityUrn: '' },
  ] });
  assert.deepEqual(messages, [{
    id: 'urn:li:msg_message:(urn:li:msg_conversation:(a,2-b),2-c)',
    messageId: 'urn:li:msg_message:(urn:li:msg_conversation:(a,2-b),2-c)',
    sender: 'Bea',
    text: '',
    date: 1,
    fromMe: false,
    media: { messageId: 'urn:li:msg_message:(urn:li:msg_conversation:(a,2-b),2-c)', kind: 'image', cached: false, available: true, url: photo },
  }]);
});

test('a photo off the LinkedIn CDN leaves nothing to render, so the message is dropped', () => {
  assert.deepEqual(linkedinMessages({ messages: [
    { id: 'urn:li:msg_message:x', sender: 'Bea', text: '', date: 1, mediaUrl: 'https://evil.example/photo.png' },
    { id: 'urn:li:msg_message:y', sender: 'Bea', text: '', date: 2, mediaUrl: 'https://media.licdn.com/photo.png' },
  ] }).map(message => message.id), ['urn:li:msg_message:y']);
});

test('a shared post becomes a link to the post and carries no media', () => {
  const [post] = linkedinMessages({ messages: [
    { id: 'urn:li:msg_message:x', sender: 'Bea', text: '', date: 1, mediaUrl: '', activityUrn: 'urn:li:activity:7123456789012345678' },
  ] });
  assert.equal(post.link, 'https://www.linkedin.com/feed/update/urn:li:activity:7123456789012345678/');
  assert.equal(post.media, undefined);
  assert.equal(post.text, '');
});

test('an activity urn that is not an activity is not a link', () => {
  assert.deepEqual(linkedinMessages({ messages: [
    { id: 'urn:li:msg_message:x', sender: 'Bea', text: '', date: 1, activityUrn: 'urn:li:fsd_update:(urn:li:activity:1)' },
  ] }), []);
});

test('isConversationId accepts only conversation URNs', () => {
  assert.equal(isConversationId('urn:li:msg_conversation:(urn:li:fsd_profile:A,2-B)'), true);
  assert.equal(isConversationId('urn:li:fsd_invitation:1'), false);
  assert.equal(isConversationId('2-B'), false);
  assert.equal(isConversationId(''), false);
});

test('only received-invitation urns are treated as pending invitations', () => {
  assert.equal(isInvitationId('urn:li:fs_relInvitation:(urn:li:fsd_profile:ACoAA,123)'), true);
  assert.equal(isInvitationId('urn:li:msg_conversation:(urn:li:fsd_profile:ACoAA,2-ZWQ)'), false);
  assert.equal(isInvitationId('urn:li:fs_relInvitation:'), false);
  assert.equal(isInvitationId(`urn:li:fs_relInvitation:${'x'.repeat(600)}`), false);
});

test('a connection request without a note is not an inbox row, one with a note is', () => {
  const items = linkedinItems({
    conversations: [{ id: 'urn:li:msg_conversation:(a,2-b)', title: 'Sam Rivera', preview: 'Hi', date: 5, unread: false }],
    invitations: [
      { id: 'urn:li:fs_relInvitation:111', title: 'Bare request', preview: '', date: 4, unread: false },
      { id: 'urn:li:fs_relInvitation:222', title: 'Bea Stone', preview: 'Would you like to meet?', date: 3, unread: false },
    ],
  });
  assert.deepEqual(items.map(item => item.title), ['Sam Rivera', 'Bea Stone']);
  assert.equal(items.some(item => item.id === 'urn:li:fs_relInvitation:111'), false);
});
