// Who holds the plugin's one socket, and for how long (plan U7, requirements R1, R6).
//
// Three facts live here because they are one decision:
//   - one socket per account state. This module is the only place that creates, hands out and stops
//     it; `./lock.ts` makes the invariant true across processes, this keeps it true inside one;
//   - it opens on first use, never at import. A stranger has no account, and 7.9 MB of client plus a
//     decrypt of the device identity is not plugin start's job;
//   - a start that fails is a fact somebody can draw. Files on disk say an account exists; they never
//     say a socket is up. So a refusal is kept here until an open succeeds, and the pairing card reads
//     it instead of inferring `connected` from the credential files — the one lie this module exists
//     to stop.
//
// The idle rule is deliberately narrow. Only a socket opened for a pairing that never became a linked
// device is stopped for being idle: a QR nobody scanned is a held lock file, a reconnect ladder and 7.9
// MB spent on nothing. A linked socket is the receipt path — the reason this is an inbox and not a
// reader of what happened to be stored last time — so a timer must never close it, or the source goes
// deaf while every read still succeeds.
//
// A stopped socket is not a broken source. `close()` is the host's dispose, the boot service's abort
// path and the owner's unpair, and each leaves a linked account that can be opened again; so a caller
// that needs a socket has `ensure()` rather than a `current()` and a shrug. Reading `current()` and
// giving up is how a recoverable state became a source that silently answered nothing.
import type { WhatsAppConnection } from './connection.ts';

/** Long enough for a distracted scan, short of leaving a pairing socket open all night. */
export const PAIRING_IDLE_MS = 10 * 60_000;

export interface WhatsAppLifecycleDeps {
  /** Builds one connection; the import of Baileys is the caller's, so a start pays for it. */
  create(): WhatsAppConnection | Promise<WhatsAppConnection>;
  /** How long a socket opened for a pairing waits before it is stopped for being idle. */
  idleMs?: number;
  /**
   * One line per socket opened, closed or refused, and per close WhatsApp reported. Words only: never
   * the account state, never a message body. This is the only record of a socket's life, so a repeat
   * of a source that went deaf can be read back instead of guessed at.
   */
  note?: (level: 'info' | 'warn', line: string) => void;
}

export interface WhatsAppLifecycle {
  /** The open socket, if there is one. Never opens anything: a read may call this on every tick. */
  current(): WhatsAppConnection | undefined;
  /** Opens, or hands back the one already open. Throws when the socket will not start. */
  open(): Promise<WhatsAppConnection>;
  /**
   * The socket for a call that needs a live one: `open()` for a caller that cannot throw. A linked
   * account is reopened on demand; a refusal is kept in `failure()` and answered with `undefined`.
   */
  ensure(): Promise<WhatsAppConnection | undefined>;
  /** Whether an open is in flight right now — the boot service's, or a caller's. */
  opening(): boolean;
  /** Stops and forgets the socket and anything a failed start said. Idempotent. */
  close(reason?: string): Promise<void>;
  /** What the last refused start said, until an open succeeds or the socket is closed. */
  failure(): string | undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createWhatsAppLifecycle(deps: WhatsAppLifecycleDeps): WhatsAppLifecycle {
  const idleMs = deps.idleMs ?? PAIRING_IDLE_MS;
  let connection: WhatsAppConnection | undefined;
  let opening: Promise<WhatsAppConnection> | undefined;
  let failure: string | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;

  function note(level: 'info' | 'warn', line: string): void {
    deps.note?.(level, line);
  }

  function clearIdle(): void {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = undefined;
  }

  async function open(): Promise<WhatsAppConnection> {
    if (connection) return connection;
    // Two callers ask at once — the boot service when an account exists, and the card when a stranger
    // scans — and both must end at the same socket.
    opening ??= (async () => {
      const opened = await startOne();
      connection = opened;
      failure = undefined;
      watch(opened);
      armIdle(opened);
      // Only that a socket exists: whether it reached WhatsApp is the socket's own event, and the
      // credentials of a linked device are already registered before the handshake finishes.
      note('info', 'WhatsApp socket opened');
      return opened;
    })().finally(() => { opening = undefined; });
    return opening;
  }

  /** `open()` for a caller that cannot throw: a media read or a send reports the refusal instead. */
  async function ensure(): Promise<WhatsAppConnection | undefined> {
    try {
      return await open();
    } catch {
      return undefined;
    }
  }

  /**
   * What the socket says about itself while this module holds it. A close WhatsApp reported is the
   * one fact nobody can recover afterwards — the ladder will try again, and the reason is what says
   * whether waiting is worth it.
   */
  function watch(opened: WhatsAppConnection): void {
    opened.onEvent(event => {
      if (event.type === 'connection' && event.state === 'connected') {
        note('info', opened.registered()
          ? 'WhatsApp socket is connected as a linked device'
          : 'WhatsApp socket is connected, waiting for a pairing QR');
      }
      if (event.type === 'logged-out') {
        note('warn', 'WhatsApp reported this device logged out; pairing is needed again');
      }
      if (event.type === 'connection-closed') {
        note('warn', `WhatsApp closed the socket: ${event.reason}`
          + (event.retryMs === undefined ? '; not reopening' : `; reopening in ${Math.round(event.retryMs / 1000)} s`));
      }
    });
  }

  /** One attempt, with the refusal kept where the card can read it. */
  async function startOne(): Promise<WhatsAppConnection> {
    let opened: WhatsAppConnection | undefined;
    try {
      opened = await deps.create();
      await opened.start();
      return opened;
    } catch (error) {
      // A refusal — another process holds the lock, or the state will not decrypt, or the client will
      // not load — leaves no socket, so the next ask tries again instead of handing out a connection
      // that never started.
      await opened?.stop();
      failure = messageOf(error);
      note('warn', `WhatsApp socket did not open: ${failure}`);
      throw error;
    }
  }

  /** A socket opened for a QR is stopped once the window passes, unless it became a linked device. */
  function armIdle(opened: WhatsAppConnection): void {
    clearIdle();
    if (opened.registered()) return;
    const timer = setTimeout(() => {
      idleTimer = undefined;
      // Pairing completes while a socket is open, and the same socket is then the receipt path.
      if (connection !== opened || opened.registered()) return;
      void close('nobody scanned the pairing QR, so the socket was stopped');
    }, idleMs);
    // An idle timer must not be the reason a process stays alive.
    timer.unref?.();
    idleTimer = timer;
  }

  async function close(reason = 'the plugin asked for it'): Promise<void> {
    clearIdle();
    const closing = connection;
    connection = undefined;
    failure = undefined;
    if (!closing) return;
    // Which caller closed the socket is the question a dead source leaves behind, so the reason is
    // written before the socket is stopped: `stop()` itself says nothing to anyone.
    note('info', `WhatsApp socket closed: ${reason}`);
    await closing.stop();
  }

  return {
    current: () => connection,
    open,
    ensure,
    opening: () => opening !== undefined,
    close,
    failure: () => failure,
  };
}
