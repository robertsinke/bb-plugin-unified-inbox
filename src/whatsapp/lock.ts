// One live socket per account state (plan D3, requirement R6).
//
// Two sockets presenting one device identity is the failure WhatsApp punishes with
// `connectionReplaced` (440): the session flaps, a device slot burns, and the fix is a re-pair,
// which is the ban lever. Today that invariant is held by an external fact — one WhatsAgent process
// per machine. In the plugin it is this module's job, because `bb plugin reload` exists and a second
// BB can be pointed at the same data directory.
//
// An `O_EXCL` file holding the holder's pid, in the same 0700 directory as the account state. A file
// whose pid is gone is stale and is replaced; a file whose pid is ours or a live process's is a
// refusal, never a takeover.
import { closeSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { ensureAuthDir, whatsAppAuthDir, AUTH_FILE_MODE } from './auth.ts';

const LOCK_FILE = 'socket.lock';

export class WhatsAppLockError extends Error {
  readonly holderPid?: number;

  constructor(message: string, holderPid?: number) {
    super(message);
    this.name = 'WhatsAppLockError';
    this.holderPid = holderPid;
  }
}

export interface WhatsAppLock {
  readonly path: string;
  /** Idempotent: a dispose hook and a stop may both reach it. */
  release(): void;
}

function readHolder(path: string): number | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { pid?: unknown };
    return typeof parsed.pid === 'number' && Number.isInteger(parsed.pid) ? parsed.pid : undefined;
  } catch {
    // Unparseable means a writer died mid-write; the pid cannot be trusted, so it is stale.
    return undefined;
  }
}

function isAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists and is not ours. ESRCH: it is gone.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Take the socket lock for one account state. Throws {@link WhatsAppLockError} when another live
 * process holds it, naming that pid — a bare "in use" would send the reader looking for a ghost.
 */
export function acquireWhatsAppLock(dir = whatsAppAuthDir()): WhatsAppLock {
  ensureAuthDir(dir);
  const path = join(dir, LOCK_FILE);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(path, 'wx', AUTH_FILE_MODE);
      try {
        writeSync(fd, `${JSON.stringify({ pid: process.pid, at: Date.now() })}\n`);
      } finally {
        closeSync(fd);
      }
      let released = false;
      return {
        path,
        release() {
          if (released) return;
          released = true;
          rmSync(path, { force: true });
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const holder = readHolder(path);
      if (holder !== undefined && isAlive(holder)) {
        throw new WhatsAppLockError(
          `WhatsApp socket for ${dir} is already open in process ${holder}; `
            + 'close it there rather than opening a second one',
          holder,
        );
      }
      rmSync(path, { force: true });
    }
  }

  throw new WhatsAppLockError('WhatsApp socket lock could not be taken; another process keeps replacing it');
}
