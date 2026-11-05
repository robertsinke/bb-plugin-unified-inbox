import assert from 'node:assert/strict';
import test from 'node:test';
import { sourceAvatarUrl } from '../src/avatar-url.ts';

test('accepts HTTPS avatar URLs from their source CDN only', () => {
  assert.equal(sourceAvatarUrl('https://pps.whatsapp.net/pic.jpg', 'whatsapp'), 'https://pps.whatsapp.net/pic.jpg');
  assert.equal(sourceAvatarUrl('https://media.licdn.com/dms/image/pic', 'linkedin'), 'https://media.licdn.com/dms/image/pic');
  assert.equal(sourceAvatarUrl('https://media.licdn.com/dms/image/pic', 'whatsapp'), undefined);
});

test('a Google contact photo is its host and its path shape, and nothing else on that host', () => {
  // INBOX-38. lh3.googleusercontent.com also serves Drive files (/d/) and uploaded images (/u/),
  // so the host alone would let a row draw something that is not a face.
  assert.equal(sourceAvatarUrl('https://lh3.googleusercontent.com/a/ACg8ocPhoto=s96-c', 'gmail'), 'https://lh3.googleusercontent.com/a/ACg8ocPhoto=s96-c');
  assert.equal(sourceAvatarUrl('https://lh3.googleusercontent.com/a-/ALV-UjPhoto=s256-c-ns', 'gmail'), 'https://lh3.googleusercontent.com/a-/ALV-UjPhoto=s256-c-ns');
  for (const value of [
    'https://lh3.googleusercontent.com/d/1AbCdrivefile',
    'https://lh3.googleusercontent.com/u/0/uploaded',
    'https://lh4.googleusercontent.com/a/ACg8ocPhoto',
    'https://evil.example/a/ACg8ocPhoto',
    'https://lh3.googleusercontent.com/a/',
  ]) assert.equal(sourceAvatarUrl(value, 'gmail'), undefined, value);
  assert.equal(sourceAvatarUrl('https://lh3.googleusercontent.com/a/ACg8ocPhoto', 'linkedin'), undefined, 'a source cannot borrow another source\'s host');
});

test('rejects non-HTTPS, credentialed, ported, and unrelated image URLs', () => {
  for (const value of ['http://pps.whatsapp.net/pic', 'data:image/png;base64,AAAA', 'javascript:alert(1)', 'https://user:pass@pps.whatsapp.net/pic', 'https://pps.whatsapp.net:8443/pic', 'https://evil.example/pic']) {
    assert.equal(sourceAvatarUrl(value, 'whatsapp'), undefined);
  }
  assert.equal(sourceAvatarUrl(`https://pps.whatsapp.net/${'a'.repeat(2049)}`, 'whatsapp'), undefined);
});
