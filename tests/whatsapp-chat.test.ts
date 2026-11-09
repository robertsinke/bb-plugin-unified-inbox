import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { groupPreview, isWhatsAppNoise, isWhatsAppNoisePreview, whatsappPhone, whatsappSender, whatsappText, whatsappTitle } from '../src/whatsapp-chat.ts';

test('a message with media of its own names itself only where a control cannot', () => {
  const photo = { kind: 'image' };
  const note = { kind: 'audio' };
  assert.equal(whatsappText('', 'image', photo), '', 'a picture speaks for itself in the bubble');
  assert.equal(whatsappText('', 'sticker', { kind: 'sticker' }), '');
  assert.equal(whatsappText('', 'video', { kind: 'video' }), '');
  assert.equal(whatsappText('', 'audio', note), '[audio]', 'a chat list has no player, so the row names its type');
  assert.equal(whatsappText('', 'document', { kind: 'document' }), '[document]');
  assert.equal(whatsappText('Hear this', 'audio', note), 'Hear this', 'a caption is the message text');
  assert.equal(whatsappText('', 'call'), '[call]', 'a call is not an empty bubble');
  assert.equal(whatsappText('', 'text'), '');
  assert.equal(whatsappText('Lunch?\nYes\nNo', 'poll'), 'Poll');
  assert.equal(whatsappText('Lunch?', 'pollCreationV3'), 'Poll', 'a row stored before the poll type still lists as Poll');
});

test('group previews name the sender, matching WhatsApp', () => {
  assert.equal(groupPreview('Ja', false, 'Marnin'), 'Marnin: Ja');
  assert.equal(groupPreview('Ja', true, ''), 'You: Ja');
  assert.equal(groupPreview('Photo', false, 'Felix'), 'Felix: Photo');
  assert.equal(groupPreview('Poll', false, 'Ada'), 'Ada: Poll');
});

test('group previews stay bare without a sender or body', () => {
  assert.equal(groupPreview('Ja', false, ''), 'Ja');
  assert.equal(groupPreview('', false, 'Marnin'), '');
  assert.equal(groupPreview('  ', false, 'Marnin'), '  ');
});

test('1:1 messages fall back to the chat name, not the app name', () => {
  assert.equal(whatsappSender(false, '', false, 'Jan'), 'Jan');
  assert.equal(whatsappSender(false, 'Marnin', true, 'Eve'), 'Marnin');
  assert.equal(whatsappSender(true, '', false, 'Jan'), 'You');
  assert.equal(whatsappSender(false, '', true, 'Eve'), 'Unknown');
});

test('phone fallback only formats real phone JIDs', () => {
  assert.equal(whatsappPhone('31600000111@s.whatsapp.net'), '+31600000111');
  assert.equal(whatsappPhone('31600000111@c.us'), '+31600000111');
  assert.equal(whatsappPhone('100000000000002@lid'), '');
  assert.equal(whatsappPhone('120363000000000001@g.us'), '');
  assert.equal(whatsappPhone('0@s.whatsapp.net'), '');
  assert.equal(whatsappPhone(''), '');
  assert.equal(whatsappTitle('', '31600000111@s.whatsapp.net'), '+31600000111');
  assert.equal(whatsappTitle('Marnin', '100000000000002@lid'), 'Marnin');
  assert.equal(whatsappTitle('', '120363000000000001@g.us'), '120363000000000001@g.us');
});

test('stub and protocol events are noise, not messages', () => {
  assert.equal(isWhatsAppNoise('system', ''), true);
  assert.equal(isWhatsAppNoise('protocol', ''), true);
  assert.equal(isWhatsAppNoise('', '[system]'), true);
  assert.equal(isWhatsAppNoise('', '[protocol]'), true);
  assert.equal(isWhatsAppNoise('text', 'hello'), false);
  assert.equal(isWhatsAppNoisePreview('[system]'), true);
  assert.equal(isWhatsAppNoisePreview('Bea Stone: [system]'), true);
  assert.equal(isWhatsAppNoisePreview('Marnin: Ja'), false);
  assert.equal(isWhatsAppNoise('pollUpdate', ''), true);
  assert.equal(isWhatsAppNoise('', '[pollUpdate]'), true);
  assert.equal(isWhatsAppNoisePreview('[pollUpdate]'), true);
  assert.equal(isWhatsAppNoisePreview('Ada: [pollUpdate]'), true);
});
