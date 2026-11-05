// U7 — who holds the plugin's one socket, and for how long.
//
// Everything here runs against a real lock, a real account directory and a fake socket: the module's
// whole job is when a socket exists, so the socket itself is the only thing worth faking. What is
// pinned is the part that a stranger would meet as a bug rather than a state — a second ask opening a
// second socket, a refused start that leaves nothing to draw, a reload that keeps the lock, and a
// socket that outlives the pairing it was opened for.
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { rpcContract } from '../../src/rpc-contract.ts';
import { WhatsAppConnection } from '../../src/whatsapp/connection.ts';
import { createFileAuthStore } from '../../src/whatsapp/auth.ts';
import { createWhatsAppLifecycle } from '../../src/whatsapp/lifecycle.ts';
import { createWhatsAppPairing } from '../../src/whatsapp/pairing.ts';
import { acquireWhatsAppLock } from '../../src/whatsapp/lock.ts';
import { createSocketFactory, fakeAuthStore } from './fake-socket.ts';

const VERSION = [2, 3000, 1043856522] as [number, number, number];
const NOW = 1_000_000;

/**
 * One lifecycle over a scratch account directory. The lock and the directory are real, because the
 * invariant is about a second process and a second socket; only the socket is a fake.
 */
function harness(t: import('node:test').TestContext, options: { registered?: boolean; idleMs?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wa-lifecycle-'));
  const sockets = createSocketFactory();
  const built: WhatsAppConnection[] = [];
  const lifecycle = createWhatsAppLifecycle({
    create: () => {
      const connection = new WhatsAppConnection({
        authDir: dir,
        socketFactory: sockets.factory,
        createAuthStore: () => fakeAuthStore({ registered: options.registered === true }),
        waVersion: VERSION,
      });
      built.push(connection);
      return connection;
    },
    ...(options.idleMs !== undefined ? { idleMs: options.idleMs } : {}),
  });
  t.after(async () => { await lifecycle.close(); });
  return { dir, sockets, built, lifecycle };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('the first ask opens one socket, and every later ask is that socket', async (t) => {
  const h = harness(t);
  const [first, second] = await Promise.all([h.lifecycle.open(), h.lifecycle.open()]);

  assert.equal(first, second, 'two callers asking at once are one socket, not a race');
  assert.equal(h.built.length, 1);
  assert.equal(h.lifecycle.current(), first);
  assert.equal(h.sockets.configs.length, 1, 'one socket reached the client');
  assert.ok(existsSync(join(h.dir, 'socket.lock')), 'and its lock is held while it runs');
});

test('a refused start is a sentence the card can read, and the next ask tries again', async (t) => {
  const h = harness(t);
  const held = acquireWhatsAppLock(h.dir);
  try {
    await assert.rejects(h.lifecycle.open(), /already open in process/);

    assert.equal(h.lifecycle.current(), undefined, 'a refusal leaves no socket behind');
    assert.equal(h.sockets.configs.length, 0, 'and nothing was dialled');
    assert.match(h.lifecycle.failure() ?? '', /already open in process \d+/, 'the refusal is kept, in the socket\'s own words');
  } finally {
    held.release();
  }

  const opened = await h.lifecycle.open();
  assert.equal(h.lifecycle.current(), opened);
  assert.equal(h.lifecycle.failure(), undefined, 'a start that worked forgets the refusal');
});

test('a stopped socket releases its lock, and stopping twice is one stop', async (t) => {
  const h = harness(t);
  const opened = await h.lifecycle.open();

  await h.lifecycle.close();
  await h.lifecycle.close();

  assert.equal(opened.status(), 'disconnected');
  assert.equal(h.lifecycle.current(), undefined);
  const next = acquireWhatsAppLock(h.dir);
  next.release();
});

test('the idle window stops a socket nobody linked, and the account state is left alone', async (t) => {
  const h = harness(t, { idleMs: 20 });
  const opened = await h.lifecycle.open();
  const filesBefore = createFileAuthStore(h.dir).hasCreds();

  await sleep(80);

  assert.equal(opened.status(), 'disconnected', 'a QR nobody scanned stops costing a socket');
  assert.equal(h.lifecycle.current(), undefined);
  assert.equal(createFileAuthStore(h.dir).hasCreds(), filesBefore, 'and the account state it never used is untouched');

  const reopened = await h.lifecycle.open();
  assert.equal(h.built.length, 2, 'the next ask opens a socket rather than reviving the stopped one');
  assert.equal(h.lifecycle.current(), reopened);
});

test('a linked socket is never stopped for being idle: it is how messages arrive', async (t) => {
  const h = harness(t, { registered: true, idleMs: 20 });
  const opened = await h.lifecycle.open();

  await sleep(80);

  assert.equal(h.lifecycle.current(), opened, 'a paired account keeps its connection');
  assert.equal(opened.status(), 'connecting', 'and it is still the socket that will report');
});

test('a boot socket that will not open reaches the card as a failure, not as connected', async (t) => {
  const h = harness(t);
  // What a restart after a successful pairing looks like: the credential files are there, so the
  // source *looks* linked — and only the socket refuses.
  await createFileAuthStore(h.dir).saveCreds();
  const held = acquireWhatsAppLock(h.dir);
  try {
    // The boot path is exactly this call, and its failure is a return rather than a throw.
    await assert.rejects(h.lifecycle.open());
  } finally {
    held.release();
  }

  const pairing = createWhatsAppPairing({
    open: () => h.lifecycle.open(),
    current: () => h.lifecycle.current(),
    close: () => h.lifecycle.close(),
    failure: () => h.lifecycle.failure(),
    now: () => NOW,
  });
  const drawn = pairing.state();
  assert.equal(drawn.state, 'failed', 'an account on disk is not a socket that is up');
  assert.match(drawn.message ?? '', /already open in process \d+/);
  assert.notEqual(drawn.state, 'connected', 'the credential files alone never answer this');
  assert.equal(rpcContract.whatsapp_pairing.output.safeParse(drawn).success, true);

  // The card's own retry is the reconnect act, and it clears the failure it was drawn from.
  const retried = await pairing.handle({ op: 'reconnect' });
  assert.equal(retried.state, 'connecting', 'the socket the boot path could not open is now open');
  assert.equal(h.lifecycle.failure(), undefined);
});

test('unpairing forgets the account state and a failure that was about it', async (t) => {
  const h = harness(t);
  const held = acquireWhatsAppLock(h.dir);
  await assert.rejects(h.lifecycle.open());
  held.release();

  await h.lifecycle.close();
  assert.equal(h.lifecycle.failure(), undefined);
});
