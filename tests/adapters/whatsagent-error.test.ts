import { test } from 'node:test';
import assert from 'node:assert/strict';
import { whatsAgentError } from '../../src/adapters/whatsagent.ts';

const result = (text: string) => ({ isError: true, content: [{ type: 'text' as const, text }] });

test('reports known WhatsAgent media failures without exposing identifiers', () => {
  assert.match(whatsAgentError('load-media', result('{"status":502,"error":"Media download failed","reason":"transient","id":"private-id"}')).message, /temporarily failed/i);
  assert.match(whatsAgentError('load-media', result('{"status":410,"reason":"unavailable"}')).message, /no longer available/i);
  assert.match(whatsAgentError('load-media', result('{"status":503}')).message, /connection.*unavailable/i);
  assert.match(whatsAgentError('load-media', result('{"status":404}')).message, /not found/i);
});

test('untrusted and malformed errors never leak provider content', () => {
  for (const text of ['secret-token', '{"status":502,"reason":"private-id","error":"secret-token"}', '{}']) {
    const message = whatsAgentError('load-media', result(text)).message;
    assert.doesNotMatch(message, /secret-token|private-id/);
    assert.match(message, /WhatsAgent/);
  }
  assert.doesNotMatch(whatsAgentError('other', result('{"status":410,"error":"private-id"}')).message, /private-id/);
});
