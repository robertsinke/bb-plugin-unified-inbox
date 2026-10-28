import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createMediaCache } from '../src/media-cache.ts';

test('media cache returns recent entries and refreshes their age', () => {
  const cache = createMediaCache({ maxEntries: 2 });
  cache.set('a', 'url-a');
  cache.set('b', 'url-b');
  assert.equal(cache.get('a'), 'url-a');
  cache.set('c', 'url-c');
  assert.equal(cache.get('b'), undefined);
  assert.equal(cache.get('a'), 'url-a');
  assert.equal(cache.get('c'), 'url-c');
});

test('media cache evicts by byte budget as well as entry count', () => {
  const cache = createMediaCache({ maxBytes: 10, maxEntries: 10 });
  cache.set('a', '12345');
  cache.set('b', '123456');
  assert.equal(cache.get('a'), undefined);
  assert.equal(cache.bytes, 6);
  cache.set('b', '12');
  assert.equal(cache.size, 1);
  assert.equal(cache.bytes, 2);
});
