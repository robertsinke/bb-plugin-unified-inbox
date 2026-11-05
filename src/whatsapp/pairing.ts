// Where a WhatsApp pairing stands, and the three acts that change it (plan U4, requirements R2, R5, R8).
//
// The socket is the only thing that knows what WhatsApp offered — a QR string, eight characters, a
// terminal unlink. This module is the only writer of what the panel draws from that: it subscribes to
// one connection's events, decides what they mean, and hands the answer to the gateway unchanged.
//
// Three rules are why this is a module rather than a handler:
//   - an unpaired source is a state, never a failure. Nothing here throws, and nothing returns an
//     error line, so a stranger's first view of the source is a card and not a red sentence;
//   - a QR past its expiry is not a QR. Baileys replaces the payload on every `pairing-needed` — the
//     first lives 60 s and the rest 20 s — so each event replaces the payload *and* the deadline, and
//     an expired payload is dropped rather than offered again;
//   - pairing is deliberate. A linked device is never replaced by asking to pair; that takes an
//     explicit `unpair`, because re-pairing is the one lever in the ban exposure we can move.
//
// The account state itself is not read here. `auth.ts` owns whether an account exists and how it is
// forgotten; `connection.ts` owns the socket and says whether its credentials are registered.
import type { WhatsAppPairingRequest, WhatsAppPairingSnapshot } from '../rpc-contract.ts';
import { clearAccountState, whatsAppAccountExists, whatsAppAuthDir } from './auth.ts';
import type { WhatsAppConnection } from './connection.ts';

export interface WhatsAppPairingDeps {
  /** Opens the plugin's one socket, or hands back the one already open. */
  open: () => Promise<WhatsAppConnection>;
  /** The socket the host already has, if any: one started at boot is adopted on the first read. */
  current?: () => WhatsAppConnection | undefined;
  /** Stops the socket and releases its lock: the act before a deliberate re-pair. */
  close?: () => Promise<void>;
  now?: () => number;
  /** Baileys' own rotation: the first payload lives a minute, its replacements twenty seconds. */
  firstQrMs?: number;
  nextQrMs?: number;
}

export interface WhatsAppPairing {
  /** What the card draws. Synchronous, because the panel reads it on every tick; it starts nothing. */
  state(): WhatsAppPairingSnapshot;
  /** A read when `op` is absent, otherwise one of the three acts. */
  handle(request: WhatsAppPairingRequest): Promise<WhatsAppPairingSnapshot>;
  /** Follow one socket's events. Idempotent, and a new socket replaces the old subscription. */
  attach(connection: WhatsAppConnection): void;
}

const FIRST_QR_MS = 60_000;
const NEXT_QR_MS = 20_000;

