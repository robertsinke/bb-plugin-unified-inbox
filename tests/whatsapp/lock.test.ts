// U1 — one socket per account state. A second acquire is refused while the lock is held; a lock whose
// holder is gone is stale and is replaced.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { acquireWhatsAppLock, WhatsAppLockError } from '../../src/whatsapp/lock.ts';

async function emptyDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'wa-lock-'));
}

test('a second acquire on the same directory is refused while the lock is held', async () => {
  const dir = await emptyDir();
  const held = acquireWhatsAppLock(dir);
  const refused = (() => {
    try {
      acquireWhatsAppLock(dir);
      return undefined;
    } catch (error) {
      return error;
    }
  })();

  assert.ok(refused instanceof WhatsAppLockError, 'the refusal is a named error, not an opaque one');
  assert.equal((refused as WhatsAppLockError).holderPid, process.pid);
  held.release();
});

test('the lock succeeds again after the holder releases it', async () => {
  const dir = await emptyDir();
  const first = acquireWhatsAppLock(dir);
  first.release();
  first.release(); // idempotent: a dispose hook and a stop may both call it

  const second = acquireWhatsAppLock(dir);
  second.release();
});

test('a lock left by a process that is gone is stale and is replaced', async () => {
  const dir = await emptyDir();
  // Pid 999999 is not this machine's process table by any realistic reading; the rule under test is
  // "the holder is not alive", not the number itself.
  await writeFile(join(dir, 'socket.lock'), `${JSON.stringify({ pid: 999_999, at: Date.now() })}\n`);

  const lock = acquireWhatsAppLock(dir);
  lock.release();
});

test('an unparseable lock file cannot name a live holder, so it is stale', async () => {
  const dir = await emptyDir();
  await writeFile(join(dir, 'socket.lock'), 'garbage');

  const lock = acquireWhatsAppLock(dir);
  lock.release();
});
