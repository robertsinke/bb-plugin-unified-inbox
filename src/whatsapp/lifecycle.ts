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
import type { WhatsAppConnection } from './connection.ts';

/** Long enough for a distracted scan, short of leaving a pairing socket open all night. */
export const PAIRING_IDLE_MS = 10 * 60_000;

export interface WhatsAppLifecycleDeps {
  /** Builds one connection; the import of Baileys is the caller's, so a start pays for it. */
  create(): WhatsAppConnection | Promise<WhatsAppConnection>;
  /** How long a socket opened for a pairing waits before it is stopped for being idle. */
  idleMs?: number;
}

export interface WhatsAppLifecycle {
  /** The open socket, if there is one. Never opens anything: a read may call this on every tick. */
  current(): WhatsAppConnection | undefined;
  /** Opens, or hands back the one already open. Throws when the socket will not start. */
  open(): Promise<WhatsAppConnection>;
  /** Stops and forgets the socket and anything a failed start said. Idempotent. */
  close(): Promise<void>;
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
      armIdle(opened);
      return opened;
    })().finally(() => { opening = undefined; });
    return opening;
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
      void close();
    }, idleMs);
    // An idle timer must not be the reason a process stays alive.
    timer.unref?.();
    idleTimer = timer;
  }

  async function close(): Promise<void> {
    clearIdle();
    const closing = connection;
    connection = undefined;
    failure = undefined;
    await closing?.stop();
  }

  return {
    current: () => connection,
    open,
    close,
    failure: () => failure,
  };
}
