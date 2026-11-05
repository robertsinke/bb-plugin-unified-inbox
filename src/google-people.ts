// Google contact photos (INBOX-38): the People API behind `src/gmail-faces.ts`.
//
// Two listings, one per grant, because Google splits the address book in two and a consent can
// cover one half and not the other:
//   - `people/me/connections` — the contacts the owner saved. Needs `contacts.readonly`.
//   - `otherContacts`         — the people he emailed but never saved, which is most of a busy
//                               inbox. Needs `contacts.other.readonly`.
// Each answers address → photo URL, so a page of rows is one call per listing, not one call per row.
//
// There is no photo-only scope in Google's API: both grants read every field of every contact, not
// just the picture. The owner consented to that knowingly (docs/research/2026-11-05-gmail-faces-what-each-source-costs.md).
//
// Nothing here synthesizes failure text: a non-2xx answer throws `PeopleApiError` with the status and
// Google's own reason, and the caller decides what a failure means for a face (nothing — initials).
// The 401 rule is `src/gmail-client.ts`'s, for the same reason: reads overlap, so a token can expire
// between being handed out and landing, and it buys exactly one forced refresh and one retry.
import type { GmailAccount, GooglePeopleClient, GooglePeoplePage, GooglePhoto } from './adapters/types.ts';
import type { GmailCredentials } from './gmail-oauth.ts';

const PEOPLE_API = 'https://people.googleapis.com/v1';

/** Both listings cap a page at 1000, so an address book of a few hundred is one call. */
const PAGE_SIZE = 1000;

/** One HTTP call; injectable so no test touches the network. */
export type PeopleFetch = (
  url: string,
  init: { method: string; headers: Record<string, string> },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/** A failed People request, with the status that tells "not granted" (403) from everything else. */
export class PeopleApiError extends Error {
  readonly status: number;
  /** Google's own reason (`forbidden`, `accessNotConfigured`, …), when it gave one. */
  readonly reason?: string;

  constructor(status: number, reason: string | undefined, message: string, request: string) {
    super(`People API ${request} failed (${status}${reason ? ` ${reason}` : ''})${message ? `: ${message}` : ''}`);
    this.name = 'PeopleApiError';
    this.status = status;
    this.reason = reason;
  }
}

/** A person as both listings return it: only the two masks this module asks for. */
interface Person {
  emailAddresses?: { value?: string }[];
  photos?: { url?: string }[];
}

export interface PeopleClientOptions {
  account: GmailAccount;
  /** The same credential the mail reads use: one grant, one token, one refresh in flight. */
  credentials: Pick<GmailCredentials, 'accessToken'>;
  fetch?: PeopleFetch;
}

/** Google's error body: `{error: {status, message}}`. A non-JSON body is kept as text. */
function describeFailure(body: unknown, text: string): { reason?: string; message: string } {
  const error = (body as { error?: { status?: unknown; message?: unknown } } | null)?.error;
  const reason = typeof error?.status === 'string' ? error.status : undefined;
  const message = typeof error?.message === 'string' ? error.message : text.trim();
  return { reason, message };
}

/** One person's photo, keyed by every address it answers for: a face belongs to the person. */
function photosOf(people: Person[] | undefined): GooglePhoto[] {
  const photos: GooglePhoto[] = [];
  for (const person of people ?? []) {
    const url = person.photos?.find(photo => typeof photo?.url === 'string' && photo.url)?.url;
    if (!url) continue;
    for (const email of person.emailAddresses ?? []) {
      const address = typeof email?.value === 'string' ? email.value.trim().toLowerCase() : '';
      if (address) photos.push({ address, url });
    }
  }
  return photos;
}

export function createPeopleClient(options: PeopleClientOptions): GooglePeopleClient {
  const { account, credentials } = options;
  const http = options.fetch ?? (fetch as unknown as PeopleFetch);

  async function call(path: string, params: [string, string | number | undefined][], label: string): Promise<unknown> {
    const query = new URLSearchParams();
    for (const [name, value] of params) if (value !== undefined && value !== '') query.append(name, String(value));
    const search = query.toString();
    const url = `${PEOPLE_API}${path}${search ? `?${search}` : ''}`;
    const send = (token: string) => http(url, { method: 'GET', headers: { authorization: `Bearer ${token}` } });
    let response = await send(await credentials.accessToken(account));
    if (response.status === 401) response = await send(await credentials.accessToken(account, { force: true }));
    const text = await response.text();
    let body: unknown;
    let parsed = false;
    try {
      body = text ? JSON.parse(text) : {};
      parsed = true;
    } catch { /* an unparseable body still names the failure */ }
    if (!response.ok) {
      const { reason, message } = describeFailure(parsed ? body : undefined, text);
      throw new PeopleApiError(response.status, reason, message, label);
    }
    if (!parsed) throw new Error(`People API ${label} returned a body that is not JSON`);
    return body;
  }

  /** One page of a listing, flattened to the two fields a face needs. */
  async function page(path: string, mask: string, key: 'connections' | 'otherContacts', label: string, pageToken?: string): Promise<GooglePeoplePage> {
    const body = await call(path, [[mask, 'emailAddresses,photos'], ['pageSize', PAGE_SIZE], ['pageToken', pageToken]], label) as Record<string, unknown>;
    const token = typeof body?.nextPageToken === 'string' && body.nextPageToken ? body.nextPageToken : undefined;
    return { photos: photosOf(body?.[key] as Person[] | undefined), ...(token ? { nextPageToken: token } : {}) };
  }

  return {
    connections: pageToken => page('/people/me/connections', 'personFields', 'connections', 'people/me/connections', pageToken),
    otherContacts: pageToken => page('/otherContacts', 'readMask', 'otherContacts', 'otherContacts', pageToken),
  };
}
