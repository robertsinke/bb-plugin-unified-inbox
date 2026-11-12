import test from 'node:test';
import assert from 'node:assert/strict';
import { redactInferenceValue } from '../src/inference-redaction.ts';

test('redacts email and phone without masking names or ordinary words', async () => {
  const input = { text: 'Olivia: WHO still needs a place? Email maria@gmail.com or call +31 6 12345678.', count: 1 };
  const result = await redactInferenceValue(input) as typeof input;
  assert.match(result.text, /Olivia: WHO still needs a place/);
  assert.doesNotMatch(result.text, /maria@gmail\.com|12345678/);
  assert.equal(result.count, 1);
  assert.match(input.text, /maria@gmail\.com/);
});

test('also masks example-domain addresses that the detector ignores', async () => {
  assert.doesNotMatch(await redactInferenceValue('john@example.com') as string, /john@example\.com/);
});
