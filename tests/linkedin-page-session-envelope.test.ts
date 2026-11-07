import assert from 'node:assert/strict';
import test from 'node:test';
import { linkedinReadResult } from '../src/linkedin-page-session.ts';

// Moved with `linkedinReadResult` when the page seam took ownership of the envelope: the same
// coverage, now beside the module that decides it.
test('read results map to a payload or to an actionable sign-in message', () => {
  assert.deepEqual(linkedinReadResult({ ok: true, payload: { conversations: [] } }), { conversations: [] });
  assert.throws(() => linkedinReadResult({ ok: false, error: 'LinkedIn 401 for /voyager/api/me' }), /sign in again.*linkedin-signin/s);
  assert.throws(() => linkedinReadResult({ ok: false, error: 'LinkedIn 500 for /voyager/api/me' }), /^Error: LinkedIn 500/);
  assert.throws(() => linkedinReadResult({ ok: false, error: 'TypeError: Failed to fetch' }), /^Error: LinkedIn could not reach the network\.$/);
  assert.throws(() => linkedinReadResult({ ok: false, error: 'boom' }), /^Error: LinkedIn is unavailable in its browser\.$/);
  assert.throws(() => linkedinReadResult(null), /usable response/);
});