/** A refusal, not a failure: the source is working, and the act was not the one that changes it. */
const ALREADY_LINKED = 'This source is already paired. Unpair it first to link a different phone.';
const NEEDS_PHONE = 'A full international phone number is required, for example 31612345678.';

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createWhatsAppPairing(deps: WhatsAppPairingDeps): WhatsAppPairing {
  const now = deps.now ?? (() => Date.now());
  const firstQrMs = deps.firstQrMs ?? FIRST_QR_MS;
  const nextQrMs = deps.nextQrMs ?? NEXT_QR_MS;

  let tracked: WhatsAppConnection | undefined;
  let detach: (() => void) | undefined;
  /** The live payload and when it dies; each `pairing-needed` replaces both. */
  let qr: { payload: string; expiresAt: number } | undefined;
  let qrCount = 0;
  let code: string | undefined;
  /** Set once a code was asked for, so the code stays on screen instead of a later QR replacing it. */
  let codeRequested = false;
  let loggedOut = false;
  /** What the socket said, in its own words, until something newer arrives. */
  let note: string | undefined;

  function attach(connection: WhatsAppConnection): void {
    if (tracked === connection) return;
    detach?.();
    tracked = connection;
    qr = undefined;
    qrCount = 0;
    code = undefined;
    codeRequested = false;
    loggedOut = false;
    note = undefined;
    detach = connection.onEvent((event) => {
      switch (event.type) {
        case 'pairing-needed':
          qrCount += 1;
          qr = { payload: event.qr, expiresAt: now() + (qrCount === 1 ? firstQrMs : nextQrMs) };
          note = undefined;
          break;
        case 'pairing-code':
          code = event.code;
          codeRequested = true;
          note = undefined;
          break;
        case 'connection':
          // A QR and a code belong to the socket that offered them: a closed socket invalidates both,
          // and the reconnect ladder offers a fresh payload rather than reviving this one.
          if (event.state !== 'connected') {
            qr = undefined;
            code = undefined;
            codeRequested = false;
          }
          break;
        case 'logged-out':
          // Terminal. The device is unlinked, so there is nothing to retry and the card offers a pair.
          loggedOut = true;
          qr = undefined;
          code = undefined;
          codeRequested = false;
          note = undefined;
          break;
        case 'error':
          note = messageOf(event.error);
          break;
      }
    });
  }

  /** Whether this device is linked already. The socket's own flag first, the directory second. */
  function linked(connection: WhatsAppConnection | undefined): boolean {
    if (connection) return connection.registered();
    return whatsAppAccountExists();
  }

  function state(): WhatsAppPairingSnapshot {
    // A socket the host opened on its own (the boot service) is adopted on the first read: its QR is
    // already rotating, and a card that cannot see it would offer a pairing that is in progress.
    const present = deps.current?.();
    if (present && present !== tracked) attach(present);

    if (loggedOut) return { state: 'logged-out', ...(note ? { message: note } : {}) };

    const live = qr && now() < qr.expiresAt ? qr : undefined;
    if (qr && !live) qr = undefined;

    if (tracked?.status() === 'connected') return { state: 'connected' };
    if (codeRequested && code) return { state: 'code', code, ...(note ? { message: note } : {}) };
    if (live) {
      return {
        state: 'qr',
        qr: live.payload,
        expiresAt: live.expiresAt,
        ...(note ? { message: note } : {}),
      };
    }
    if (tracked) return { state: 'connecting', ...(note ? { message: note } : {}) };
    // No socket and nothing said yet: a linked account waits for the next read, an unpaired one is
    // the card. Both are states; neither is a failure.
    return linked(undefined) ? { state: 'connected' } : { state: 'unpaired' };
  }

  async function unpair(): Promise<WhatsAppPairingSnapshot> {
    await deps.close?.();
    detach?.();
    detach = undefined;
    tracked = undefined;
    qr = undefined;
    qrCount = 0;
    code = undefined;
    codeRequested = false;
    loggedOut = false;
    note = undefined;
    if (whatsAppAccountExists()) await clearAccountState(whatsAppAuthDir());
    return state();
  }

  async function handle(request: WhatsAppPairingRequest): Promise<WhatsAppPairingSnapshot> {
    const op = request.op ?? 'state';
    if (op === 'state') return state();
    if (op === 'unpair') return unpair();
    // A number is checked before a socket exists: a wrong one costs a pairing request on WhatsApp's
    // side, and a request is the one thing this module refuses to spend on a typo.
    const phone = (request.phone ?? '').replace(/\D/g, '');
    if (op === 'request-code' && (phone.length < 7 || phone.length > 15)) return { ...state(), message: NEEDS_PHONE };
    // Replacing a linked device is never what "pair" means: it takes the explicit act above.
    if (linked(deps.current?.())) return { ...state(), message: ALREADY_LINKED };

    // The QR is the default path, so asking to pair drops a code asked for earlier rather than
    // leaving the card on characters the socket no longer expects.
    codeRequested = false;
    code = undefined;

    let connection: WhatsAppConnection;
    try {
      connection = await deps.open();
    } catch (error) {
      return { ...state(), message: messageOf(error) };
    }
    attach(connection);
    if (op === 'request-code') await connection.requestPairingCode(phone);
    return state();
  }

  return { state, handle, attach };
}
