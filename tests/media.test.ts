import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { ATTACHMENT_LIMIT, IMAGE_LIMIT, VIDEO_LIMIT, mediaDataUrl } from '../src/adapters/media.ts';

test('media limits retain their separate ceilings', () => {
  assert.equal(ATTACHMENT_LIMIT, 5 * 1024 * 1024);
  assert.equal(IMAGE_LIMIT, 6 * 1024 * 1024);
  assert.equal(VIDEO_LIMIT, 30 * 1024 * 1024);
});

test('data URLs accept bounded images and videos only', () => {
  assert.equal(mediaDataUrl(new Uint8Array([1, 2, 3]), 'image/png; charset=binary'), 'data:image/png;base64,AQID');
  assert.equal(mediaDataUrl(new Uint8Array([1, 2, 3]), 'video/mp4'), 'data:video/mp4;base64,AQID');
  assert.throws(() => mediaDataUrl(new Uint8Array([1]), 'text/html'));
  assert.throws(() => mediaDataUrl(new Uint8Array([1]), 'image/svg+xml'));
  assert.throws(() => mediaDataUrl(new Uint8Array(IMAGE_LIMIT + 1), 'image/jpeg'));
  assert.throws(() => mediaDataUrl(new Uint8Array(VIDEO_LIMIT + 1), 'video/mp4'));
});
