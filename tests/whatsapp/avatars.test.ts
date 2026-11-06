// INBOX-29 — where a WhatsApp picture comes from. The picture is the one fact about a chat that has
// to be asked for, so these tests pin the split that keeps a list from waiting: what the store knows
// is answered synchronously, everything else is asked behind the draw, one jid at a time, and never
// through a socket the caller had to open.
//
// Proved against the real store (in-memory database) and a socket that is a literal: no Baileys, no
// network, no account state.
import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import type { WhatsAppAvatarSocket } from '../../src/whatsapp/connection.ts';
import { AVATAR_RETRY_MS, AVATAR_TTL_MS, createWhatsAppAvatars } from '../../src/whatsapp/avatars.ts';
import { createWhatsAppStore, type WhatsAppStore } from '../../src/whatsapp/store.ts';

const ADA = '15551234567@s.whatsapp.net';
const GRACE = '15559876543@s.whatsapp.net';
const GROUP = '120363000000000003@g.us';
const PICTURE = 'https://pps.whatsapp.net/v/t61.24694-24/1_n.jpg?oe=68a1b2c3';
const GRACE_PICTURE = 'https://pps.whatsapp.net/v/t61.24694-24/2_n.jpg?oe=68a1b2c4';

/**
 * Let every queued ask and the write behind it finish, without a timer in the test. The queue asks one
 * jid per macrotask, so a page of rows needs a few rounds.
 */
async function settle(): Promise<void> {
  for (let round = 0; round < 6; round += 1) await new Promise((resolve) => setImmediate(resolve));
}

function fixture() {
  const db = new Database(':memory:');
  return { store: createWhatsAppStore(db), close: () => db.close() };
}

type Ask = { jid: string; type?: 'preview' | 'image'; timeoutMs?: number };

/**
 * A socket that answers what a test tells it to: a URL, nothing (no picture), or a throw — and it
 * records every ask so "asked once" and "never asked" are provable.
 */
function fakeSocket(answers: (jid: string) => string | undefined | Error = () => undefined) {
  const asks: Ask[] = [];
  let inFlight = 0;
  let peak = 0;
  const socket: WhatsAppAvatarSocket = {
    async profilePictureUrl(jid, type, timeoutMs) {
      asks.push({ jid, ...(type ? { type } : {}), ...(timeoutMs ? { timeoutMs } : {}) });
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      try {
        const answer = answers(jid);
        // A yield, so asks that were queued together would overlap if the queue let them.
        await new Promise((resolve) => setImmediate(resolve));
        if (answer instanceof Error) throw answer;
        return answer;
      } finally {
        inFlight -= 1;
      }
    },
  };
  return { socket, asks, peak: () => peak };
}

function avatars(store: WhatsAppStore, socket: WhatsAppAvatarSocket | undefined, clock = { now: 1_700_000_000_000 }) {
  return createWhatsAppAvatars({
    store,
    socket: () => socket,
    now: () => clock.now,
  });
}

test('a picture is asked for behind the draw, and the next draw answers it', async () => {
  const { store, close } = fixture();
  try {
    const fake = fakeSocket(() => PICTURE);
    const pictures = avatars(store, fake.socket);

    // The first draw: nothing stored, so the row draws initials and the ask starts behind it.
    assert.equal(pictures.url(ADA), undefined, 'a store read never waits on WhatsApp');
    assert.deepEqual(fake.asks, [{ jid: ADA, type: 'preview', timeoutMs: 8_000 }]);

    await settle();
    const stored = store.getAvatar(ADA);
    assert.equal(stored?.state, 'ready');
    assert.equal(stored?.url, PICTURE);
    assert.equal(stored?.fetched_at, 1_700_000_000_000, 'when it was fetched is kept with it');

    assert.equal(pictures.url(ADA), PICTURE, 'the next draw has the picture');
    await settle();
    assert.equal(fake.asks.length, 1, 'a URL inside its TTL is not asked for again');
  } finally {
    close();
  }
});

test('no socket: nothing is asked, nothing is stored, and the row keeps its initials', async () => {
  const { store, close } = fixture();
  try {
    const pictures = avatars(store, undefined);
    assert.equal(pictures.url(ADA), undefined);
    await settle();
    assert.equal(store.getAvatar(ADA), undefined, 'an unanswerable ask is not recorded as a verdict');
  } finally {
    close();
  }
});

test('no picture is a normal answer: initials, recorded, and asked again only after the retry window', async () => {
  const { store, close } = fixture();
  try {
    const fake = fakeSocket(() => undefined);
    const clock = { now: 1_700_000_000_000 };
    const pictures = avatars(store, fake.socket, clock);

    assert.equal(pictures.url(ADA), undefined);
    await settle();
    assert.equal(store.getAvatar(ADA)?.state, 'failed');
    assert.equal(store.getAvatar(ADA)?.url, null);

    // A redraw inside the window draws initials without a second ask — a page polls every few seconds.
    assert.equal(pictures.url(ADA), undefined);
    await settle();
    assert.equal(fake.asks.length, 1, 'the same page is not re-asked on every draw');

    clock.now += AVATAR_RETRY_MS + 1;
    assert.equal(pictures.url(ADA), undefined);
    await settle();
    assert.equal(fake.asks.length, 2, 'a person can set a picture later, so the answer is asked again');
  } finally {
    close();
  }
});

