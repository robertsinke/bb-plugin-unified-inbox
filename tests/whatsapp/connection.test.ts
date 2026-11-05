// U1 — the socket's own behaviour with no network: the reconnect ladder, the terminal logged-out,
// and the fact that a received message is reported as metadata only.
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { WhatsAppConnection } from '../../src/whatsapp/connection.ts';
import { createSocketFactory, fakeAuthStore } from './fake-socket.ts';

const VERSION = [2, 3000, 1043856522] as [number, number, number];

async function connectionUnderTest(t: import('node:test').TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'wa-connection-'));
  const sockets = createSocketFactory();
  const events: Array<Record<string, unknown>> = [];
  const connection = new WhatsAppConnection({
    authDir: dir,
    socketFactory: sockets.factory,
    createAuthStore: () => fakeAuthStore(),
    waVersion: VERSION,
  });
  connection.onEvent((event) => events.push(event));
  t.after(async () => {
    await connection.stop();
    t.mock.timers.reset();
  });
  return { connection, sockets, events };
}

function closeAttempt(fake: { emit(event: string, payload: unknown): void }, statusCode = 503) {
  fake.emit('connection.update', { connection: 'close', lastDisconnect: { error: { statusCode } } });
}

test('the reconnect ladder doubles from 5 s and stops at the 60 s ceiling', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { connection, sockets } = await connectionUnderTest(t);
  await connection.start();
  assert.equal(sockets.configs.length, 1);

  // 5 s, 10 s, 20 s, 40 s, then the 60 s ceiling twice: each close schedules the next attempt at
  // twice the previous delay, and the ceiling is a real cap rather than another doubling.
  let attempts = 1;
  for (const delay of [5_000, 10_000, 20_000, 40_000, 60_000, 60_000]) {
    closeAttempt(sockets.sockets.at(-1)!);
    t.mock.timers.tick(delay - 1);
    await sockets.sockets.at(-1)!.flush();
    assert.equal(sockets.configs.length, attempts, `still ${attempts} attempt(s) ${delay - 1} ms after close`);
    t.mock.timers.tick(1);
    await sockets.sockets.at(-1)!.flush();
    attempts += 1;
    assert.equal(sockets.configs.length, attempts, `attempt ${attempts} fires ${delay} ms after close`);
  }
});

test('a loggedOut close is terminal: no ladder, and the listener is told', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { connection, sockets, events } = await connectionUnderTest(t);
  await connection.start();

  closeAttempt(sockets.sockets.at(-1)!, 401);
  assert.deepEqual(events.at(-1), { type: 'logged-out' });

  t.mock.timers.tick(10 * 60_000);
  await sockets.sockets.at(-1)!.flush();
  assert.equal(sockets.configs.length, 1, 'a logged-out device is never retried');
  assert.equal(connection.status(), 'disconnected');
});

test('an open socket reports connected, and a received message is reported without its body', async (t) => {
  const { connection, sockets, events } = await connectionUnderTest(t);
  await connection.start();
  const fake = sockets.sockets.at(-1)!;

  fake.emit('connection.update', { connection: 'open' });
  assert.equal(connection.status(), 'connected');
  assert.equal(connection.getSendSocket(), undefined, 'a fake with no send methods is not a send socket');

  fake.emit('messages.upsert', {
    type: 'notify',
    messages: [{ key: { id: 'ABC123', remoteJid: '31612345678@s.whatsapp.net', fromMe: false }, message: { conversation: 'hello' } }],
  });
  assert.deepEqual(events.at(-1), {
    type: 'message',
    id: 'ABC123',
    chatId: '31612345678@s.whatsapp.net',
    fromMe: false,
  });
  assert.equal(JSON.stringify(events).includes('hello'), false, 'no message body reaches a listener');
});

test('the resolved version and the desktop browser tuple reach the socket', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'wa-connection-'));
  const sockets = createSocketFactory();
  let probes = 0;
  const connection = new WhatsAppConnection({
    authDir: dir,
    socketFactory: sockets.factory,
    createAuthStore: () => fakeAuthStore(),
    resolveWaVersion: async () => {
      probes += 1;
      return VERSION;
    },
  });
  t.after(async () => {
    await connection.stop();
  });
  await connection.start();
  await connection.stop();
  await connection.start();

  assert.equal(sockets.configs[0].version, VERSION);
  assert.equal(sockets.configs[0].syncFullHistory, true);
  // The pairing the build-time patch keys on: a Desktop/Mac-OS tuple is what makes the server honour
  // `syncFullHistory` (see `_tools/patch-baileys.mjs`).
  assert.equal(sockets.configs[0].browser?.[0], 'Mac OS');
  assert.equal(sockets.configs[0].browser?.[1], 'Desktop');
  // One probe per connection, not per reconnect: the version is resolved once and reused.
  assert.equal(probes, 1);
});
