// The plugin's own Gmail API client (INBOX-10, plan unit U2).
//
// One method per endpoint `src/adapters/gmail.ts` asks for, over HTTPS: this is the `GmailClient`
// contract from `src/adapters/types.ts`, implemented without a CLI. Each call builds its URL and
// query from typed input, so `format`, `metadataHeaders`, `labelIds`, `maxResults` and
// `pageToken` are arguments rather than a JSON blob handed to a CLI.
//
// A 401 is not a failure the first time it happens. Gmail reads overlap (`READ_CONCURRENCY`), so a
// token can be revoked or expire between the moment it was handed out and the moment it lands. It
// buys exactly one forced refresh and one retry; a second 401 is a failure.
//
// Nothing here synthesizes provider failure text: a non-2xx answer throws `GmailApiError` carrying
// the HTTP status, the provider's `reason` and the provider's `message`. `toProviderError` then
// classifies it, so the `expired` / `invalid` / `token` hints survive the transport.
import type {
  GmailAccount, GmailClient, GmailMessage, GmailProfile, GmailReadInput, GmailSentMessage,
  GmailThread, GmailThreadPage,
} from './adapters/types.ts';
import type { GmailCredentials } from './gmail-oauth.ts';

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1';

/** One HTTP call; injectable so no test touches the network. `text()` keeps an empty body readable. */
export type GmailFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/**
 * What a `metadata` read must carry to fill a cached row: the fields `gmail.ts` reads off
 * `payload.headers`, and nothing more. A metadata read without them is a row with no subject.
 */
const METADATA_HEADERS = ['From', 'To', 'Cc', 'Subject', 'Message-ID', 'References', 'Reply-To'];

/** A failed request, with what `toProviderError` needs to classify it. */
export class GmailApiError extends Error {
  readonly status: number;
  /** The provider's own reason (`authError`, `notFound`, `rateLimitExceeded`, …), when it gave one. */
  readonly reason?: string;
  /** The provider's own message, verbatim. */
  readonly providerMessage?: string;
  /** `toProviderError` reports this as the failure code; the status is the provider's own. */
  readonly code: number;

  constructor(status: number, reason: string | undefined, providerMessage: string, request: string) {
    super(`Gmail API ${request} failed (${status}${reason ? ` ${reason}` : ''})${providerMessage ? `: ${providerMessage}` : ''}`);
    this.name = 'GmailApiError';
    this.status = status;
    this.reason = reason;
    this.providerMessage = providerMessage;
    this.code = status;
  }
}

/**
 * Units one account may spend in a rolling minute. A full refresh of ten threads is about 400
 * once known threads are read as metadata, and this 403 is reported around 2,400 counted units
 * while the console says 6,000. 1,500 leaves room for that refresh and several opens.
 */
export const GMAIL_MINUTE_BUDGET = 1_500;
const QUOTA_PAUSE_MS = 60_000;

/** Where the token comes from: U1's store owns it, and only the token is this module's business. */
export interface GmailClientOptions {
  account: GmailAccount;
  credentials: Pick<GmailCredentials, 'accessToken'>;
  fetch?: GmailFetch;
  /** Tests move the minute. The budget and the pause are measured against this clock. */
  now?: () => number;
}

interface Request {
  method: 'GET' | 'POST';
  path: string;
  query?: URLSearchParams;
  body?: unknown;
}

function query(entries: [string, string | number | undefined | string[]][]): URLSearchParams {
  const params = new URLSearchParams();
  for (const [name, value] of entries) {
    if (Array.isArray(value)) for (const each of value) params.append(name, each);
    else if (value !== undefined && value !== '') params.append(name, String(value));
  }
  return params;
}

/** Gmail's error body: `{error: {code, message, errors: [{reason}]}}`. A non-JSON body is kept as text. */
function describeFailure(body: unknown, text: string): { reason?: string; message: string } {
  const error = (body as { error?: { status?: unknown; message?: unknown; errors?: { reason?: unknown }[] } } | null)?.error;
  const first = Array.isArray(error?.errors) ? error.errors[0] : undefined;
  const reason = typeof first?.reason === 'string' ? first.reason : typeof error?.status === 'string' ? error.status : undefined;
  const message = typeof error?.message === 'string' ? error.message : text.trim();
  return { reason, message };
}

/** Published Gmail query cost for one request. A full thread read is 120; metadata is 40. */
function unitsFor(request: Request): number {
  const path = request.path;
  const format = request.query?.get('format');
  if (path === '/users/me/profile' || path === '/users/me/labels') return 1;
  if (path === '/users/me/threads') return 10;
  if (path.endsWith('/modify')) return 10;
  if (path.endsWith('/send')) return 100;
  if (path.includes('/attachments/')) return 20;
  if (path.startsWith('/users/me/threads/')) return format === 'full' || format == null ? 120 : 40;
  if (path.startsWith('/users/me/messages/')) return format === 'metadata' || format === 'minimal' ? 20 : 60;
  return 5;
}

