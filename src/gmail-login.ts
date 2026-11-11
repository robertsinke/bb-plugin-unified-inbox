// Desktop OAuth for one new mailbox (plan U2).
//
// The listener binds 127.0.0.1 after the call starts, then mints state and an S256 verifier.
// The system browser opens Google's authorization URL. This process accepts one matching
// redirect, closes the port, and only then posts the code. The page is one fixed HTML string.
// The code, the verifier, either token, and the client secret are never logged and never returned.
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { isMailboxAddress } from './adapters/types.ts';
import {
  createGmailCredentials,
  gmailProfileAddress,
  gmailUserinfoEmail,
  TOKEN_ENDPOINT,
  type TokenFetch,
} from './gmail-oauth.ts';

export const GMAIL_LOGIN_SCOPES = [
  'openid',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/contacts.readonly',
  'https://www.googleapis.com/auth/contacts.other.readonly',
] as const;

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GMAIL_OAUTH_CALLBACK_PATH = '/oauth/callback';
/** Every listener response is this string. It has no query and no link. */
export const GMAIL_OAUTH_PAGE = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Signed in</title></head><body><p>You can close this window.</p></body></html>';

const BROWSER_TIMEOUT_MS = 180_000;
const EXCHANGE_TIMEOUT_MS = 20_000;

export interface GmailLoginResult {
  account: string;
  replaced: boolean;
  alreadyConnected: boolean;
}

export interface GmailLoginOptions {
  clientId: string;
  clientSecret: string;
  /** Add does not send this. A file is replaced only when this is true for the address Google returns. */
  replace?: boolean;
  dir?: string;
  open?: (url: string) => void | Promise<void> | Promise<boolean>;
  fetch?: TokenFetch;
  profile?: (token: string) => Promise<string | undefined>;
  userinfo?: (token: string) => Promise<string | undefined>;
  timeoutMs?: number;
  signal?: AbortSignal;
  now?: () => number;
}

const flight = { current: false };
let cancelActive: (() => void) | undefined;

/** Dispose closes the listener and writes nothing. */
export function cancelGmailLogin(): void {
  cancelActive?.();
}

/** The platform opener. The plugin does not start a browser of its own. True means the process started. */
export function openSystemBrowser(url: string): Promise<boolean> {
  return new Promise(resolve => {
    let settled = false;
    const finish = (opened: boolean) => { if (!settled) { settled = true; resolve(opened); } };
    const child = process.platform === 'darwin'
      ? spawn('open', [url], { stdio: 'ignore', detached: true })
      : process.platform === 'win32'
        ? spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', detached: true, windowsHide: true })
        : spawn('xdg-open', [url], { stdio: 'ignore', detached: true });
    child.once('error', () => finish(false));
    child.once('spawn', () => finish(true));
    child.unref();
  });
}

/** False when the authorization URL did not carry this S256 challenge. The token post is skipped. */
export function tokenExchangeAllowed(authUrl: string, challenge: string): boolean {
  try {
    const url = new URL(authUrl);
    return url.searchParams.get('code_challenge') === challenge && url.searchParams.get('code_challenge_method') === 'S256';
  } catch {
    return false;
  }
}

function missingClient(clientId: string, clientSecret: string): string | undefined {
  const missing = [clientId.trim() ? '' : 'client id', clientSecret.trim() ? '' : 'client secret'].filter(Boolean);
  if (!missing.length) return undefined;
  const named = missing.length === 2 ? 'client id and a client secret' : missing[0];
  return `Gmail sign-in needs a ${named} in settings. Nothing was written.`;
}

function mint(bytes: number): string {
  return randomBytes(bytes).toString('base64url');
}

function s256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

function sendPage(res: ServerResponse, port: number, done?: () => void) {
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    location: `http://127.0.0.1:${port}${GMAIL_OAUTH_CALLBACK_PATH}`,
  });
  res.end(GMAIL_OAUTH_PAGE, () => done?.());
}

