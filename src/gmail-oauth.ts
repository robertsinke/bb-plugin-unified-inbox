// The plugin's own Gmail credential (INBOX-9, plan unit U1).
//
// One record per Gmail account, one file per record, mode 0600, in the plugin's data directory.
// A record is the OAuth client, the refresh token, and — while one is live — an access token with
// the moment it expires. Nothing else in the plugin reads or writes these files: this module owns
// whether a Gmail credential exists, when its access token is renewed, and what its last failure
// was, so a dead token is inspectable from a log line instead of a terminal.
//
// Renewal is single-flight per account. Gmail reads overlap (a page fans out with `Promise.all`),
// and several grants fired at once can invalidate each other, so concurrent callers wait on the
// one grant in flight.
//
// A rejected grant throws the status and the provider's own reason — never synthesized failure
// text. `toProviderError` turns that into the scrubbed `ProviderError` the gateway renders, so the
// `expired` / `invalid` / `token` hints survive the transport.
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { redactProviderText } from './adapters/provider-error.ts';
import { isLegacyGmailAccount, isMailboxAddress, legacyGmailAccounts, type GmailAccount } from './adapters/types.ts';

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const PROFILE_ENDPOINT = 'https://gmail.googleapis.com/gmail/v1/users/me/profile';
const LEGACY_MAP_FILE = 'legacy-map.json';
const PROFILE_TIMEOUT_MS = 20_000;

/** Google's own default lifetime, used only when a grant omits `expires_in`. */
const FALLBACK_TTL_MS = 3_600_000;

/**
 * How long before `expires_at` a token stops being handed out. A request that starts a second
 * before expiry would otherwise fail mid-flight with a 401; one minute covers a slow read.
 */
export const TOKEN_EXPIRY_MARGIN_MS = 60_000;

/** What the plugin stores for one account. Field names follow Google's token response. */
export interface GmailCredentialRecord {
  client_id: string;
  client_secret: string;
  refresh_token: string;
  access_token?: string;
  /** Epoch ms. The token is renewed once it is inside the margin. */
  expires_at?: number;
  scopes?: string[];
  /** Where the credential came from; a later login flow adds a second value without a schema change. */
  source: 'gws-import' | 'login';
  /**
   * Last failed refresh, kept so an unusable credential can be reported without a terminal.
   * `reason: 'deleted_client'` is terminal: the client is gone, so later asks do not call Google.
   */
  lastError?: { at: number; message: string; reason?: string };
}

/** The credential as a log line can show it: present, has refresh token, last error. */
export interface GmailCredentialState {
  account: GmailAccount;
  present: boolean;
  hasRefreshToken: boolean;
  expiresAt?: number;
  source?: GmailCredentialRecord['source'];
  lastError?: { at: number; message: string };
}

/** The one HTTP call this module makes; injectable so no test touches the network. */
export type TokenFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** A rejected grant. Carries the status and provider reason `toProviderError` needs. */
export class GmailCredentialError extends Error {
  readonly status: number;
  readonly reason?: string;
  /** `toProviderError` reports this as the failure code; the status is the provider's own. */
  readonly code: number;

  constructor(status: number, reason?: string, description?: string) {
    super(`oauth token request failed (${status}${reason ? ` ${reason}` : ''}${description ? `: ${description}` : ''})`);
    this.name = 'GmailCredentialError';
    this.status = status;
    this.reason = reason;
    this.code = status;
  }
}

/** The plugin data directory these files live in. Overridable so a test never writes to $HOME. */
export function gmailCredentialDir(): string {
  return process.env.UNIFIED_INBOX_GMAIL_CREDENTIALS || join(homedir(), '.bb/plugins/unified-inbox/gmail-credentials');
}

/** Where one account's record lives: one file per `GmailAccount`, named for that account. */
export function gmailCredentialPath(account: GmailAccount, dir = gmailCredentialDir()): string {
  return join(dir, `${account}.json`);
}

export interface GmailCredentials {
  /** The stored record. Throws a clear error when there is none for this account. */
  read(account: GmailAccount): Promise<GmailCredentialRecord>;
  /** Replace one account's record atomically, at mode 0600. */
  write(account: GmailAccount, record: GmailCredentialRecord): Promise<void>;
  /** Present / has refresh token / last error, without throwing for a missing file. */
  status(account: GmailAccount): Promise<GmailCredentialState>;
  /**
   * A live access token, renewing it when it is missing, inside the margin, or `force`d (the one
   * retry after a 401). Concurrent callers share a single grant.
   */
  accessToken(account: GmailAccount, opts?: { force?: boolean }): Promise<string>;
  /**
   * Ask Google for a new access token and do not write the credential file.
   * A failure leaves the file byte-for-byte, including `lastError`.
   * The client id and secret are the ones stored on that file.
   */
  exchange(account: GmailAccount): Promise<{ record: GmailCredentialRecord; access_token: string; expires_at: number; scopes?: string[] }>;
}

