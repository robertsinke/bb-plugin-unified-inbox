// The media descriptor the panel draws: which kinds are rendered, whether the bytes are cached, and
// whether a failure is terminal. Read off the stored row, never guessed.
import assert from 'node:assert/strict';
import test from 'node:test';
import { whatsAppMedia } from '../src/whatsapp-media.ts';

test('renders pictures, stickers, videos and documents, and nothing else', () => {
  assert.deepEqual(whatsAppMedia({ id: 'm1', type: 'image', media_ref: 'media/a.jpg', media_state: 'ready' }), {
    messageId: 'm1',
    kind: 'image',
    cached: true,
    available: true,
  });
  assert.equal(whatsAppMedia({ id: 'm2', type: 'sticker', media_state: 'failed' })?.kind, 'sticker');
  assert.deepEqual(whatsAppMedia({ id: 'm3', type: 'video', media_state: 'placeholder' }), {
    messageId: 'm3',
    kind: 'video',
    cached: false,
    available: true,
  });
  assert.equal(whatsAppMedia({ id: 'm4', type: 'audio', media_ref: 'media/a.ogg', media_state: 'ready' }), undefined, 'audio has no player yet');
  assert.equal(whatsAppMedia({ id: '', type: 'image' }), undefined);
});

test('a document carries the name, size and type its envelope declared', () => {
  assert.deepEqual(whatsAppMedia({ id: 'd1', type: 'document', media_state: 'ready' }, { filename: 'Contract v2.pdf', size: 1024, mime: 'application/pdf' }), {
    messageId: 'd1',
    kind: 'document',
    cached: false,
    available: true,
    filename: 'Contract v2.pdf',
    size: 1024,
    mime: 'application/pdf',
  });
  assert.deepEqual(
    whatsAppMedia({ id: 'd2', type: 'document', media_ref: 'media/a.bin', media_state: 'ready' }),
    { messageId: 'd2', kind: 'document', cached: true, available: true },
    'a row with no envelope facts is still a document, chip unnamed rather than unrendered',
  );
});

test('a cached picture is ready only when a ref was written', () => {
  assert.equal(whatsAppMedia({ id: 'm', type: 'image', media_ref: 'media/a.jpg', media_state: 'ready' })?.cached, true);
  assert.equal(whatsAppMedia({ id: 'm', type: 'image', media_state: 'ready' })?.cached, false, 'a state without a ref has no bytes');
  assert.equal(whatsAppMedia({ id: 'm', type: 'image', media_ref: 'media/a.jpg', media_state: 'downloading' })?.cached, false);
});

test('an unavailable failure is terminal and a transient one is not', () => {
  assert.equal(whatsAppMedia({ id: 'm', type: 'image', media_error: 'unavailable' })?.available, false);
  assert.equal(whatsAppMedia({ id: 'm', type: 'image', media_error: 'transient' })?.available, true);
  assert.equal(whatsAppMedia({ id: 'm', type: 'image', media_error: null })?.available, true);
});
