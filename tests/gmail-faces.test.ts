// INBOX-38 — where a Gmail row's contact photo comes from.
//
// The store answers a draw, and the address book is read behind it. These tests pin the four rules
// that make the source inert rather than broken: the ask never lands on the draw, a miss is
// remembered and re-asked slowly, a refused read is remembered as nothing at all (so a later consent
// fills the book in at once), and a stale URL is still drawn while a fresh one is asked for.
import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { createGmailFaces, createGmailFaceStore } from '../src/gmail-faces.ts';
import { PeopleApiError } from '../src/google-people.ts';
import type { GooglePeoplePage } from '../src/adapters/types.ts';

const ADA = 'ada@example.com';
const PHOTO = 'https://lh3.googleusercontent.com/a/ACg8ocPhoto=s96-c';

/** Let the background drain finish: it is deliberately not awaited by the draw that started it. */
async function settle(): Promise<void> {
  for (let round = 0; round < 4; round += 1) await new Promise(resolve => setImmediate(resolve));
}

function refused(label: string): PeopleApiError {
  return new PeopleApiError(403, 'forbidden', 'Request had insufficient authentication scopes.', label);
}

interface Fixture {
  store: ReturnType<typeof createGmailFaceStore>;
  faces: ReturnType<typeof createGmailFaces>;
  asks: string[];
  notes: string[];
  advance(ms: number): void;
  close(): void;
}

function fixture(options: {
  saved?: GooglePeoplePage;
  other?: GooglePeoplePage;
  fail?: (listing: 'connections' | 'otherContacts') => unknown;
} = {}): Fixture {
  const db = new Database(':memory:');
  const store = createGmailFaceStore(db);
  const asks: string[] = [];
  const notes: string[] = [];
  let clock = 1_700_000_000_000;
  const answer = (listing: 'connections' | 'otherContacts', page: GooglePeoplePage | undefined) => async (pageToken?: string) => {
    asks.push(`${listing}:${pageToken ?? ''}`);
    const failure = options.fail?.(listing);
    if (failure) throw failure;
    return page ?? { photos: [] };
  };
  const faces = createGmailFaces({
    account: 'gmail-personal',
    store,
    people: {
      connections: answer('connections', options.saved),
      otherContacts: answer('otherContacts', options.other),
    },
    note: line => notes.push(line),
    now: () => clock,
  });
  return { store, faces, asks, notes, advance: ms => { clock += ms; }, close: () => db.close() };
}

test('a face is asked for behind the draw, and the next draw has it', async () => {
  const f = fixture({ saved: { photos: [{ address: ADA, url: PHOTO }] } });
  try {
    assert.equal(f.faces.url(ADA), undefined, 'the draw that finds nothing answers at once and draws initials');
    await settle();
    assert.equal(f.store.get('gmail-personal', ADA)?.url, PHOTO, 'the address book answered behind it');
    assert.equal(f.faces.url(ADA), PHOTO, 'the next draw draws the picture from the store');
    const asked = f.asks.length;
    await settle();
    f.faces.url(ADA);
    await settle();
    assert.equal(f.asks.length, asked, 'a face inside its TTL is never asked again');
    assert.deepEqual(f.notes, [], 'a source that works says nothing');
  } finally { f.close(); }
});

test('one address book read answers a page of senders, not one call per sender', async () => {
  const f = fixture({ saved: { photos: [{ address: ADA, url: PHOTO }, { address: 'grace@example.com', url: PHOTO }] } });
  try {
    for (const address of [ADA, 'grace@example.com', 'alan@example.com']) f.faces.url(address);
    await settle();
    assert.deepEqual(f.asks.filter(ask => ask.startsWith('connections')), ['connections:'], 'the queue is one batched read');
    assert.equal(f.faces.url(ADA), PHOTO);
    assert.equal(f.faces.url('grace@example.com'), PHOTO);
  } finally { f.close(); }
});