async function closeServer(server: Server | undefined): Promise<void> {
  if (!server) return;
  await new Promise<void>(resolve => server.close(() => resolve()));
}

function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return new Promise<T>((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), ms);
    work.then(resolve, reject);
  }).finally(() => { if (timer) clearTimeout(timer); });
}

async function bindLoopback(): Promise<{ server: Server; port: number }> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    const fail = (error: Error) => reject(error);
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', fail);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string' || address.address !== '127.0.0.1') {
    await closeServer(server);
    throw new Error('Gmail sign-in could not bind to 127.0.0.1. Nothing was written.');
  }
  return { server, port: address.port };
}

function authorizationUrl(redirectUri: string, clientId: string, state: string, challenge: string): string {
  const url = new URL(AUTH_ENDPOINT);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', GMAIL_LOGIN_SCOPES.join(' '));
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('prompt', 'consent');
  // Without this, Google omits the refresh token and the sign-in cannot be stored.
  url.searchParams.set('access_type', 'offline');
  return url.toString();
}

/**
 * One sign-in. A second call while this one is in flight is refused.
 * Timeout, cancel, a bad state, and a token body with no refresh token write nothing.
 */
export async function connectGmailMailbox(options: GmailLoginOptions): Promise<GmailLoginResult> {
  const clientId = options.clientId ?? '';
  const clientSecret = options.clientSecret ?? '';
  const missing = missingClient(clientId, clientSecret);
  if (missing) throw new Error(missing);
  if (options.signal?.aborted) throw new Error('Gmail sign-in was cancelled. Nothing was written.');
  if (flight.current) throw new Error('A Gmail sign-in is already in progress.');
  flight.current = true;
  let server: Server | undefined;
  const replace = options.replace === true;
  const now = options.now ?? Date.now;
  const fetchToken = options.fetch ?? (fetch as unknown as TokenFetch);
  const profile = options.profile ?? ((token: string) => gmailProfileAddress(token));
  const userinfo = options.userinfo ?? ((token: string) => gmailUserinfoEmail(token));
  try {
    const bound = await bindLoopback();
    server = bound.server;
    const port = bound.port;
    // Mint only after the bind, so the redirect port is the one that was chosen.
    const state = mint(16);
    const verifier = mint(32);
    const challenge = s256(verifier);
    const redirectUri = `http://127.0.0.1:${port}${GMAIL_OAUTH_CALLBACK_PATH}`;
    const authUrl = authorizationUrl(redirectUri, clientId, state, challenge);
    const allowed = tokenExchangeAllowed(authUrl, challenge);

    const code = await waitForCode({
      server,
      port,
      state,
      authUrl,
      timeoutMs: options.timeoutMs ?? BROWSER_TIMEOUT_MS,
      signal: options.signal,
      open: options.open ?? openSystemBrowser,
    });
    await closeServer(server);
    server = undefined;
    if (!allowed) throw new Error('Gmail sign-in did not send a code challenge. Nothing was written.');

    let grant: { access_token: string; refresh_token: string; expires_at: number; scopes?: string[] };
    try {
      grant = await withDeadline(exchangeCode({ fetchToken, clientId, clientSecret, code, verifier, redirectUri, now }), EXCHANGE_TIMEOUT_MS);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Gmail ')) throw error;
      throw new Error('Gmail sign-in could not complete. Nothing was written.');
    }
    if (options.signal?.aborted) throw new Error('Gmail sign-in was cancelled. Nothing was written.');
    const address = await mailboxAddress(grant.access_token, profile, userinfo);
    const credentials = createGmailCredentials({ dir: options.dir, fetch: fetchToken, now });
    const existing = await credentials.status(address);
    if (existing.present && !replace) {
      return { account: address, replaced: false, alreadyConnected: true };
    }
    await credentials.write(address, {
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: grant.refresh_token,
      access_token: grant.access_token,
      expires_at: grant.expires_at,
      scopes: grant.scopes ?? [...GMAIL_LOGIN_SCOPES],
      source: 'login',
    });
    return { account: address, replaced: existing.present, alreadyConnected: false };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Gmail ')) throw error;
    throw new Error('Gmail sign-in could not complete. Nothing was written.');
  } finally {
    cancelActive = undefined;
    await closeServer(server);
    flight.current = false;
  }
}

