// U1 — the version probe and its fallback are one decision: ship both or the panel says "Connecting…".
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  resolveWhatsAppWebVersion,
  VERSION_PROBE_TIMEOUT_MS,
  WA_WEB_VERSION_FALLBACK,
} from '../../src/whatsapp/version.ts';

test('a probe that answers gives its version', async () => {
  const version = await resolveWhatsAppWebVersion(async () => ({ version: [2, 3001, 1050000000] }));
  assert.deepEqual(version, [2, 3001, 1050000000]);
});

test('a probe that times out resolves the fallback constant', async () => {
  const timeout = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
  const resolved = await resolveWhatsAppWebVersion(async () => {
    throw timeout;
  });
  assert.deepEqual(resolved, WA_WEB_VERSION_FALLBACK);
});

test('a probe that answers with an error resolves the fallback constant', async () => {
  const resolved = await resolveWhatsAppWebVersion(async () => ({
    version: [0, 0, 0],
    error: new Error('fetch failed'),
  }));
  assert.deepEqual(resolved, WA_WEB_VERSION_FALLBACK);
});

test('the probe budget is the 10 s the plan promises', () => {
  assert.equal(VERSION_PROBE_TIMEOUT_MS, 10_000);
});
