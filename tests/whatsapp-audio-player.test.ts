// The audio player, as the panel declares it. `app.tsx` is one file with one default export, so the
// component is read from its source rather than rendered — what is asserted is the contract a render
// would show: the bubble routes audio to a player, the player is a player and not a frame, and a
// thread of voice notes does not start talking when it opens.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const app = readFileSync(new URL('../app.tsx', import.meta.url), 'utf8');

/** One top-level component's body, from its declaration to the next one. */
function component(name: string): string {
  const start = app.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} is declared in app.tsx`);
  const next = app.indexOf('\nfunction ', start + 1);
  return app.slice(start, next === -1 ? undefined : next);
}

test('a bubble draws audio as a player, not as the image fallback', () => {
  const bubble = component('ChatBubble');
  assert.match(bubble, /m\.media\?\.kind === 'audio' \? <WhatsAppAudio /, 'audio has its own branch before the image fallback');
  assert.ok(
    bubble.indexOf("kind === 'audio'") < bubble.indexOf('<WhatsAppImage'),
    'and it comes before the branch that would draw audio as a picture',
  );
});

test('the player is a player: controls, no autoplay, and the length from the envelope', () => {
  const player = component('WhatsAppAudio');
  assert.match(player, /<audio [^>]*controls/, 'the browser draws the controls, so there is no second play button');
  assert.match(player, /preload="none"/, 'a thread of voice notes must not download or decode on open');
  assert.doesNotMatch(player, /autoPlay/i, 'nothing in a thread starts talking by itself');
  assert.match(player, /formatDuration\(media\.seconds\)/, 'the duration is the envelope\'s, so it is shown before playback');
  assert.match(player, /no longer available from WhatsApp/, 'expired bytes are the same line a document gets');
});

test('the player asks for media through the one request shape the panel already uses', () => {
  const player = component('WhatsAppAudio');
  assert.match(player, /useMediaSource\(media\)/, 'the fetch is the shared one, not a second request shape');
  const source = component('useMediaSource');
  assert.match(source, /kind: 'message'/, 'one slot on one message, exactly as a picture is asked for');
});
