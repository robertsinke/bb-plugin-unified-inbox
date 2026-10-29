import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { expandEmailScrollRegions } from '../src/mail-scroll.ts';

type Region = { clientHeight: number; scrollHeight: number; style: { values: Record<string, string>; setProperty(name: string, value: string): void } };
function region(clientHeight: number, scrollHeight: number): Region {
  return { clientHeight, scrollHeight, style: { values: {}, setProperty(name, value) { this.values[name] = value; } } };
}

test('expands email elements that declare their own vertical scrolling', () => {
  const nested = region(120, 900);
  const alreadyFits = region(120, 120);
  const clipped = region(120, 900);
  const overflow = new Map([[nested, 'auto'], [alreadyFits, 'scroll'], [clipped, 'hidden']]);
  const count = expandEmailScrollRegions([nested, alreadyFits, clipped], element => ({ overflowY: overflow.get(element) ?? 'visible' }));

  assert.equal(count, 2);
  assert.deepEqual(nested.style.values, { overflow: 'visible', height: 'auto', 'max-height': 'none' });
  assert.deepEqual(alreadyFits.style.values, { overflow: 'visible', height: 'auto', 'max-height': 'none' });
  assert.deepEqual(clipped.style.values, {});
});

test('expands both auto and scroll overflow regions', () => {
  const auto = region(50, 100);
  const scroll = region(60, 160);
  const count = expandEmailScrollRegions([auto, scroll], () => ({ overflowY: 'scroll' }));
  assert.equal(count, 2);
});
