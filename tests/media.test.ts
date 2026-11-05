import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { ATTACHMENT_LIMIT, AUDIO_LIMIT, IMAGE_LIMIT, SAVE_LIMIT, VIDEO_LIMIT, attachmentPayload, mediaDataUrl } from '../src/adapters/media.ts';

test('media limits retain their separate ceilings', () => {
  assert.equal(ATTACHMENT_LIMIT, 5 * 1024 * 1024);
  assert.equal(IMAGE_LIMIT, 6 * 1024 * 1024);
  assert.equal(VIDEO_LIMIT, 30 * 1024 * 1024);
  assert.equal(AUDIO_LIMIT, 4 * 1024 * 1024);
  assert.equal(SAVE_LIMIT, 100 * 1024 * 1024);
});

test('data URLs accept bounded images, videos and audio only', () => {
  assert.equal(mediaDataUrl(new Uint8Array([1, 2, 3]), 'image/png; charset=binary'), 'data:image/png;base64,AQID');
  assert.equal(mediaDataUrl(new Uint8Array([1, 2, 3]), 'video/mp4'), 'data:video/mp4;base64,AQID');
  assert.equal(mediaDataUrl(new Uint8Array([1, 2, 3]), 'audio/ogg; codecs=opus'), 'data:audio/ogg;base64,AQID', 'what every voice note measured is sent as');
  assert.throws(() => mediaDataUrl(new Uint8Array([1]), 'text/html'));
  assert.throws(() => mediaDataUrl(new Uint8Array([1]), 'image/svg+xml'));
  assert.throws(() => mediaDataUrl(new Uint8Array([1]), 'audio/svg+xml'), 'a type the player would open as a document is refused however it is spelled');
  assert.throws(() => mediaDataUrl(new Uint8Array(IMAGE_LIMIT + 1), 'image/jpeg'));
  assert.throws(() => mediaDataUrl(new Uint8Array(VIDEO_LIMIT + 1), 'video/mp4'));
  assert.throws(() => mediaDataUrl(new Uint8Array(AUDIO_LIMIT + 1), 'audio/ogg'), /too large to show here/);
  assert.equal(mediaDataUrl(new Uint8Array(AUDIO_LIMIT), 'audio/ogg').length, 'data:audio/ogg;base64,'.length + Math.ceil(AUDIO_LIMIT / 3) * 4);
});

test('a file payload keeps the declared type, falls back to a binary type, and obeys the attachment ceiling', () => {
  assert.deepEqual(attachmentPayload(new Uint8Array([1, 2, 3]), { mime: 'application/pdf', filename: 'Contract.pdf' }), {
    dataUrl: 'data:application/pdf;base64,AQID',
    mime: 'application/pdf',
    filename: 'Contract.pdf',
    size: 3,
  });
  // A type that is not a type is not passed through: a data URL is a frame that renders what it says.
  assert.equal(attachmentPayload(new Uint8Array([1]), { mime: 'not a mime; text/html', filename: 'x' }).mime, 'application/octet-stream');
  assert.equal(attachmentPayload(new Uint8Array([1]), { filename: 'x' }).mime, 'application/octet-stream');
  assert.throws(() => attachmentPayload(new Uint8Array(ATTACHMENT_LIMIT + 1), { filename: 'big.zip' }), /too large to open here/);
  assert.equal(attachmentPayload(new Uint8Array(ATTACHMENT_LIMIT), { filename: 'edge.zip' }).size, ATTACHMENT_LIMIT);
});
