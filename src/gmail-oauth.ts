// The plugin's own Gmail credential (INBOX-9, plan unit U1).
//
// One record per Gmail account, one file per record, mode 0600, in the plugin's data directory.
// A record is the OAuth client, the refresh token, and — while one is live — an access token with
// the moment it expires. Nothing else in the plugin reads or writes these files: this module owns
// whether a Gmail credential exists, when its access token is renewed, and what its last failure
// was, so a dead token is inspectable from a log line instead of a terminal.
//
// Renewal is single-flight per account. Gmail reads already overlap
// (`READ_CONCURRENCY` in src/adapters/gws.ts), and six grants fired at once can invalidate each
// other, so concurrent callers wait on the one grant in flight.
//
// A rejected grant throws the status and the provider's own reason — never synthesized failure
// text. `toProviderError` turns that into the scrubbed `ProviderError` the gateway renders, so the
// `expired` / `invalid` / `token` hints survive the transport.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { redactProviderText } from './adapters/provider-error.ts';
import type { GmailAccount } from './adapters/types.ts';

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

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
  /** Last failed refresh, kept so an unusable credential can be reported without a terminal. */
  lastError?: { at: number; message: string };
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
      throw new Error(`Gmail credential for ${account} is not valid JSON: ${path}`);
    }
  }

  async function read(account: GmailAccount): Promise<GmailCredentialRecord> {
    const record = await readOrNull(account);
    if (!record) throw new Error(`No Gmail credential for ${account}; expected ${gmailCredentialPath(account, dir)}`);
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
    try {
      await write(account, { ...record, lastError: { at: now(), message } });
    } catch { /* the failure being reported outranks the note about it */ }
  }

  async function refresh(account: GmailAccount): Promise<string> {
    const record = await read(account);
    try {
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
      const next: GmailCredentialRecord = {
        ...record,
        access_token: token,
        expires_at: now() + (Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : FALLBACK_TTL_MS),
        lastError: undefined,
      };
      if (typeof answer.scope === 'string') next.scopes = answer.scope.split(' ').filter(Boolean);
      await write(account, next);
      return token;
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
    async accessToken(account, opts = {}) {
      if (!opts.force) {
        const record = await read(account);
        if (unexpired(record)) return record.access_token as string;
      }
      const running = inflight.get(account);
      if (running) return running;
      const grant = refresh(account).finally(() => inflight.delete(account));
      inflight.set(account, grant);
      return grant;
    },
  };
}