test('a refused ask is not surfaced, and is retried like a no-picture answer', async () => {
  const { store, close } = fixture();
  try {
    let fail = true;
    const fake = fakeSocket(() => (fail ? new Error('item-not-found') : GRACE_PICTURE));
    const clock = { now: 1_700_000_000_000 };
    const pictures = avatars(store, fake.socket, clock);

    // Nothing is thrown: this answer is read while a list is being drawn.
    assert.equal(pictures.url(ADA), undefined);
    await settle();
    assert.equal(store.getAvatar(ADA)?.state, 'failed');
    // The reason is kept, because a privacy setting, a timeout and a socket blip all land in the
    // same `failed` row and only this line tells them apart.
    assert.equal(store.getAvatar(ADA)?.reason, 'item-not-found');

    fail = false;
    clock.now += AVATAR_RETRY_MS + 1;
    assert.equal(pictures.url(ADA), undefined, 'a refusal is never drawn as a broken image');
    await settle();
    assert.equal(fake.asks.length, 2, 'a refusal is retried, never recorded as permanent');
    assert.equal(store.getAvatar(ADA)?.url, GRACE_PICTURE);
    assert.equal(store.getAvatar(ADA)?.reason, undefined, 'an answer that arrived clears the reason it carried');
    assert.equal(pictures.url(ADA), GRACE_PICTURE);
  } finally {
    close();
  }
});

test('a fresh URL is answered without asking, and a stale one is answered while it is refreshed', async () => {
  const { store, close } = fixture();
  try {
    const fake = fakeSocket(() => GRACE_PICTURE);
    const clock = { now: 1_700_000_000_000 };
    store.setAvatar({ jid: ADA, url: PICTURE, state: 'ready', fetched_at: clock.now });
    const pictures = avatars(store, fake.socket, clock);

    assert.equal(pictures.url(ADA), PICTURE);
    await settle();
    assert.deepEqual(fake.asks, [], 'a URL inside its TTL is answered from the store alone');

    clock.now += AVATAR_TTL_MS + 1;
    assert.equal(pictures.url(ADA), PICTURE, 'a stale URL still loads, so it is drawn while it is refreshed');
    await settle();
    assert.equal(fake.asks.length, 1);
    assert.equal(store.getAvatar(ADA)?.url, GRACE_PICTURE, 'and the refreshed URL replaces it');
  } finally {
    close();
  }
});

test('a refresh that fails keeps the picture the chat already had', async () => {
  const { store, close } = fixture();
  try {
    const fake = fakeSocket(() => new Error('item-not-found'));
    const clock = { now: 1_700_000_000_000 };
    store.setAvatar({ jid: ADA, url: PICTURE, state: 'ready', fetched_at: clock.now });
    const pictures = avatars(store, fake.socket, clock);

    clock.now += AVATAR_TTL_MS + 1;
    assert.equal(pictures.url(ADA), PICTURE);
    await settle();
    assert.equal(fake.asks.length, 1, 'a stale picture is asked again');
    assert.equal(pictures.url(ADA), PICTURE, 'a failed refresh does not blank a picture that already loaded');
    assert.equal(store.getAvatar(ADA)?.url, PICTURE);
    assert.equal(store.getAvatar(ADA)?.state, 'ready');
    assert.equal(pictures.url(ADA), PICTURE);
    await settle();
    assert.equal(fake.asks.length, 1, 'the kept picture is not asked again on the next draw');
  } finally {
    close();
  }
});

test('two draws of one page ask once, and a page of rows is asked one at a time', async () => {
  const { store, close } = fixture();
  try {
    const fake = fakeSocket(jid => (jid === ADA ? PICTURE : GRACE_PICTURE));
    const pictures = avatars(store, fake.socket);

    // The panel decorates every row it draws, so the same jid is asked for on each draw of the page.
    pictures.url(ADA);
    pictures.url(ADA);
    pictures.url(GRACE);
    pictures.url(GROUP);
    await settle();

    assert.deepEqual(fake.asks.map(ask => ask.jid).sort(), [ADA, GRACE, GROUP].sort());
    assert.equal(fake.peak(), 1, 'a page of rows is a queue, not a burst of IQs');
    assert.equal(store.getAvatar(GRACE)?.url, GRACE_PICTURE);
    assert.equal(store.getAvatar(GROUP)?.url, GRACE_PICTURE, 'a group has a picture of its own, not a mosaic');
  } finally {
    close();
  }
});

test('a socket that closes mid-page drops the rest of the queue and asks again on the next draw', async () => {
  const { store, close } = fixture();
  try {
    let open = true;
    const fake = fakeSocket(jid => (jid === ADA ? PICTURE : GRACE_PICTURE));
    const pictures = createWhatsAppAvatars({ store, socket: () => (open ? fake.socket : undefined), now: () => 1_700_000_000_000 });

    pictures.url(ADA);
    pictures.url(GRACE);
    open = false;
    await settle();
    assert.equal(store.getAvatar(GRACE), undefined, 'a row that was never asked keeps no verdict');

    open = true;
    pictures.url(GRACE);
    await settle();
    assert.equal(store.getAvatar(GRACE)?.url, GRACE_PICTURE, 'and it is asked for once the socket is back');
  } finally {
    close();
  }
});