export function createGmailClient(options: GmailClientOptions): GmailClient {
  const { account, credentials } = options;
  const http = options.fetch ?? (fetch as unknown as GmailFetch);
  const clock = options.now ?? Date.now;
  const spent: { at: number; units: number }[] = [];
  let pausedUntil = 0;

  function quotaStop(label: string): GmailApiError {
    return new GmailApiError(403, 'rateLimitExceeded', "Quota exceeded for quota metric 'Total Query Cost' and limit 'Units per minute per user'", label);
  }

  /** Refuse the call, without sending it, when this minute is already full or Gmail has said so. */
  function reserve(units: number, label: string): void {
    const now = clock();
    if (now < pausedUntil) throw quotaStop(label);
    const recent = spent.filter(row => now - row.at < QUOTA_PAUSE_MS);
    spent.length = 0;
    spent.push(...recent);
    const used = spent.reduce((sum, row) => sum + row.units, 0);
    if (used + units > GMAIL_MINUTE_BUDGET) {
      pausedUntil = now + QUOTA_PAUSE_MS;
      throw quotaStop(label);
    }
    spent.push({ at: now, units });
  }

  function target(request: Request): string {
    const params = request.query?.toString();
    return `${GMAIL_API}${request.path}${params ? `?${params}` : ''}`;
  }

  function init(request: Request, token: string): { method: string; headers: Record<string, string>; body?: string } {
    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
    if (request.body === undefined) return { method: request.method, headers };
    headers['content-type'] = 'application/json';
    return { method: request.method, headers, body: JSON.stringify(request.body) };
  }

  /** The one place the 401 rule lives: refresh once, retry the same request once, then give up. */
  async function call<T>(request: Request): Promise<T> {
    const url = target(request);
    const label = `${request.method} ${request.path}`;
    reserve(unitsFor(request), label);
    let response = await http(url, init(request, await credentials.accessToken(account)));
    if (response.status === 401) {
      const token = await credentials.accessToken(account, { force: true });
      response = await http(url, init(request, token));
    }
    const text = await response.text();
    let body: unknown;
    let parsed = false;
    try {
      body = text ? JSON.parse(text) : {};
      parsed = true;
    } catch { /* an unparseable body is still a failure worth reporting as text */ }
    if (!response.ok) {
      const { reason, message } = describeFailure(parsed ? body : undefined, text);
      if (reason === 'rateLimitExceeded') pausedUntil = clock() + QUOTA_PAUSE_MS;
      throw new GmailApiError(response.status, reason, message, label);
    }
    if (!parsed) throw new Error(`Gmail API ${label} returned a body that is not JSON`);
    return body as T;
  }

  function readPath(kind: 'threads' | 'messages', input: GmailReadInput): Request {
    const format = input.format ?? 'full';
    const headers = format === 'metadata' ? input.metadataHeaders ?? METADATA_HEADERS : undefined;
    return {
      method: 'GET',
      path: `/users/me/${kind}/${encodeURIComponent(input.id)}`,
      query: query([['format', format], ['metadataHeaders', headers]]),
    };
  }

  return {
    profile: () => call({ method: 'GET', path: '/users/me/profile' }),

    labelsList: () => call({ method: 'GET', path: '/users/me/labels' }),

    threadsList: (input = {}) => call({
      method: 'GET',
      path: '/users/me/threads',
      query: query([['q', input.q], ['labelIds', input.labelIds], ['maxResults', input.maxResults], ['pageToken', input.pageToken]]),
    }),

    threadGet: input => call(readPath('threads', input)),

    threadsModify: input => call({
      method: 'POST',
      path: `/users/me/threads/${encodeURIComponent(input.id)}/modify`,
      body: { addLabelIds: input.addLabelIds ?? [], removeLabelIds: input.removeLabelIds ?? [] },
    }),

    messageGet: input => call(readPath('messages', input)),

    async attachmentGet(input) {
      const path = `/users/me/messages/${encodeURIComponent(input.messageId)}/attachments/${encodeURIComponent(input.id)}`;
      const answer = await call<{ data?: string; size?: number }>({ method: 'GET', path });
      if (typeof answer.data !== 'string' || !answer.data) {
        throw new Error(`Gmail API returned no data for attachment ${input.id}`);
      }
      return Buffer.from(answer.data, 'base64url');
    },

    sendRaw(input) {
      const body: { raw: string; threadId?: string } = { raw: Buffer.from(input.raw).toString('base64url') };
      // A reply keeps its thread; new mail must not name one, or Gmail rejects or misfiles it.
      if (input.threadId) body.threadId = input.threadId;
      return call({ method: 'POST', path: '/users/me/messages/send', body });
    },
  };
}
