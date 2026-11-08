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
// The import writes credentials only. It reads the profile before it chooses the file name, and it
// writes nothing when that read fails. It does not construct a Gmail client.
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { redactProviderText } from './adapters/provider-error.ts';
import { isMailboxAddress, type LegacyGmailAccount } from './adapters/types.ts';
import { createGmailCredentials, gmailCredentialPath, gmailProfileAddress, requestAccessGrant, type GmailCredentialRecord, type TokenFetch } from './gmail-oauth.ts';

const exec = promisify(execFile);

/** Installed CLI path: the import does not search PATH. */
const GWS_BINARY = '/usr/local/bin/gws';

/**
 * Google Workspace CLI credential directory, one per Gmail account. It lived in the CLI runner
 * until that was deleted; this mapping has to outlive it by exactly one run.
 */
export function gwsConfigDir(account: LegacyGmailAccount): string {
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

function field(payload: Record<string, unknown>, name: keyof GwsExport, account: LegacyGmailAccount): string {
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
export function parseGwsExport(payload: string, account: LegacyGmailAccount): GwsExport {
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
async function gwsAuthExport(account: LegacyGmailAccount): Promise<string> {
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
  /** Selector for one local gws directory. Not the stored id once the profile address is known. */
  account: LegacyGmailAccount;
  /** Replace the mailbox file at that address. Without this the import refuses, and says whose it is. */
  force?: boolean;
}

/** What the CLI may print: no secret, no token, and enough to know what changed. */
export interface ImportedAccount {
  /** The profile address. The selector is not the stored id. */
  account: string;
  /** Where the record now lives. A path, not a credential. */
  path: string;
  replaced: boolean;
}

export interface AccountImportOptions {
  /** The credential store directory; defaults to the plugin data directory. */
  dir?: string;
  /** The CLI call, injectable so a test supplies a fixture payload instead of running `gws`. */
  readExport?: (account: LegacyGmailAccount) => Promise<string>;
  /** Token endpoint. The profile read needs one access token and writes nothing if it fails. */
  fetch?: TokenFetch;
  /** Profile email for that access token. Default reads Gmail's profile endpoint. */
  profile?: (token: string) => Promise<string | undefined>;
}

/**
 * Store one exported credential under the profile address.
 * A masked export is rejected before a write. A profile failure writes nothing.
 * `--force` replaces the address file and no other file.
 */
export async function importGwsAccount(request: ImportAccountRequest, options: AccountImportOptions = {}): Promise<ImportedAccount> {
  const { account, force = false } = request;
  const credentials = createGmailCredentials({ dir: options.dir, fetch: options.fetch });
  const payload = parseGwsExport(await (options.readExport ?? gwsAuthExport)(account), account);
  const fetchToken = options.fetch ?? (fetch as unknown as TokenFetch);
  let address = '';
  try {
    const grant = await requestAccessGrant(payload, fetchToken, Date.now);
    const reported = await (options.profile ?? ((token: string) => gmailProfileAddress(token)))(grant.access_token);
    address = typeof reported === 'string' ? reported.trim().toLowerCase() : '';
  } catch {
    address = '';
  }
  if (!isMailboxAddress(address)) {
    throw new Error(`gws import for ${account} could not read the mailbox address; nothing was written.`);
  }
  const path = gmailCredentialPath(address, options.dir);
  const existing = await credentials.status(address);
  if (existing.present && !force) {
    throw new Error(`${address} already has a credential at ${path}; pass --force to replace it.`);
  }
  // The refresh token belongs to the client in the export. Settings are not copied onto this file.
  const record: GmailCredentialRecord = { ...payload, source: 'gws-import' };
  await credentials.write(address, record);
  return { account: address, path, replaced: existing.present };
}