export interface GmailCredentialsOptions {
  dir?: string;
  fetch?: TokenFetch;
  now?: () => number;
  marginMs?: number;
}

export function createGmailCredentials(options: GmailCredentialsOptions = {}): GmailCredentials {
  const dir = options.dir ?? gmailCredentialDir();
  const fetchToken = options.fetch ?? (fetch as unknown as TokenFetch);
  const now = options.now ?? Date.now;
  const marginMs = options.marginMs ?? TOKEN_EXPIRY_MARGIN_MS;
  const inflight = new Map<GmailAccount, Promise<string>>();
  let tempCounter = 0;

  /** The record, or null for a missing file. Any other failure is real and propagates. */
  async function readOrNull(account: GmailAccount): Promise<GmailCredentialRecord | null> {
    const path = gmailCredentialPath(account, dir);
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    try {
      return JSON.parse(raw) as GmailCredentialRecord;
    } catch {
      // Same rule as the missing record below: name the fix, because a path is scrubbed before the
      // panel shows it. A corrupt file is replaced, not repaired, so the fix is the import with --force.
      throw new Error(`Gmail credential for ${account} is not valid JSON; run bb unified-inbox import-gws-account ${account} --force`);
    }
  }

  async function read(account: GmailAccount): Promise<GmailCredentialRecord> {
    const record = await readOrNull(account);
    // Name the fix, not the file: a path here would be redacted to `expected [redacted]/<account>.json`
    // by `redactProviderText`, which tells the reader nothing they can act on (INBOX-16). The
    // command and the account id both survive scrubbing, so the panel line stays usable.
    if (!record) throw new Error(`No Gmail credential for ${account}; run bb unified-inbox import-gws-account ${account}`);
    return record;
  }

  async function write(account: GmailAccount, record: GmailCredentialRecord): Promise<void> {
    const path = gmailCredentialPath(account, dir);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    // A fresh temp file per write, so mode 0600 is set at creation and a reader only ever sees a
    // path that names a complete file: the rename is the write.
    const temp = `${path}.${process.pid}-${++tempCounter}.tmp`;
    await writeFile(temp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    await rename(temp, path);
  }

  function unexpired(record: GmailCredentialRecord): boolean {
    return typeof record.access_token === 'string' && typeof record.expires_at === 'number' && record.expires_at - marginMs > now();
  }

  /** Keep the failure on the record so the panel's stale-cache path can name it. Never masks the failure. */
  async function noteError(account: GmailAccount, record: GmailCredentialRecord, error: unknown): Promise<void> {
    const message = redactProviderText(error instanceof Error ? error.message : String(error));
    const reason = error instanceof GmailCredentialError ? error.reason : undefined;
    try {
      await write(account, { ...record, lastError: { at: now(), message, ...(reason ? { reason } : {}) } });
    } catch { /* the failure being reported outranks the note about it */ }
  }

  /**
   * A deleted client cannot become valid by asking again. The stored failure is the answer until
   * a new record replaces it.
   */
  function clientIsDeleted(record: GmailCredentialRecord): boolean {
    return record.lastError?.reason === 'deleted_client' || record.lastError?.message.includes('deleted_client') === true;
  }

  /** The token endpoint, using the client id and secret stored on the record. Writes nothing. */
  async function requestGrant(record: GmailCredentialRecord): Promise<{ access_token: string; expires_at: number; scopes?: string[] }> {
    const body = new URLSearchParams({
      client_id: record.client_id,
      client_secret: record.client_secret,
      refresh_token: record.refresh_token,
      grant_type: 'refresh_token',
    }).toString();
    const response = await fetchToken(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    const answer = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      const reason = typeof answer.error === 'string' ? answer.error : undefined;
      const description = typeof answer.error_description === 'string' ? answer.error_description : undefined;
      throw new GmailCredentialError(response.status, reason, description);
    }
    const token = typeof answer.access_token === 'string' ? answer.access_token : '';
    if (!token) throw new GmailCredentialError(response.status, 'missing_access_token');
    const seconds = Number(answer.expires_in);
    const scopes = typeof answer.scope === 'string' ? answer.scope.split(' ').filter(Boolean) : undefined;
    return {
      access_token: token,
      expires_at: now() + (Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : FALLBACK_TTL_MS),
      ...(scopes ? { scopes } : {}),
    };
  }

  async function exchange(account: GmailAccount) {
    const record = await read(account);
    if (clientIsDeleted(record)) throw new GmailCredentialError(401, 'deleted_client', 'The OAuth client was deleted.');
    const grant = await requestGrant(record);
    return { record, ...grant };
  }

  async function refresh(account: GmailAccount): Promise<string> {
    const record = await read(account);
    try {
      const grant = await requestGrant(record);
      const next: GmailCredentialRecord = {
        ...record,
        access_token: grant.access_token,
        expires_at: grant.expires_at,
        lastError: undefined,
        ...(grant.scopes ? { scopes: grant.scopes } : {}),
      };
      await write(account, next);
      return grant.access_token;
    } catch (error) {
      await noteError(account, record, error);
      throw error;
    }
  }

  return {
    read,
    write,
    async status(account) {
      const record = await readOrNull(account);
      if (!record) return { account, present: false, hasRefreshToken: false };
      return {
        account,
        present: true,
        hasRefreshToken: typeof record.refresh_token === 'string' && record.refresh_token.length > 0,
        expiresAt: record.expires_at,
        source: record.source,
        lastError: record.lastError,
      };
    },
    exchange,
    async accessToken(account, opts = {}) {
      const record = await read(account);
      if (clientIsDeleted(record)) throw new GmailCredentialError(401, 'deleted_client', 'The OAuth client was deleted.');
      if (!opts.force && unexpired(record)) return record.access_token as string;
      const running = inflight.get(account);
      if (running) return running;
      const grant = refresh(account).finally(() => inflight.delete(account));
      inflight.set(account, grant);
      return grant;
    },
  };
}

export interface LegacyMailboxConflict {
  account: string;
  address: string;
}

export interface LegacyMailboxSettlement {
  /** Gmail ids still registered: email files, plus legacy files whose profile could not be read. */
  accounts: string[];
  /** Legacy id → mailbox address. The panel copies drafts from this. It is not inside a credential file. */
  legacy: Record<string, string>;
  conflicts: LegacyMailboxConflict[];
}

interface ListedCredential {
  id: string;
  bytes: string;
  record: GmailCredentialRecord;
}

interface LegacyMapFile {
  legacy: Record<string, string>;
  conflicts: LegacyMailboxConflict[];
}

function mapPath(dir: string): string {
  return join(dir, LEGACY_MAP_FILE);
}

async function readLegacyMap(dir: string): Promise<LegacyMapFile> {
  try {
    const parsed = JSON.parse(await readFile(mapPath(dir), 'utf8')) as Partial<LegacyMapFile>;
    const legacy = parsed.legacy && typeof parsed.legacy === 'object' ? { ...parsed.legacy } : {};
    const conflicts = Array.isArray(parsed.conflicts)
      ? parsed.conflicts.filter((row): row is LegacyMailboxConflict => !!row && typeof row.account === 'string' && typeof row.address === 'string')
      : [];
    return { legacy, conflicts };
  } catch {
    return { legacy: {}, conflicts: [] };
  }
}

async function writeLegacyMap(dir: string, map: LegacyMapFile): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = mapPath(dir);
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(map, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, path);
}

