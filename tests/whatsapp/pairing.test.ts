// U4 — pairing as a state machine, driven by a real connection's own events and a fake socket.
//
// This is the integration test the panel's card rests on: a real `WhatsAppConnection` over a fake
// socket (so nothing pairs, nothing dials, no device slot is spent) and the pairing module watching
// it. What is pinned here is the part beyond the happy path: a QR older than its expiry is not
// offered, each `pairing-needed` replaces the payload and the deadline rather than appending,
// `logged-out` is a re-pair and not a retry, a linked device is never replaced by asking, and an
// unpaired source never turns into an error.
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { rpcContract } from '../../src/rpc-contract.ts';
import { WhatsAppConnection } from '../../src/whatsapp/connection.ts';
import { createWhatsAppPairing } from '../../src/whatsapp/pairing.ts';
import { createSocketFactory, fakeAuthStore } from './fake-socket.ts';

const VERSION = [2, 3000, 1043856522] as [number, number, number];
const QR_ONE = '2@abcdefghijklmnop,0123456789abcdef+QR+one==';
const QR_TWO = '2@abcdefghijklmnop,0123456789abcdef+QR+two==';
const NOW = 1_000_000;

/**
 * One pairing module over one real connection: every dependency is the plugin's, except the socket
 * (a fake), the auth store (a shape, so no device identity is written) and the clock. `close` stops
 * the connection the way the host does, so unpairing exercises the stop-before-clear order.
 */
/**
 * The module asks `whatsAppAuthDir()` whether an account exists, and `unpair` clears whatever that
 * answers. Both are pointed at a fresh temp directory: a real pairing on the machine must be neither
 * seen as "already linked" nor deleted by a test run.
 */
function isolateAccountState(t: import('node:test').TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'wa-pairing-auth-'));
  const previous = process.env.UNIFIED_INBOX_WHATSAPP_AUTH;
  process.env.UNIFIED_INBOX_WHATSAPP_AUTH = dir;
  t.after(() => {
    if (previous === undefined) delete process.env.UNIFIED_INBOX_WHATSAPP_AUTH;
    else process.env.UNIFIED_INBOX_WHATSAPP_AUTH = previous;
  });
  return dir;
}

async function fixture(t: import('node:test').TestContext, options: { registered?: boolean } = {}) {
  const dir = isolateAccountState(t);
  let clock = NOW;
  const sockets = createSocketFactory();
  let connection: WhatsAppConnection | undefined;

  const open = async (): Promise<WhatsAppConnection> => {
    connection ??= new WhatsAppConnection({
      authDir: dir,
      socketFactory: sockets.factory,
      createAuthStore: () => fakeAuthStore({ registered: options.registered === true }),
      waVersion: VERSION,
    });
    await connection.start();
    return connection;
  };

  t.after(async () => {
    await connection?.stop();
    connection = undefined;
  });

  const pairing = createWhatsAppPairing({
    open,
    current: () => connection,
    close: async () => {
      const stopping = connection;
      connection = undefined;
      await stopping?.stop();
    },
    now: () => clock,
  });

  return {
    pairing,
    sockets,
    open,
    /** The socket the latest attempt built: the one the server would be talking to. */
    socket: () => sockets.sockets.at(-1)!,
    tick: (ms: number) => { clock += ms; },
    /** A socket stopped by someone else — the lifecycle's idle stop, or a host that closed it. */
    forget: () => { connection = undefined; },
  };
}

test('unpaired is a state: no socket, no error, and the wire carries it', async (t) => {
  const f = await fixture(t);
  const answer = await f.pairing.handle({});
  assert.deepEqual(answer, { state: 'unpaired' }, 'a source that was never paired says so, and nothing else');
  assert.equal(f.sockets.configs.length, 0, 'reading a state opens no socket');
  assert.equal(rpcContract.whatsapp_pairing.output.safeParse(answer).success, true);
  assert.equal(rpcContract.whatsapp_pairing.output.safeParse({ state: 'error' }).success, false, 'and the vocabulary is closed');
});

test('pairing puts a QR on the card, and each later event replaces payload and deadline', async (t) => {
  const f = await fixture(t);
  await f.pairing.handle({ op: 'pair' });
  assert.deepEqual(f.pairing.state(), { state: 'connecting' }, 'the socket is open and WhatsApp has not answered yet');

  f.socket().emit('connection.update', { qr: QR_ONE });
  assert.deepEqual(f.pairing.state(), { state: 'qr', qr: QR_ONE, expiresAt: NOW + 60_000 }, 'the first payload lives a minute');

  f.socket().emit('connection.update', { qr: QR_TWO });
  const rotated = f.pairing.state();
  assert.equal(rotated.qr, QR_TWO, 'the newer payload wins; the old one is not kept anywhere');
  assert.equal(rotated.expiresAt, NOW + 20_000, 'and its deadline is the rotation window, not the first one');
  assert.equal(rpcContract.whatsapp_pairing.output.safeParse(rotated).success, true);
});

test('a payload past its expiry is never offered again', async (t) => {
  const f = await fixture(t);
  await f.pairing.handle({ op: 'pair' });
  f.socket().emit('connection.update', { qr: QR_ONE });

  f.tick(60_000);
  const expired = f.pairing.state();
  assert.equal(expired.state, 'connecting', 'a dead code is a socket waiting, not a QR on screen');
  assert.equal(expired.qr, undefined);
  assert.equal(expired.expiresAt, undefined);

  f.tick(1);
  assert.equal(f.pairing.state().qr, undefined, 'and reading it does not extend the deadline');
});

