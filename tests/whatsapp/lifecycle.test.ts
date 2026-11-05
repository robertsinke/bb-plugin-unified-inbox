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
function harness(t: import('node:test').TestContext, options: { registered?: boolean; idleMs?: number; note?: (level: 'info' | 'warn', line: string) => void } = {}) {
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
    ...(options.note ? { note: options.note } : {}),
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

test('a linked account with no socket is never drawn as connected', async (t) => {
  const h = harness(t);
  // A restart after a successful pairing: the credential files are there, so the source looks linked.
  await createFileAuthStore(h.dir).saveCreds();

  const card = (opening?: () => boolean) => createWhatsAppPairing({
    open: () => h.lifecycle.open(),
    current: () => h.lifecycle.current(),
    close: reason => h.lifecycle.close(reason),
    failure: () => h.lifecycle.failure(),
    ...(opening ? { opening } : {}),
    now: () => NOW,
  });

  // The lie that started this: an account on disk is not a socket, and the card answered `connected`
  // while every media read and every send found nothing to talk to.
  const idle = card().state();
  assert.equal(idle.state, 'failed', 'no socket and nothing opening is not connected');
  assert.match(idle.message ?? '', /not connected.*Reconnect/i, 'the card names the act that changes it');
  assert.equal(rpcContract.whatsapp_pairing.output.safeParse(idle).success, true);

  const starting = card(() => true).state();
  assert.equal(starting.state, 'connecting', 'an open that is in flight is a state, not a failure');

  // And the act the card offers does open it.
  const reopened = await card().handle({ op: 'reconnect' });
  assert.notEqual(reopened.state, 'connected', 'a socket that is still connecting is not claimed as connected');
  assert.equal(reopened.state, 'connecting');
  assert.equal(h.lifecycle.failure(), undefined);
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

test('a call that needs a socket reopens one the lifecycle no longer holds', async (t) => {
  const h = harness(t);
  const first = await h.lifecycle.open();

  // A read asks `current()` and lives with the answer; a download or a send needs a socket, and a
  // stopped one is opened again rather than reported as a source that is gone.
  assert.equal(await h.lifecycle.ensure(), first, 'the socket that is already open is the answer');
  await h.lifecycle.close('the host stopped the whatsapp-connection service');
  assert.equal(h.lifecycle.current(), undefined);

  const reopened = await h.lifecycle.ensure();
  assert.notEqual(reopened, first, 'a socket the lifecycle stopped is not handed back');
  assert.equal(h.lifecycle.current(), reopened);
  assert.equal(h.built.length, 2, 'a second socket was opened, not a dead one revived');
  assert.equal(h.sockets.configs.length, 2, 'and it reached the client');
});

test('an ask that is refused answers undefined, and the refusal stays where the card reads it', async (t) => {
  const h = harness(t);
  const held = acquireWhatsAppLock(h.dir);
  try {
    assert.equal(await h.lifecycle.ensure(), undefined, 'a caller that cannot throw is not thrown at');
    assert.match(h.lifecycle.failure() ?? '', /already open in process \d+/, 'and the card still gets the words');
  } finally {
    held.release();
  }

  assert.ok(await h.lifecycle.ensure(), 'the next ask tries again');
  assert.equal(h.lifecycle.failure(), undefined);
});

test('an open in flight is visible, so nothing has to guess whether a socket is coming', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'wa-lifecycle-'));
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const sockets = createSocketFactory();
  const lifecycle = createWhatsAppLifecycle({
    create: async () => {
      await gate;
      return new WhatsAppConnection({ authDir: dir, socketFactory: sockets.factory, createAuthStore: () => fakeAuthStore(), waVersion: VERSION });
    },
  });
  t.after(async () => { await lifecycle.close(); });

  assert.equal(lifecycle.opening(), false);
  const pending = lifecycle.open();
  assert.equal(lifecycle.opening(), true, 'the boot service and the card both asked; one open is in flight');
  release();
  await pending;
  assert.equal(lifecycle.opening(), false);
});

test('the socket\'s life is one recorded line per open, close and refusal', async (t) => {
  const lines: Array<[string, string]> = [];
  const h = harness(t, { registered: true, note: (level, line) => { lines.push([level, line]); } });

  const opened = await h.lifecycle.open();

  // What WhatsApp said about the socket it closed, in its own words: the fact no reload recovers.
  h.sockets.sockets.at(-1)!.emit('connection.update', {
    connection: 'close',
    lastDisconnect: { error: Object.assign(new Error('Connection Failure'), { statusCode: 428 }) },
  });
  await h.sockets.sockets.at(-1)!.flush();

  await h.lifecycle.close('the host stopped the whatsapp-connection service');
  assert.equal(opened.status(), 'disconnected');

  // A close nobody asked for and that no ladder can fix: the device was unlinked on the phone.
  const again = await h.lifecycle.open();
  h.sockets.sockets.at(-1)!.emit('connection.update', { connection: 'close', lastDisconnect: { error: { statusCode: 401 } } });
  await h.sockets.sockets.at(-1)!.flush();
  await h.lifecycle.close('the plugin was disposed');
  assert.equal(again.status(), 'disconnected');

  const said = lines.map(([level, line]) => `${level} ${line}`);
  assert.ok(said.some(line => line === 'info WhatsApp socket opened for a linked device'), `opening is recorded: ${said.join(' | ')}`);
  assert.ok(said.some(line => line === 'info WhatsApp socket closed: the host stopped the whatsapp-connection service'), 'the caller\'s reason is recorded');
  assert.ok(said.some(line => line.startsWith('warn WhatsApp closed the socket: Connection Failure (status 428)')), 'WhatsApp\'s own reason is recorded');
  assert.ok(said.some(line => line === 'warn WhatsApp reported this device logged out; pairing is needed again'), 'a terminal close is recorded too');
});

test('a start that is refused is written down, so a deaf source is not the only trace', async (t) => {
  const lines: string[] = [];
  const h = harness(t, { note: (_level, line) => { lines.push(line); } });
  const held = acquireWhatsAppLock(h.dir);
  try {
    await assert.rejects(h.lifecycle.open());
  } finally {
    held.release();
  }

  assert.ok(lines.some(line => /^WhatsApp socket did not open: .*already open in process \d+/.test(line)), lines.join(' | '));
});
