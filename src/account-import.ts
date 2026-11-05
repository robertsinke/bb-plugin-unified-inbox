// The one-time `gws` → plugin credential import (INBOX-12, plan unit U4).
//
// This is the last place in the plugin that runs the `gws` binary, and it exists only so the binary
// can go away. It answers one question — "copy this account's already-working refresh token out of
// its `gws` config directory" — and it is deliberately manual: no timer, no automatic call, nothing
// behind an RPC method. The caller who runs it has decided the account is moving.
//
// Four rules, all of them about not destroying a working credential:
//   - it writes a `source: 'gws-import'` record through `src/gmail-oauth.ts`, so the store stays the
//     single owner of the file's shape and mode;
//   - it refuses to replace an existing record unless the caller says `force`, and names the account
//     that blocked it;
//   - a masked export (`GOCS...ytLc`) is rejected before anything is written, because storing it would
//     look like success and fail on the first read;
//   - every rejection happens before the write, so a malformed export leaves the previous record as
//     it was.
//
// It never prints, returns or throws a client secret or a refresh token: the outcome names the
// account, the path and whether it replaced something, and the CLI prints exactly that.
//
// The import writes credentials only. It does not construct a client, probe the mailbox, or refresh a
// token — that is `GmailTransport`'s job once the record exists.
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { redactProviderText } from './adapters/provider-error.ts';
import type { GmailAccount } from './adapters/types.ts';
import { createGmailCredentials, gmailCredentialPath, type GmailCredentialRecord } from './gmail-oauth.ts';

const exec = promisify(execFile);

/** Installed CLI path, the same one `src/adapters/gws.ts` names: the runner does not search PATH. */
const GWS_BINARY = '/usr/local/bin/gws';

/**
 * Google Workspace CLI credential directory, one per Gmail account. Copied from
 * `src/adapters/gws.ts` rather than imported: U5 deletes that module, and this mapping has to
 * outlive it by exactly one run.
 */
export function gwsConfigDir(account: GmailAccount): string {
  return join(homedir(), account === 'gmail-business' ? '.config/gws-inhouse' : '.config/gws');
}

/** The fields of a `gws auth export` payload the plugin stores; everything else is dropped. */
export interface GwsExport {
  client_id: string;
  client_secret: string;
  refresh_token: string;
}

/**
 * What makes a payload unusable before it can be stored. `...` is how the CLI masks a secret it was
 * not asked to unmask, so a masked field is the difference between a store and a trap.
 */
const MASKED = /\.\.\.|…/;

function field(payload: Record<string, unknown>, name: keyof GwsExport, account: GmailAccount): string {
  const value = payload[name];
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`gws auth export for ${account} has no ${name}; nothing was written.`);
  }
  if (MASKED.test(value)) {
    throw new Error(`gws auth export for ${account} returned a masked ${name}. Run "gws auth export --unmasked" in ${gwsConfigDir(account)}; nothing was written.`);
  }
  return value;
}

/**
 * A `gws auth export` payload, or a reason it cannot be stored. Never echoes a field value: a raw
 * payload is exactly what must not reach a terminal or a log.
 */
export function parseGwsExport(payload: string, account: GmailAccount): GwsExport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new Error(`gws auth export for ${account} did not return JSON; nothing was written.`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`gws auth export for ${account} did not return a JSON object; nothing was written.`);
  }
  const record = parsed as Record<string, unknown>;
  if (record.type !== undefined && record.type !== 'authorized_user') {
    throw new Error(`gws auth export for ${account} is not an authorized_user credential; nothing was written.`);
  }
  return {
    client_id: field(record, 'client_id', account),
    client_secret: field(record, 'client_secret', account),
    refresh_token: field(record, 'refresh_token', account),
  };
}

/** The one shell-out. Its stderr is scrubbed first, because a failed tool can print anything. */
async function gwsAuthExport(account: GmailAccount): Promise<string> {
  try {
    const { stdout } = await exec(GWS_BINARY, ['auth', 'export', '--unmasked'], {
      env: { ...process.env, GOOGLE_WORKSPACE_CLI_CONFIG_DIR: gwsConfigDir(account) },
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    const cause = error as { stderr?: string; message?: string };
    throw new Error(`gws auth export failed for ${account}: ${redactProviderText(String(cause.stderr || cause.message || error))}`);
  }
}

export interface ImportAccountRequest {
  account: GmailAccount;
  /** Replace a record that is already there. Without this the import refuses, and says whose it is. */
  force?: boolean;
}

/** What the CLI may print: no secret, no token, and enough to know what changed. */
export interface ImportedAccount {
  account: GmailAccount;
  /** Where the record now lives. A path, not a credential. */
  path: string;
  replaced: boolean;
}

export interface AccountImportOptions {
  /** The credential store directory; defaults to the plugin data directory. */
  dir?: string;
  /** The CLI call, injectable so a test supplies a fixture payload instead of running `gws`. */
  readExport?: (account: GmailAccount) => Promise<string>;
}

/**
 * Store one account's credential from its `gws` config directory. Reads the export only after
 * refusing to overwrite, so a refused run never starts the CLI.
 */
export async function importGwsAccount(request: ImportAccountRequest, options: AccountImportOptions = {}): Promise<ImportedAccount> {
  const { account, force = false } = request;
  const credentials = createGmailCredentials({ dir: options.dir });
  const path = gmailCredentialPath(account, options.dir);
  const existing = await credentials.status(account);
  if (existing.present && !force) {
    throw new Error(`${account} already has a credential at ${path}; pass --force to replace it.`);
  }
  const payload = parseGwsExport(await (options.readExport ?? gwsAuthExport)(account), account);
  const record: GmailCredentialRecord = { ...payload, source: 'gws-import' };
  await credentials.write(account, record);
  return { account, path, replaced: existing.present };
}
