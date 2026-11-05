// Two shapes a person reads in a bubble: a byte count and a media length. The length comes from a voice
// note's envelope, so the player is labelled before any byte of it is decoded.
import assert from 'node:assert/strict';
import test from 'node:test';
import { formatBytes, formatDuration } from '../src/format.ts';

test('a length is minutes and seconds, and hours only when it has them', () => {
  assert.equal(formatDuration(7), '0:07');
  assert.equal(formatDuration(69), '1:09');
  assert.equal(formatDuration(60), '1:00');
  assert.equal(formatDuration(59.6), '1:00', 'a declared length is a float and is rounded, not truncated');
  assert.equal(formatDuration(3723), '1:02:03');
  assert.equal(formatDuration(0), '0:00');
  assert.equal(formatDuration(-5), '0:00', 'a nonsense length is not a negative time');
});

test('a byte count stays exact while it is small enough to be counted', () => {
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(5_184), '5 KB');
  assert.equal(formatBytes(175_401), '171 KB');
  assert.equal(formatBytes(4 * 1024 * 1024), '4.0 MB');
});
