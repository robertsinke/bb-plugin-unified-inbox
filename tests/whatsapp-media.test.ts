// The media descriptor the panel draws: which kinds are rendered, whether the bytes are cached, and
// whether a failure is terminal. Read off the stored row, never guessed.
import assert from 'node:assert/strict';
import test from 'node:test';
import { whatsAppMedia } from '../src/whatsapp-media.ts';

test('renders pictures, stickers, videos, audio and documents, and nothing else', () => {
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
  assert.deepEqual(whatsAppMedia({ id: 'm4', type: 'audio', media_ref: 'media/a.ogg', media_state: 'ready' }), {
    messageId: 'm4',
    kind: 'audio',
    cached: true,
    available: true,
  }, 'an audio message is media the panel draws, with a player');
  assert.equal(whatsAppMedia({ id: '', type: 'image' }), undefined);
  assert.equal(whatsAppMedia({ id: 'm5', type: 'reaction' }), undefined, 'a kind the panel does not draw has no media');
});

test('a voice note carries the length and the voice flag its envelope declared', () => {
  assert.deepEqual(whatsAppMedia({ id: 'v1', type: 'audio', media_state: 'placeholder' }, { seconds: 69, voice: true, mime: 'audio/ogg; codecs=opus', size: 175_401 }), {
    messageId: 'v1',
    kind: 'audio',
    cached: false,
    available: true,
    seconds: 69,
    voice: true,
    mime: 'audio/ogg; codecs=opus',
    size: 175_401,
  }, 'the player is labelled from the envelope, before any byte is fetched');
  assert.deepEqual(
    whatsAppMedia({ id: 'v2', type: 'audio', media_ref: 'media/b.ogg', media_state: 'ready' }),
    { messageId: 'v2', kind: 'audio', cached: true, available: true },
    'a row with no envelope facts is still a player, unnamed rather than unrendered',
  );
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
