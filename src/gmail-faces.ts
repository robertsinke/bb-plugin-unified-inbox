// Where a Gmail row's face comes from (INBOX-38).
//
// A face is the one fact about a sender the cache cannot already hold: it has to be asked for, and
// asking is a network call to Google's People API. So the read is split in two, exactly as
// `src/whatsapp/avatars.ts` splits WhatsApp's. `url(address)` answers what the store knows,
// synchronously and without a request. An address it has never been asked is queued once, so a new
// sender draws initials on the first draw and the picture on the next. No list call waits on Google.
//
// One rule: a sender is asked once, the first time a new email names them. A stored answer — a
// picture or "no photo" — is final, so a later email from the same person costs no request. The ask
// is still the address book, not one call per sender: several new senders in one draw share one
// read, and that read also answers for `BOOK_TTL_MS`. A listing that fails is not asked again.
// One log line names a missing scope. The panel's `onError` turns a dead picture back into initials.
import type Database from 'better-sqlite3';
import { redactProviderText } from './adapters/provider-error.ts';
import type { GmailAccount, GooglePeopleClient, GooglePeoplePage } from './adapters/types.ts';

/**
 * How long one address book read answers for. A page is drawn a row at a time, so without this the
 * first new sender's read would be repeated for every new sender after it.
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

/** What one round of the address book answered. */
type AddressBook = { photos: Map<string, string> };

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
   * store has never been asked is asked once in the background. A stored answer is not asked again.
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

/** A stored answer is final. Only an address this account has never asked is worth a request. */
  function unseen(face: GmailFace | undefined): boolean {
    return !face || face.fetched_at === null;
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
        // Nothing answered, so nothing is known about these senders. They are not stored as
        // misses: a refused address book is not "no photo". The listing is not asked again
        // this session, which is what stops every later email from calling Google.
        if (!book) break;
        for (const address of addresses) remember(address, book.photos.get(address) ?? null);
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
        listing.retryAt = Number.POSITIVE_INFINITY;
        refused.push(reasonFor(listing, cause));
      }
    }
    // One line per round, however many listings refused: a missing consent is one thing to fix, and
    // a draw must not fill the log with a line per listing or a line per row.
    if (refused.length) note(`Gmail faces for ${account} are off: ${refused.join('; ')}. Rows draw initials; re-consent steps are in docs/operator.md.`);
    return answered ? { photos } : undefined;
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

/** What one address now knows. Written once: a later email from this sender does not ask again. */
  function remember(address: string, url: string | null): void {
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
      if (unseen(face)) enqueue(key);
      return face?.state === 'ready' && face.url ? face.url : undefined;
    },
  };
}
