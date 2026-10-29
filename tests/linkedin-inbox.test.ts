import assert from 'node:assert/strict';
import test from 'node:test';
import { isConversationId, linkedinItems, linkedinMessages } from '../src/linkedin-inbox.ts';

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
  const items = linkedinItems({ invitations: [{ id: 'urn:li:fs_relInvitation:1', title: 'Someone', preview: 'true', date: 1 }] });
  assert.equal(items[0].preview, '');
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

test('isConversationId accepts only conversation URNs', () => {
  assert.equal(isConversationId('urn:li:msg_conversation:(urn:li:fsd_profile:A,2-B)'), true);
  assert.equal(isConversationId('urn:li:fsd_invitation:1'), false);
  assert.equal(isConversationId('2-B'), false);
  assert.equal(isConversationId(''), false);
});
