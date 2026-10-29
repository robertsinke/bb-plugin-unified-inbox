import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactProviderText, toProviderError } from '../../src/adapters/provider-error.ts';
import type { ProviderError } from '../../src/adapters/types.ts';

const TOKEN = 'ya29.a0AfH6SMBx9TcdefGHijklmnopqrstuvwxyz1234567890';
const BLOB = 'c2Vzc2lvbi1rZXktMTIzNDU2Nzg5MGFiY2RlZmdoaWprbG1ub3BxcnN0dXY=';
const PASSWORD = 'hunter2-super-secret-passphrase';

test('redactProviderText strips labeled secrets, oauth tokens, and opaque runs', () => {
  const input = `Authorization: Bearer ${TOKEN} password=${PASSWORD} junk ${BLOB} plain words`;
  const output = redactProviderText(input);
  assert.ok(!output.includes(TOKEN), 'oauth token must not survive');
  assert.ok(!output.includes(PASSWORD), 'labeled password must not survive');
  assert.ok(!output.includes(BLOB), 'opaque blob must not survive');
  assert.ok(output.includes('[redacted]'), 'redaction marker present');
  assert.ok(output.includes('plain words'), 'innocuous text preserved');
});

test('redactProviderText collapses whitespace and truncates to 300 characters', () => {
  const output = redactProviderText('a\n\nb   c\n' + 'x'.repeat(400));
  assert.ok(!output.includes('\n'));
  assert.ok(output.length <= 300);
});

test('toProviderError never embeds raw stderr or stdout', () => {
  const cause = Object.assign(new Error('gws exited'), {
    code: 'ENOENT',
    stderr: `PRIVATE: could not read /Users/robert/.config/gws/credentials.json ${TOKEN}`,
    stdout: `{"secret":"${BLOB}","conversation":"private text"}`,
  });
  const err = toProviderError('personal', 'gmail', cause);
  assert.equal(err.account, 'personal');
  assert.equal(err.source, 'gmail');
  assert.ok(!err.message.includes('PRIVATE'), 'stderr line must not survive');
  assert.ok(!err.message.includes('private text'), 'stdout content must not survive');
  assert.ok(!err.message.includes(TOKEN) && !err.message.includes(BLOB), 'tokens must not survive');
  assert.ok(err.message.includes('ENOENT'), 'code propagated');
  assert.ok(err.message.includes('credentials'), 'safe hint word kept');
  assert.ok(err.message.length <= 300);
  assert.ok(!/\n/.test(err.message));
});

test('toProviderError classifies hints lowercased, deduped, and sorted', () => {
  const cause = Object.assign(new Error('Keyring LOCKED'), { code: 1, stderr: 'denied! denied again; token refresh needed' });
  const err = toProviderError('business', 'gmail', cause);
  const hints = err.message.slice(err.message.indexOf('(') + 1, err.message.indexOf(')'));
  assert.equal(hints, '1; denied, keyring, locked, token');
});

test('toProviderError redacts secrets carried in an exception message', () => {
  const cause = new Error(`request failed: Bearer ${TOKEN} session ${BLOB}`);
  const err = toProviderError('whatsapp', 'whatsapp', cause);
  assert.ok(!err.message.includes(TOKEN) && !err.message.includes(BLOB), 'secrets must not survive');
  assert.ok(err.message.includes('[redacted]'));
  assert.ok(err.message.includes('whatsapp whatsapp request failed (unknown)'));
});

test('toProviderError handles non-Error causes without throwing', () => {
  const err = toProviderError('imessage', 'imsg', 'imsg timeout');
  assert.ok(err.message.includes('imsg imessage request failed'));
  assert.ok(err.message.includes('timeout'));
  assert.ok((err as ProviderError).message.length <= 300);
});