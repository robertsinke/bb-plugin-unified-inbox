// The `gws` CLI runner (Migration state 3). It owns how the plugin talks to the
// CLI: one serialized call at a time, one credential directory per account, and
// a send whose body travels in a private temporary file rather than process
// arguments. It implements `GmailTransport` — the same contract the plugin's own
// HTTPS client implements — by translating typed calls into argv, so the adapter
// never learns a CLI vocabulary. It synthesizes no failure text: a rejection is
// the raw cause (an `execFile` error keeps its code and stderr), and the adapter
// normalizes it through the provider-error factory.
//
// U5 deletes this module once both accounts read through `src/gmail-client.ts`.
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createAsyncGate, createAsyncPool } from '../async-gate.ts';
import type { GmailAccount, GmailReadInput, GmailTransport } from './types.ts';

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
  return join(homedir(), account === 'gmail-business' ? '.config/gws-inhouse' : '.config/gws');
}

/** A `--params` payload. An absent argument is left out, so the CLI applies its own default. */
function params(fields: Record<string, unknown>): string {
  return JSON.stringify(Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)));
}

/** `users.<kind>.get` argv, which is where a format and its header list travel. */
function readArgs(kind: 'threads' | 'messages', input: GmailReadInput): string[] {
  const payload = { userId: 'me', id: input.id, format: input.format ?? 'full', metadataHeaders: input.metadataHeaders };
  return ['users', kind, 'get', '--params', params(payload)];
}

export function createGwsRunner(): GmailTransport {
  const reads = createAsyncPool(READ_CONCURRENCY);
  const sends = createAsyncGate();

  /** One read, pooled, parsed. The rejection is `execFile`'s own error, untouched. */
  const read = (account: GmailAccount, args: string[]): Promise<any> => reads(async () => {
    const { stdout } = await exec(GWS_BINARY, ['gmail', ...args], {
      env: { ...process.env, GOOGLE_WORKSPACE_CLI_CONFIG_DIR: gwsConfigDir(account) },
      timeout: 30_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    return JSON.parse(stdout);
  });

  return account => ({
    profile: () => read(account, ['users', 'getProfile', '--params', params({ userId: 'me' })]),

    threadsList: (input = {}) => read(account, ['users', 'threads', 'list', '--params', params({
      userId: 'me', labelIds: input.labelIds, maxResults: input.maxResults, pageToken: input.pageToken,
    })]),

    threadGet: input => read(account, readArgs('threads', input)),

    threadsModify: input => read(account, [
      'users', 'threads', 'modify',
      '--params', params({ userId: 'me', id: input.id }),
      '--json', JSON.stringify({ addLabelIds: input.addLabelIds ?? [], removeLabelIds: input.removeLabelIds ?? [] }),
    ]),

    messageGet: input => read(account, readArgs('messages', input)),

    async attachmentGet(input) {
      const answer = await read(account, ['users', 'messages', 'attachments', 'get', '--params', params({
        userId: 'me', messageId: input.messageId, id: input.id,
      })]);
      if (typeof answer?.data !== 'string' || !answer.data) throw new Error(`gws returned no data for attachment ${input.id}`);
      return Buffer.from(answer.data, 'base64url');
    },

    sendRaw(input) {
      return sends(async () => {
        const dir = await mkdtemp(join(tmpdir(), 'bb-inbox-mail-'));
        try {
          await writeFile(join(dir, 'message.eml'), input.raw, { mode: 0o600 });
          const { stdout } = await exec(GWS_BINARY, [
            'gmail', 'users', 'messages', 'send',
            '--params', JSON.stringify({ userId: 'me' }),
            '--json', JSON.stringify(input.threadId ? { threadId: input.threadId } : {}),
            '--upload', 'message.eml', '--upload-content-type', 'message/rfc822',
          ], { cwd: dir, env: { ...process.env, GOOGLE_WORKSPACE_CLI_CONFIG_DIR: gwsConfigDir(account) }, timeout: 30_000, maxBuffer: 1024 * 1024 });
          return JSON.parse(stdout);
        } finally { await rm(dir, { recursive: true, force: true }); }
      });
    },
  });
}
