// U1 — the account state is a secret: 0700 directory, 0600 files, and a blob that will not decrypt is
// refused rather than replaced. Real files in a temp directory; no socket, no network.
import assert from 'node:assert/strict';
import { stat, truncate, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  accountStateSummary,
  AUTH_DIR_MODE,
  AUTH_FILE_MODE,
  createFileAuthStore,
  loadAuthKey,
} from '../../src/whatsapp/auth.ts';

async function emptyDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'wa-auth-'));
}

test('creds and one key type round-trip through a second store', async () => {
  const dir = await emptyDir();
  const first = createFileAuthStore(dir);
  const original = first.state.creds.registrationId;
  // `creds` is readonly on Baileys' type; the store is what makes the value durable, so the test
  // writes one field through the same object Baileys would.
  (first.state.creds as { registrationId: number }).registrationId = original + 1;
  await first.saveCreds();
  await first.state.keys.set({ 'pre-key': { 42: { public: 'pub' } } } as never);

  const second = createFileAuthStore(dir);
  assert.equal(second.state.creds.registrationId, original + 1);
  const keys = await second.state.keys.get('pre-key', ['42']);
  assert.deepEqual(keys['42'], { public: 'pub' });
  assert.equal(second.hasCreds(), true);
});

test('the directory is 0700 and every file in it is 0600', async () => {
  const dir = await emptyDir();
  const store = createFileAuthStore(dir);
  await store.saveCreds();
  await store.state.keys.set({ 'pre-key': { 7: { public: 'pub' } } } as never);

  const summary = accountStateSummary(dir);
  assert.equal(summary.dirMode, AUTH_DIR_MODE);
  assert.equal(summary.fileCount, 3, 'key, creds, and one signal key');

  const keyMode = (await stat(join(dir, 'key'))).mode & 0o777;
  const credsMode = (await stat(join(dir, 'creds'))).mode & 0o777;
  assert.equal(keyMode, AUTH_FILE_MODE);
  assert.equal(credsMode, AUTH_FILE_MODE);
});

test('an unpaired directory is reported as absent rather than thrown', async () => {
  const dir = join(await emptyDir(), 'not-yet');
  const summary = accountStateSummary(dir);
  assert.deepEqual(summary, { dir, dirMode: 0, fileCount: 0 });
});

test('a truncated blob is refused, not parsed and not replaced', async () => {
  const dir = await emptyDir();
  const store = createFileAuthStore(dir);
  await store.saveCreds();
  await truncate(join(dir, 'creds'), 20);

  assert.throws(() => createFileAuthStore(dir), /truncated/);
  // The refusal must leave the (broken) state in place: regenerating an identity is a re-pair.
  assert.equal((await stat(join(dir, 'creds'))).size, 20);
});

test('a blob encrypted under another key is refused', async () => {
  const dir = await emptyDir();
  const store = createFileAuthStore(dir);
  await store.saveCreds();

  // A different, equally valid 32-byte master key: the ciphertext is now someone else's.
  await writeFile(join(dir, 'key'), `${Buffer.alloc(32, 7).toString('base64')}\n`, { mode: AUTH_FILE_MODE });
  assert.throws(() => createFileAuthStore(dir), /cannot be decrypted/);
});

test('a corrupt key file is reported by name rather than silently replaced', async () => {
  const dir = await emptyDir();
  await writeFile(join(dir, 'key'), 'not-a-32-byte-key\n', { mode: AUTH_FILE_MODE });
  assert.throws(() => loadAuthKey(dir), /corrupt/);
});

test('clear() forgets the account state and a fresh store starts unpaired', async () => {
  const dir = await emptyDir();
  const store = createFileAuthStore(dir);
  await store.saveCreds();
  assert.equal(store.hasCreds(), true);

  await store.clear();
  const reopened = createFileAuthStore(dir);
  assert.equal(reopened.hasCreds(), false);
  assert.equal(accountStateSummary(dir).fileCount, 1, 'only the master key survives');
});