/** Every readable credential in the directory, before any profile call. */
export async function listGmailCredentials(dir: string): Promise<ListedCredential[]> {
  let names: string[] = [];
  try {
    names = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const listed: ListedCredential[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith('.json') || name === LEGACY_MAP_FILE || name.includes('.tmp')) continue;
    const id = name.slice(0, -'.json'.length);
    try {
      const bytes = await readFile(join(dir, name), 'utf8');
      const record = JSON.parse(bytes) as GmailCredentialRecord;
      if (!record || typeof record.client_id !== 'string' || typeof record.refresh_token !== 'string') continue;
      listed.push({ id, bytes, record });
    } catch { /* an unreadable file stays where it is */ }
  }
  return listed;
}

async function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), ms); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function gmailProfileAddress(token: string, fetchImpl: typeof fetch = fetch): Promise<string | undefined> {
  const response = await fetchImpl(PROFILE_ENDPOINT, { method: 'GET', headers: { authorization: `Bearer ${token}` } });
  const body = await response.json().catch(() => ({})) as { emailAddress?: unknown };
  if (!response.ok) throw new Error(`Gmail profile failed (${response.status})`);
  const email = typeof body.emailAddress === 'string' ? body.emailAddress.trim().toLowerCase() : '';
  return isMailboxAddress(email) ? email : undefined;
}

