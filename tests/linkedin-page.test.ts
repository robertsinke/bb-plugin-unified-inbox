import assert from 'node:assert/strict';
import test from 'node:test';
import { linkedinPageExpression } from '../src/linkedin-page.ts';

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (...args: string[]) => Function;

test('LinkedIn Browser-page expression compiles and reads only through same-origin fetch', () => {
  const expression = linkedinPageExpression({ mode: 'list' });
  assert.doesNotThrow(() => new AsyncFunction(`return (${expression});`));
  assert.match(expression, /credentials: 'include'/);
  assert.match(expression, /voyagerMessagingGraphQL/);
  assert.doesNotMatch(expression, /\.goto\(|browser\.getPage|document\.cookie\s*=/);
});

test('LinkedIn thread identifier is safely serialized into the page expression', () => {
  const expression = linkedinPageExpression({ mode: 'thread', id: 'urn:li:msg_conversation:123' });
  assert.match(expression, /urn:li:msg_conversation:123/);
  assert.doesNotThrow(() => new AsyncFunction(`return (${expression});`));
});
