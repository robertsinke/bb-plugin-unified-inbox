import assert from 'node:assert/strict';
import test from 'node:test';
import { sourceAvatarUrl } from '../src/avatar-url.ts';

test('accepts HTTPS avatar URLs from their source CDN only', () => {
  assert.equal(sourceAvatarUrl('https://pps.whatsapp.net/pic.jpg', 'whatsapp'), 'https://pps.whatsapp.net/pic.jpg');
  assert.equal(sourceAvatarUrl('https://media.licdn.com/dms/image/pic', 'linkedin'), 'https://media.licdn.com/dms/image/pic');
  assert.equal(sourceAvatarUrl('https://media.licdn.com/dms/image/pic', 'whatsapp'), undefined);
});

test('rejects non-HTTPS, credentialed, ported, and unrelated image URLs', () => {
  for (const value of ['http://pps.whatsapp.net/pic', 'data:image/png;base64,AAAA', 'javascript:alert(1)', 'https://user:pass@pps.whatsapp.net/pic', 'https://pps.whatsapp.net:8443/pic', 'https://evil.example/pic']) {
    assert.equal(sourceAvatarUrl(value, 'whatsapp'), undefined);
  }
  assert.equal(sourceAvatarUrl(`https://pps.whatsapp.net/${'a'.repeat(2049)}`, 'whatsapp'), undefined);
});
