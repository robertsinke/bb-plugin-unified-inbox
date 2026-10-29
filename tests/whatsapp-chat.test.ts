import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { groupPreview, isWhatsAppNoise, isWhatsAppNoisePreview, whatsappPhone, whatsappSender, whatsappTitle } from '../src/whatsapp-chat.ts';

test('group previews name the sender, matching WhatsApp', () => {
  assert.equal(groupPreview('Ja', false, 'Marnix'), 'Marnix: Ja');
  assert.equal(groupPreview('Ja', true, ''), 'You: Ja');
  assert.equal(groupPreview('Photo', false, 'Felix'), 'Felix: Photo');
});

test('group previews stay bare without a sender or body', () => {
  assert.equal(groupPreview('Ja', false, ''), 'Ja');
  assert.equal(groupPreview('', false, 'Marnix'), '');
  assert.equal(groupPreview('  ', false, 'Marnix'), '  ');
});

test('1:1 messages fall back to the chat name, not the app name', () => {
  assert.equal(whatsappSender(false, '', false, 'Jan'), 'Jan');
  assert.equal(whatsappSender(false, 'Marnix', true, 'Elvy'), 'Marnix');
  assert.equal(whatsappSender(true, '', false, 'Jan'), 'You');
  assert.equal(whatsappSender(false, '', true, 'Elvy'), 'Unknown');
});

test('phone fallback only formats real phone JIDs', () => {
  assert.equal(whatsappPhone('31651613678@s.whatsapp.net'), '+31651613678');
  assert.equal(whatsappPhone('31651613678@c.us'), '+31651613678');
  assert.equal(whatsappPhone('110573949866107@lid'), '');
  assert.equal(whatsappPhone('120363406108604036@g.us'), '');
  assert.equal(whatsappPhone('0@s.whatsapp.net'), '');
  assert.equal(whatsappPhone(''), '');
  assert.equal(whatsappTitle('', '31651613678@s.whatsapp.net'), '+31651613678');
  assert.equal(whatsappTitle('Marnix', '110573949866107@lid'), 'Marnix');
  assert.equal(whatsappTitle('', '120363406108604036@g.us'), '120363406108604036@g.us');
});

test('stub and protocol events are noise, not messages', () => {
  assert.equal(isWhatsAppNoise('system', ''), true);
  assert.equal(isWhatsAppNoise('protocol', ''), true);
  assert.equal(isWhatsAppNoise('', '[system]'), true);
  assert.equal(isWhatsAppNoise('', '[protocol]'), true);
  assert.equal(isWhatsAppNoise('text', 'hello'), false);
  assert.equal(isWhatsAppNoisePreview('[system]'), true);
  assert.equal(isWhatsAppNoisePreview('Beatriz Sgobi: [system]'), true);
  assert.equal(isWhatsAppNoisePreview('Marnix: Ja'), false);
});