test('a pairing code is the fallback: by number, shown instead of the QR, and dropped with the socket', async (t) => {
  const f = await fixture(t);
  await f.pairing.handle({ op: 'pair' });
  f.socket().emit('connection.update', { qr: QR_ONE });

  const code = 'ABCD-1234';
  const socket = f.socket().socket as unknown as { requestPairingCode?: (phone: string) => Promise<string> };
  const asked: string[] = [];
  socket.requestPairingCode = async (phone: string) => { asked.push(phone); return code; };

  const shown = await f.pairing.handle({ op: 'request-code', phone: '+31 6 1234 5678' });
  assert.deepEqual(asked, ['31612345678'], 'WhatsApp is handed digits, because a plus sign builds a bad jid');
  assert.deepEqual(shown, { state: 'code', code }, 'the code is what the phone waits for, so it replaces the QR');
  assert.equal(rpcContract.whatsapp_pairing.output.safeParse(shown).success, true);

  // A code belongs to the socket that asked for it: a close takes it with it.
  f.socket().emit('connection.update', { connection: 'close', lastDisconnect: { error: { statusCode: 503 } } });
  assert.notEqual(f.pairing.state().state, 'code', 'a code from a closed socket is not offered');
});

test('requesting a code without a usable number says so, and asks WhatsApp for nothing', async (t) => {
  const f = await fixture(t);
  const answer = await f.pairing.handle({ op: 'request-code', phone: '12' });
  assert.equal(answer.state, 'unpaired');
  assert.match(answer.message ?? '', /international phone number/);
  assert.equal(f.sockets.configs.length, 0, 'a bad number opens no socket and burns no pairing request');
});

test('logged-out is terminal and offers a re-pair, never a retry', async (t) => {
  const f = await fixture(t);
  await f.pairing.handle({ op: 'pair' });
  f.socket().emit('connection.update', { qr: QR_ONE });

  f.socket().emit('connection.update', { connection: 'close', lastDisconnect: { error: { statusCode: 401 } } });
  assert.deepEqual(f.pairing.state(), { state: 'logged-out' }, 'the card says the device is gone');

  f.tick(10 * 60_000);
  assert.deepEqual(f.pairing.state(), { state: 'logged-out' }, 'nothing the module does brings it back');
  assert.equal(f.sockets.configs.length, 1, 'no reconnect was attempted');
});

test('pairing a linked device is refused, and the refusal leaves the socket alone', async (t) => {
  const f = await fixture(t, { registered: true });
  await f.pairing.handle({ op: 'pair' });
  f.socket().emit('connection.update', { connection: 'open' });
  assert.deepEqual(f.pairing.state(), { state: 'connected' }, 'a registered device is connected, not awaiting a code');

  const refused = await f.pairing.handle({ op: 'pair' });
  assert.equal(refused.message, 'This source is already paired. Unpair it first to link a different phone.');
  assert.equal(f.sockets.configs.length, 1, 'a refusal opens nothing and replaces nothing');
});

test('unpair stops the socket and leaves the card unpaired', async (t) => {
  const f = await fixture(t);
  await f.pairing.handle({ op: 'pair' });
  const connection = await f.open();

  const answer = await f.pairing.handle({ op: 'unpair' });
  assert.deepEqual(answer, { state: 'unpaired' });
  assert.equal(connection.status(), 'disconnected', 'the socket is stopped, so its lock is released');
  assert.equal((await f.pairing.handle({})).state, 'unpaired');
});

test('a socket that will not open is a sentence on the card, not a thrown call', async (t) => {
  isolateAccountState(t);
  const broken = createWhatsAppPairing({
    open: async () => { throw new Error('WhatsApp socket lock could not be taken'); },
    now: () => NOW,
  });
  const answer = await broken.handle({ op: 'pair' });
  assert.equal(answer.state, 'unpaired', 'the state stays readable');
  assert.match(answer.message ?? '', /lock could not be taken/, 'and it is whatever the socket said');
});

test('a socket the host opened on its own is adopted on the first read', async (t) => {
  // The boot service opens the socket when an account state exists, and the card may be the first
  // thing to ask about it: it follows that socket from then on rather than claiming nothing happens.
  const f = await fixture(t);
  await f.open();
  assert.equal(f.pairing.state().state, 'connecting', 'the host socket is the one being reported');
  f.socket().emit('connection.update', { qr: QR_ONE });
  assert.equal(f.pairing.state().qr, QR_ONE, 'and its next payload is on the card');
});

test('a socket stopped elsewhere is a card with no code, not a spinner that never ends', async (t) => {
  const f = await fixture(t);
  await f.pairing.handle({ op: 'pair' });
  f.socket().emit('connection.update', { qr: QR_ONE });
  assert.equal(f.pairing.state().state, 'qr');

  // The lifecycle's idle stop closes the socket without telling this module; the payload belonged to
  // that socket, so an expired-socket QR must not outlive it on screen.
  f.forget();
  assert.deepEqual(f.pairing.state(), { state: 'unpaired' });
});

test('reconnect opens a socket for a linked account and replaces nothing', async (t) => {
  const f = await fixture(t, { registered: true });
  const answer = await f.pairing.handle({ op: 'reconnect' });

  assert.equal(answer.state, 'connecting', 'the socket the boot path could not open is open now');
  assert.equal(f.sockets.configs.length, 1, 'one socket, asked for once');
  assert.notEqual(answer.message, 'This source is already paired. Unpair it first to link a different phone.', 'a retry is not a re-pair');
});