function waitForCode(input: {
  server: Server;
  port: number;
  state: string;
  authUrl: string;
  timeoutMs: number;
  signal?: AbortSignal;
  open: (url: string) => void | Promise<void> | Promise<boolean>;
}): Promise<string> {
  const { server, port, state, authUrl, timeoutMs, signal, open } = input;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error: Error | null, code?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (cancelActive === cancel) cancelActive = undefined;
      if (error) reject(error);
      else resolve(code ?? '');
    };
    const cancel = () => finish(new Error('Gmail sign-in was cancelled. Nothing was written.'));
    const onAbort = () => cancel();
    cancelActive = cancel;
    const timer = setTimeout(() => finish(new Error('Gmail sign-in timed out. Nothing was written.')), timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    let accepted = false;
    server.on('request', (req: IncomingMessage, res: ServerResponse) => {
      let pathname = '';
      let query: URLSearchParams | undefined;
      try {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        pathname = url.pathname;
        query = url.searchParams;
      } catch { /* the page stays the fixed string */ }
      res.on('error', () => { /* a closed browser is not a credential */ });
      const done = () => {
        if (accepted || req.method !== 'GET' || pathname !== GMAIL_OAUTH_CALLBACK_PATH) return;
        accepted = true;
        const got = query?.get('state') ?? '';
        const code = query?.get('code') ?? '';
        if (got === state && code) finish(null, code);
        else finish(new Error('Gmail sign-in was refused. Nothing was written.'));
      };
      sendPage(res, port, done);
    });
    Promise.resolve()
      .then(() => Promise.resolve(open(authUrl)).then(() => undefined))
      .catch(() => finish(new Error('Gmail sign-in could not open the browser. Nothing was written.')));
  });
}

async function exchangeCode(input: {
  fetchToken: TokenFetch;
  clientId: string;
  clientSecret: string;
  code: string;
  verifier: string;
  redirectUri: string;
  now: () => number;
}): Promise<{ access_token: string; refresh_token: string; expires_at: number; scopes?: string[] }> {
  const body = new URLSearchParams({
    client_id: input.clientId,
    client_secret: input.clientSecret,
    code: input.code,
    code_verifier: input.verifier,
    redirect_uri: input.redirectUri,
    grant_type: 'authorization_code',
  }).toString();
  const response = await input.fetchToken(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  const answer = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new Error('Gmail sign-in could not complete. Nothing was written.');
  const access = typeof answer.access_token === 'string' ? answer.access_token : '';
  const refresh = typeof answer.refresh_token === 'string' ? answer.refresh_token : '';
  if (!refresh || !access) throw new Error('Gmail did not return a refresh token. Nothing was written.');
  const seconds = Number(answer.expires_in);
  const scopes = typeof answer.scope === 'string' ? answer.scope.split(' ').filter(Boolean) : undefined;
  return {
    access_token: access,
    refresh_token: refresh,
    expires_at: input.now() + (Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 3_600_000),
    ...(scopes ? { scopes } : {}),
  };
}

async function mailboxAddress(
  token: string,
  profile: (token: string) => Promise<string | undefined>,
  userinfo: (token: string) => Promise<string | undefined>,
): Promise<string> {
  let reported: string | undefined;
  try {
    reported = await profile(token);
  } catch {
    throw new Error('Gmail sign-in could not read the mailbox address. Nothing was written.');
  }
  if (!reported) {
    try { reported = await userinfo(token); } catch { reported = undefined; }
  }
  const address = typeof reported === 'string' ? reported.trim().toLowerCase() : '';
  if (!isMailboxAddress(address)) throw new Error('Gmail sign-in could not read the mailbox address. Nothing was written.');
  return address;
}
