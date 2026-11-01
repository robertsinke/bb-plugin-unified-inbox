import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { composerSendRequest } from '../src/whatsapp-send.ts';

test('the composer request stays on loopback and names the chat', () => {
  const request = composerSendRequest(8787, '15551234567@s.whatsapp.net', '  hi  ');
  assert.equal(request.url, 'http://127.0.0.1:8787/api/chats/15551234567%40s.whatsapp.net/messages');
  assert.equal(request.origin, 'http://127.0.0.1:8787');
  assert.deepEqual(request.body, { text: 'hi' }, 'the text is trimmed where the owner typed it');
});

test('a group id survives the path segment', () => {
  // The route decodes the segment back, so encoding it is what keeps `@` from becoming a path.
  const request = composerSendRequest(8787, '120363000000000003@g.us', 'hi');
  assert.equal(request.url, 'http://127.0.0.1:8787/api/chats/120363000000000003%40g.us/messages');
  assert.equal(decodeURIComponent(request.url.split('/api/chats/')[1]!.replace('/messages', '')), '120363000000000003@g.us');
});

test('a malformed request is refused before it reaches the backend', () => {
  assert.throws(() => composerSendRequest(0, 'a@s.whatsapp.net', 'hi'), /Invalid WhatsAgent connection/);
  assert.throws(() => composerSendRequest(8787, '   ', 'hi'), /Invalid WhatsApp chat/);
  assert.throws(() => composerSendRequest(8787, 'a@s.whatsapp.net', '   '), /Expected text to send/);
});
