// The `gws` CLI runner (Migration state 3). It owns how the plugin talks to the
// CLI: one serialized call at a time, one credential directory per account, and
// a send whose body travels in a private temporary file rather than process
// arguments. It synthesizes no failure text — a rejection is the raw cause, and
// the adapter normalizes it through the provider-error factory.
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createAsyncGate, createAsyncPool } from '../async-gate.ts';
import type { GmailAccount } from './types.ts';

const exec = promisify(execFile);

/**
 * Reads that may overlap: a CLI call spends ~0.4s of CPU on its own startup, so twenty of them
 * one after another is a long wait and twenty at once fights for the machine. Six is where the
 * measured curve flattens. The serialized gate below still owns sends.
 */
const READ_CONCURRENCY = 6;

/** Installed CLI path; the runner does not search PATH. */
const GWS_BINARY = '/usr/local/bin/gws';

/** Google Workspace CLI credential directory, one per Gmail account. */
function gwsConfigDir(account: GmailAccount): string {
  return join(homedir(), account === 'business' ? '.config/gws-inhouse' : '.config/gws');
}

/** What the Gmail adapter needs from the CLI: a parsed read, and a send that reports its message id. */
export interface GwsRunner {
  call(account: GmailAccount, args: string[]): Promise<any>;
  /** Send one RFC 822 message; resolves with the CLI's response. */
  send(account: GmailAccount, message: { raw: string | Uint8Array; threadId?: string }): Promise<any>;
}

export function createGwsRunner(): GwsRunner {
  const reads = createAsyncPool(READ_CONCURRENCY);
  const sends = createAsyncGate();
  return {
    call(account, args) {
      return reads(async () => {
        const { stdout } = await exec(GWS_BINARY, ['gmail', ...args], {
          env: { ...process.env, GOOGLE_WORKSPACE_CLI_CONFIG_DIR: gwsConfigDir(account) },
          timeout: 30_000,
          maxBuffer: 8 * 1024 * 1024,
        });
        return JSON.parse(stdout);
      });
    },

    send(account, message) {
      return sends(async () => {
        const dir = await mkdtemp(join(tmpdir(), 'bb-inbox-mail-'));
        try {
          await writeFile(join(dir, 'message.eml'), message.raw, { mode: 0o600 });
          const { stdout } = await exec(GWS_BINARY, [
            'gmail', 'users', 'messages', 'send',
            '--params', JSON.stringify({ userId: 'me' }),
            '--json', JSON.stringify(message.threadId ? { threadId: message.threadId } : {}),
            '--upload', 'message.eml', '--upload-content-type', 'message/rfc822',
          ], { cwd: dir, env: { ...process.env, GOOGLE_WORKSPACE_CLI_CONFIG_DIR: gwsConfigDir(account) }, timeout: 30_000, maxBuffer: 1024 * 1024 });
          return JSON.parse(stdout);
        } finally { await rm(dir, { recursive: true, force: true }); }
      });
    },
  };
}
