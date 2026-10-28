import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { IMAGE_LIMIT, mediaDataUrl, VIDEO_LIMIT, whatsAppMedia } from '../src/whatsapp-media.ts';

test('image, sticker, and video messages carry media metadata', () => {
  assert.deepEqual(whatsAppMedia({ id: 'm1', type: 'image', media: { cached: true, mime: 'image/jpeg', filename: 'beach.jpg' } }), {
    messageId: 'm1',
    kind: 'image',
    cached: true,
    available: true,
    mime: 'image/jpeg',
    filename: 'beach.jpg',
  });
  assert.equal(whatsAppMedia({ id: 'm2', type: 'sticker', media: { cached: false } })?.kind, 'sticker');
  assert.deepEqual(whatsAppMedia({ id: 'm3', type: 'video', media: { cached: false, mime: 'video/mp4', size: 3431435 } }), {
    messageId: 'm3',
    kind: 'video',
    cached: false,
    available: true,
    mime: 'video/mp4',
    size: 3431435,
  });
  assert.equal(whatsAppMedia({ id: 'm4', type: 'audio', media: { cached: true } }), undefined);
  assert.equal(whatsAppMedia({ id: 'm5', type: 'image' })?.messageId, 'm5');
  assert.equal(whatsAppMedia({ type: 'image' }), undefined);
});

test('terminal media failures stay unavailable', () => {
  assert.equal(whatsAppMedia({ id: 'm', type: 'image', media: { cached: false, error: 'unavailable' } })?.available, false);
  assert.equal(whatsAppMedia({ id: 'm', type: 'image', media: { cached: false, error: 'transient' } })?.available, true);
});

test('data URLs accept bounded images and videos only', () => {
  assert.equal(mediaDataUrl(new Uint8Array([1, 2, 3]), 'image/png; charset=binary'), 'data:image/png;base64,AQID');
  assert.equal(mediaDataUrl(new Uint8Array([1, 2, 3]), 'video/mp4'), 'data:video/mp4;base64,AQID');
  assert.throws(() => mediaDataUrl(new Uint8Array([1]), 'text/html'));
  assert.throws(() => mediaDataUrl(new Uint8Array([1]), 'image/svg+xml'));
  assert.throws(() => mediaDataUrl(new Uint8Array(IMAGE_LIMIT + 1), 'image/jpeg'));
  assert.throws(() => mediaDataUrl(new Uint8Array(VIDEO_LIMIT + 1), 'video/mp4'));
});