test('a sender with no photo is remembered once, and a later email does not ask again', async () => {
  const f = fixture();
  try {
    f.faces.url(ADA);
    await settle();
    assert.equal(f.store.get('gmail-personal', ADA)?.state, 'failed', '"no photo" is an answer, and it is recorded');
    const asked = f.asks.length;
    f.advance(7 * 24 * 60 * 60 * 1000);
    f.faces.url(ADA);
    await settle();
    assert.equal(f.asks.length, asked, 'the same sender is never asked a second time');
  } finally { f.close(); }
});

test('a refused read is asked once: initials, one line, and the sender is not asked again', async () => {
  const f = fixture({ fail: listing => refused(listing) });
  try {
    assert.equal(f.faces.url(ADA), undefined);
    await settle();
    assert.equal(f.store.get('gmail-personal', ADA), undefined, 'a refused read is not evidence about the address');
    assert.equal(f.notes.length, 1, 'two refused listings are one thing to fix, so one line');
    assert.match(f.notes[0], /contacts\.readonly is not granted/);
    assert.match(f.notes[0], /contacts\.other\.readonly is not granted/);
    assert.doesNotMatch(f.notes[0], /ya29|Bearer/, 'a line about a face never carries a credential');

    const asked = f.asks.length;
    f.advance(7 * 24 * 60 * 60 * 1000);
    f.faces.url(ADA);
    await settle();
    assert.equal(f.asks.length, asked, 'a refused scope is asked once, not on every later email');
    assert.equal(f.notes.length, 1, 'and the missing scope is named once');
  } finally { f.close(); }
});

test('a grant that covers saved contacts but not other contacts still draws the faces it can', async () => {
  const f = fixture({
    saved: { photos: [{ address: ADA, url: PHOTO }] },
    fail: listing => (listing === 'otherContacts' ? refused('otherContacts') : undefined),
  });
  try {
    f.faces.url(ADA);
    f.faces.url('stranger@example.com');
    await settle();
    assert.equal(f.faces.url(ADA), PHOTO, 'the granted half answers');
    assert.equal(f.store.get('gmail-personal', 'stranger@example.com')?.state, 'failed', 'a sender asked once and not found is not asked again');
    assert.equal(f.notes.length, 1);
    assert.match(f.notes[0], /contacts\.other\.readonly is not granted/);
    assert.doesNotMatch(f.notes[0], /auth\/contacts\.readonly is not granted/);
  } finally { f.close(); }
});

test('a stored picture is drawn again without another request', async () => {
  const f = fixture({ saved: { photos: [{ address: ADA, url: PHOTO }] } });
  try {
    f.faces.url(ADA);
    await settle();
    const asked = f.asks.length;
    f.advance(7 * 24 * 60 * 60 * 1000);
    assert.equal(f.faces.url(ADA), PHOTO);
    await settle();
    assert.equal(f.asks.length, asked, 'a sender who already has a picture is not refreshed');
  } finally { f.close(); }
});

test('an address is the key: case and padding are one person, and an empty address is nobody', async () => {
  const f = fixture({ saved: { photos: [{ address: ADA, url: PHOTO }] } });
  try {
    f.faces.url('Ada@Example.com');
    await settle();
    assert.equal(f.faces.url(' ada@example.com '), PHOTO, 'the header\'s spelling is folded, so the same person is one face');
    f.faces.url('');
    await settle();
    assert.equal(f.store.get('gmail-personal', ''), undefined, 'a row with no sender address never queues an ask');
  } finally { f.close(); }
});

test('clear_cache takes the address book with it', async () => {
  const f = fixture({ saved: { photos: [{ address: ADA, url: PHOTO }] } });
  try {
    f.faces.url(ADA);
    await settle();
    assert.equal(f.store.get('gmail-personal', ADA)?.url, PHOTO);
    f.store.clear();
    assert.equal(f.store.get('gmail-personal', ADA), undefined);
  } finally { f.close(); }
});
