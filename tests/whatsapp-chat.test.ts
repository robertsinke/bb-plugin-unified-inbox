import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { groupPreview } from '../src/whatsapp-chat.ts';

test('group previews name the sender, matching WhatsApp', () => {
  assert.equal(groupPreview('Ja', false, 'Marnin'), 'Marnin: Ja');
  assert.equal(groupPreview('Ja', true, ''), 'You: Ja');
  assert.equal(groupPreview('Photo', false, 'Felix'), 'Felix: Photo');
});

test('group previews stay bare without a sender or body', () => {
  assert.equal(groupPreview('Ja', false, ''), 'Ja');
  assert.equal(groupPreview('', false, 'Marnin'), '');
  assert.equal(groupPreview('  ', false, 'Marnin'), '  ');
});
