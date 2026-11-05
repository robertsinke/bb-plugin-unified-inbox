// Where a Gmail row's face comes from (INBOX-38).
//
// A face is the one fact about a sender the cache cannot already hold: it has to be asked for, and
// asking is a network call to Google's People API. So the read is split in two, exactly as
// `src/whatsapp/avatars.ts` splits WhatsApp's. `url(address)` answers what the store knows,
// synchronously and without a request; an address it does not know — or knows from longer ago than
// `FACE_TTL_MS` — is queued and asked for in the background, so a row draws initials on the draw it
// first appears and its picture on the next one. No list call ever waits on Google.
//
// Five rules live here and nowhere else:
//   - the ask is an address book, not one lookup per sender. Both listings are read whole with a
//     page token, and every queued address is answered from that one read: a page of ten rows is
//     one or two calls, not ten. A page is drawn a row at a time (each row costs a thread read), so
//     one read also answers for `BOOK_TTL_MS` afterwards — otherwise "batched" would only mean
//     "batched per row". `MAX_PAGES` bounds a book that somehow never ends.
//   - each listing is asked on its own account of time (`SOURCE_RETRY_MS` after it failed), because
//     the two grants are separate: a consent that covers saved contacts and not other contacts must
//     still draw the faces it can, and a refused scope must not be re-asked by every draw.
//   - "no photo" is an answer, recorded as `failed` and re-asked only after `FACE_RETRY_MS`, like
//     WhatsApp's hour. A person can set a picture later.
//   - a refused or failed listing is not an answer at all: nothing is recorded for the addresses it
//     was going to cover, so consenting later fills the book in at once instead of after a miss that
//     was never measured. One log line names what is missing; the rows above it draw initials.
//   - a stored URL is answered even past its TTL. It usually still loads, and the panel's own
//     `onError` turns a dead one back into initials (`app.tsx`), so blanking a picture to refresh it
//     is strictly worse than showing a stale one.
import type Database from 'better-sqlite3';
import { redactProviderText } from './adapters/provider-error.ts';
import type { GmailAccount, GooglePeopleClient, GooglePeoplePage } from './adapters/types.ts';

/**
 * How long a picture URL is trusted before the book is read again. A person changes their photo
 * rarely — far more rarely than WhatsApp's links expire — so this is a week against WhatsApp's day.
 */
export const FACE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** How long "this sender has no photo" is trusted before it is asked again. */
export const FACE_RETRY_MS = 60 * 60 * 1000;
/** How long a listing that failed is left alone, so one refused scope is one log line an hour. */
export const SOURCE_RETRY_MS = 60 * 60 * 1000;
/**
 * How long one address book read answers for. A page is drawn a row at a time, so without this the
 * first row's read would be repeated for every row after it and "batched" would mean "batched per
 * row". It sits far below `FACE_TTL_MS`, so it can never hold a picture past its trust.
 */
export const BOOK_TTL_MS = 10 * 60 * 1000;
/** Ten pages of a thousand: a bound on the walk, not a guess about the address book. */
export const MAX_PAGES = 10;

/** One remembered answer for one address, and when it was learned. */
export type GmailFace = {
  address: string;
  url: string | null;
  state: 'ready' | 'failed';
  fetched_at: number | null;
};

/**
 * The durable half: one row per address per account. Keyed by account as well as address because
 * each account has its own address book and its own grant — one account's "no photo" is not
 * evidence about the other's. The plugin database, `gmail_`-prefixed so it cannot collide with the
 * `wa_` tables' or the panel's cache, cleared by `clear_cache` through `src/inbox-cache.ts`.
 */