export interface SettleLegacyOptions {
  dir?: string;
  fetch?: TokenFetch;
  now?: () => number;
  timeoutMs?: number;
  /** Profile email for an access token. Default reads Gmail's profile endpoint. */
  profile?: (token: string) => Promise<string | undefined>;
  moveRows?: (from: string, to: string) => void;
  pause?: (account: string) => void;
  resume?: (account: string) => void;
}

/**
 * Rename legacy credential files to the mailbox address when a profile read can,
 * and finish a rename that already published the email-named file without calling
 * Google again. A failed refresh or a timeout leaves the legacy file unchanged.
 */
export async function settleLegacyGmailAccounts(options: SettleLegacyOptions = {}): Promise<LegacyMailboxSettlement> {
  const dir = options.dir ?? gmailCredentialDir();
  const credentials = createGmailCredentials({ dir, fetch: options.fetch, now: options.now });
  const timeoutMs = options.timeoutMs ?? PROFILE_TIMEOUT_MS;
  const profile = options.profile ?? ((token: string) => gmailProfileAddress(token));
  const listed = await listGmailCredentials(dir);
  const byId = new Map(listed.map(file => [file.id, file]));
  const map = await readLegacyMap(dir);
  const conflicts = [...map.conflicts];
  const claimed = new Set(listed.filter(file => isMailboxAddress(file.id)).map(file => file.id));

  const pairFor = (legacyId: string): string | undefined => {
    const legacy = byId.get(legacyId);
    if (!legacy) return undefined;
    const sameToken = listed.find(file => isMailboxAddress(file.id) && file.record.refresh_token === legacy.record.refresh_token);
    if (sameToken) return sameToken.id;
    const remembered = map.legacy[legacyId];
    if (remembered && byId.has(remembered)) return remembered;
    return undefined;
  };

  async function dropLegacy(legacyId: string, address: string) {
    options.pause?.(legacyId);
    try {
      options.moveRows?.(legacyId, address);
      await unlink(join(dir, `${legacyId}.json`));
      byId.delete(legacyId);
    } finally {
      options.resume?.(legacyId);
    }
  }

  for (const legacyId of legacyGmailAccounts) {
    const legacy = byId.get(legacyId);
    if (!legacy) continue;
    const knownConflict = conflicts.find(row => row.account === legacyId);
    if (knownConflict && claimed.has(knownConflict.address)) continue;
    const paired = pairFor(legacyId);
    if (paired) {
      map.legacy[legacyId] = paired;
      await writeLegacyMap(dir, { legacy: map.legacy, conflicts });
      await dropLegacy(legacyId, paired);
      continue;
    }
    const before = legacy.bytes;
    try {
      const grant = await withDeadline(credentials.exchange(legacyId), timeoutMs);
      const reported = await withDeadline(profile(grant.access_token), timeoutMs);
      const address = typeof reported === 'string' ? reported.trim().toLowerCase() : '';
      if (!isMailboxAddress(address)) throw new Error('profile had no email address');
      if (claimed.has(address)) {
        if (!conflicts.some(row => row.account === legacyId)) conflicts.push({ account: legacyId, address });
        await writeLegacyMap(dir, { legacy: map.legacy, conflicts });
        const after = await readFile(join(dir, `${legacyId}.json`), 'utf8');
        if (after !== before) await writeFile(join(dir, `${legacyId}.json`), before);
        continue;
      }
      claimed.add(address);
      const published: GmailCredentialRecord = {
        ...grant.record,
        access_token: grant.access_token,
        expires_at: grant.expires_at,
        lastError: undefined,
        ...(grant.scopes ? { scopes: grant.scopes } : {}),
      };
      await credentials.write(address, published);
      map.legacy[legacyId] = address;
      await writeLegacyMap(dir, { legacy: map.legacy, conflicts });
      await dropLegacy(legacyId, address);
    } catch {
      try {
        const after = await readFile(join(dir, `${legacyId}.json`), 'utf8');
        if (after !== before) await writeFile(join(dir, `${legacyId}.json`), before);
      } catch { /* the file was already removed by a rename that then failed */ }
    }
  }

  const after = await listGmailCredentials(dir);
  const conflictIds = new Set(conflicts.map(row => row.account));
  const accounts = after
    .map(file => file.id)
    .filter(id => !conflictIds.has(id) && (isMailboxAddress(id) || isLegacyGmailAccount(id)));
  return { accounts, legacy: map.legacy, conflicts };
}
