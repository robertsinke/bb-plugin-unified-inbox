// U1 — what a failed send means, and the polarity that keeps a real message from being reported lost.
import assert from 'node:assert/strict';
import test from 'node:test';
import { classifySendFailure, failureMessage } from '../../src/whatsapp/failure.ts';
import { WhatsAppDisconnectedError } from '../../src/whatsapp/send.ts';

function boom(statusCode: number): Error {
  const error = new Error(`status ${statusCode}`) as Error & { output: { statusCode: number } };
  error.output = { statusCode };
  return error;
}

test('connection-lifecycle statuses are transient, not rejections', () => {
  for (const status of [408, 411, 428, 429, 440]) {
    assert.equal(classifySendFailure(boom(status)), 'transient', `${status} means the socket went away`);
  }
});

test('an unknown error is transient: the outcome is unknown, so the panel says so', () => {
  assert.equal(classifySendFailure(new Error('kaboom')), 'transient');
  assert.equal(classifySendFailure('not even an error'), 'transient');
  assert.equal(classifySendFailure(undefined), 'transient');
});

test('a rejected payload is terminal', () => {
  assert.equal(classifySendFailure(boom(400)), 'terminal');
  assert.equal(classifySendFailure(boom(403)), 'terminal');
});

test('a 5xx is transient: nothing was rejected, the server failed', () => {
  assert.equal(classifySendFailure(boom(500)), 'transient');
});

test('no socket is offline, and that is not a provider failure', () => {
  assert.equal(classifySendFailure(new WhatsAppDisconnectedError()), 'offline');
});

test('a failure reason is one line and bounded', () => {
  assert.equal(failureMessage(new Error('  two\n  lines  ')), 'two lines');
  assert.equal(failureMessage(''), 'Send failed');
  assert.equal(failureMessage(new Error('x'.repeat(400))).length, 300);
});