export function createGmailFaceStore(db: Database.Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS gmail_faces (
    account TEXT NOT NULL,
    address TEXT NOT NULL,
    url TEXT,
    state TEXT NOT NULL CHECK (state IN ('ready', 'failed')),
    fetched_at INTEGER,
    PRIMARY KEY (account, address)
  )`);
  const read = db.prepare('SELECT address, url, state, fetched_at FROM gmail_faces WHERE account = ? AND address = ?');
  const write = db.prepare(`INSERT INTO gmail_faces (account, address, url, state, fetched_at)
    VALUES (@account, @address, @url, @state, @fetched_at)
    ON CONFLICT(account, address) DO UPDATE SET
      url = excluded.url, state = excluded.state, fetched_at = excluded.fetched_at`);
  const drop = db.prepare('DELETE FROM gmail_faces');
  return {
    get(account: GmailAccount, address: string): GmailFace | undefined {
      return read.get(account, address) as GmailFace | undefined;
    },
    save(account: GmailAccount, face: GmailFace): void {
      write.run({ ...face, account });
    },
    /** `clear_cache`: the address book's answers are the contacts' data, and outlive nothing. */
    clear(): void {
      drop.run();
    },
  };
}

export type GmailFaceStore = ReturnType<typeof createGmailFaceStore>;

/** A listing and when it may be asked again: the two grants, each with its own account of time. */
type Listing = {
  /** The scope a failure names, so the log line says what to grant rather than that something broke. */
  scope: string;
  read(pageToken?: string): Promise<GooglePeoplePage>;
  retryAt: number;
};

/** What one round of the address book answered: the photos, and whether every listing did. */
type AddressBook = { photos: Map<string, string>; certain: boolean };

export type GmailFacesOptions = {
  account: GmailAccount;
  store: GmailFaceStore;
  people: GooglePeopleClient;
  /** One line per refused or failed listing. The row above it still draws initials. */
  note?: (line: string) => void;
  /** Injected for tests; the TTLs are otherwise measured against the wall clock. */
  now?: () => number;
};

export interface GmailFaces {
  /**
   * The picture this address already has, answered now and without a network call. An address the
   * store knows nothing about — or knows from longer ago than the TTL — is asked for in the
   * background, so this is a store read and never a wait.
   */
  url(address: string): string | undefined;
}

export function createGmailFaces(options: GmailFacesOptions): GmailFaces {
  const { account, store, people } = options;
  const clock = options.now ?? Date.now;
  const note = options.note ?? (() => {});
  /** Addresses a draw has asked for since the last completed read. */
  const queued = new Set<string>();
  const listings: Listing[] = [
    { scope: 'https://www.googleapis.com/auth/contacts.readonly', read: pageToken => people.connections(pageToken), retryAt: 0 },
    { scope: 'https://www.googleapis.com/auth/contacts.other.readonly', read: pageToken => people.otherContacts(pageToken), retryAt: 0 },
  ];
  let draining = false;
  /** The last address book read, kept so the rest of the page it was read for costs no request. */
  let memo: (AddressBook & { at: number }) | undefined;

  /** Whether what the store holds is too old to be trusted. A URL past its TTL is still drawn. */
  function stale(face: GmailFace | undefined, at: number): boolean {
    if (!face || face.fetched_at === null) return true;
    const age = at - face.fetched_at;
    return face.state === 'ready' ? age > FACE_TTL_MS : age > FACE_RETRY_MS;
  }

  /**
   * Ask for one address, once. Sequential by construction: a drain already running picks the new
   * address up on its next round, so a page of fifty rows is one address book read, not fifty.
   */
  function enqueue(address: string): void {
    if (!address || queued.has(address)) return;
    queued.add(address);
    // A face is a nicety beside the row it decorates: a drain that fails somewhere unexpected is
    // dropped rather than allowed to surface as an unhandled rejection in a read that never awaited it.
    void drain().catch(() => {});
  }

  async function drain(): Promise<void> {
    if (draining) return;
    draining = true;
    try {
      for (;;) {
        const addresses = [...queued];
        queued.clear();
        if (!addresses.length) break;
        const book = await currentBook();
        // Nothing answered, so nothing is known: the addresses are not remembered as misses (a
        // later consent must fill them in at once) and the next draw asks again — after the
        // per-listing retry, which is what stops an hourly ask from being a per-draw ask.
        if (!book) break;
        for (const address of addresses) remember(address, book);
      }
    } finally {
      // Whatever is left was not asked (nothing answered), so it must be askable again.
      queued.clear();
      draining = false;
    }
  }

  /** The address book, read now or answered from the last read when that is still recent enough. */
  async function currentBook(): Promise<AddressBook | undefined> {
    if (memo && clock() - memo.at < BOOK_TTL_MS) return memo;
    const read = await addressBook();
    memo = read ? { ...read, at: clock() } : undefined;
    return read;
  }

  /** Both listings, each page by page, merged into one address → photo map. */
  async function addressBook(): Promise<AddressBook | undefined> {
    const photos = new Map<string, string>();
    const refused: string[] = [];
    let answered = 0;
    for (const listing of listings) {
      if (clock() < listing.retryAt) continue;
      try {
        for (const [address, url] of await pages(listing)) if (!photos.has(address)) photos.set(address, url);
        answered += 1;
      } catch (cause) {
        listing.retryAt = clock() + SOURCE_RETRY_MS;
        refused.push(reasonFor(listing, cause));
      }
    }
    // One line per round, however many listings refused: a missing consent is one thing to fix, and
    // a draw must not fill the log with a line per listing or a line per row.
    if (refused.length) note(`Gmail faces for ${account} are off: ${refused.join('; ')}. Rows draw initials; re-consent steps are in README.md, "Gmail contact photos".`);
    return answered ? { photos, certain: answered === listings.length } : undefined;
  }

  async function pages(listing: Listing): Promise<Map<string, string>> {
    const photos = new Map<string, string>();
    let token: string | undefined;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const answer = await listing.read(token);
      for (const photo of answer.photos) photos.set(photo.address, photo.url);
      token = answer.nextPageToken;
      if (!token) break;
    }
    return photos;
  }

  /**
   * What one address now knows. A miss is recorded only when every listing answered: a listing that
   * was refused cannot say an address has no photo, and recording its silence as a miss would hide
   * the face for an hour after the owner consents.
   */
  function remember(address: string, book: AddressBook): void {
    const url = book.photos.get(address) ?? null;
    if (!url && !book.certain) return;
    try {
      store.save(account, { address, url, state: url ? 'ready' : 'failed', fetched_at: clock() });
    } catch {
      /* a picture must never break the read that asked for it */
    }
  }

  /** What is missing, in the words that name the fix. Never a token, never a raw answer body. */
  function reasonFor(listing: Listing, cause: unknown): string {
    const status = (cause as { status?: number } | null)?.status;
    if (status === 403) return `${listing.scope} is not granted`;
    return redactProviderText(cause instanceof Error ? cause.message : String(cause));
  }

  return {
    url(address: string): string | undefined {
      const key = address.trim().toLowerCase();
      if (!key) return undefined;
      const face = store.get(account, key);
      if (stale(face, clock())) enqueue(key);
      return face?.state === 'ready' && face.url ? face.url : undefined;
    },
  };
}
