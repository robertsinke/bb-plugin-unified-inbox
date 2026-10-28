import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { whatsappTimestamp } from '../src/timestamps.ts';

test('normalizes WhatsApp seconds to milliseconds without changing milliseconds', () => {
  assert.equal(whatsappTimestamp(1793206852), 1793206852000);
  assert.equal(whatsappTimestamp(1793206852000), 1793206852000);
});
test('handles invalid and missing timestamps safely', () => {
  for (const value of [null, undefined, NaN, Infinity, -1, 0, 'bad']) assert.equal(whatsappTimestamp(value), 0);
});
