// The plugin's own WhatsApp socket (plan D1, requirement R1).
//
// Lifted from WhatsAgent's `server/channels/whatsapp/connection.ts` with its collaborators intact —
// `socketFactory`, `createAuthStore`, `resolveWaVersion`, `reconnectDelayMs`, `maxReconnectDelayMs`,
// `onError` — and with the database-backed `getMessage` loader put back as a hook (`store.ts`
// supplies it) and the LID/identity backfill moved to the ingest, which is where identity is learned
// from the envelopes themselves. What arrives whole is the part that took the longest to get right:
// the reconnect ladder, the version probe, the `pairing-needed` event, and the rule that `loggedOut`
// is terminal rather than retried.
//
// This module owns three things and no others: when a socket exists, what it reports, and that only
// one exists per account state. It does not parse messages, store them, or decide whether a send is
// allowed — see `src/whatsapp/auth.ts` for the account state, `src/whatsapp/lock.ts` for the single
// socket, and `src/adapters/policy.ts` for sends.
import makeWASocket, {
  Browsers,
  DisconnectReason,
  proto,
  type GroupMetadata,
  type UserFacingSocketConfig,
  type WAMessage,
  type WAMessageKey,
  type WAVersion,
} from 'baileys';
import {
  accountStateSummary,
  createFileAuthStore,
  whatsAppAuthDir,
  type WhatsAppAccountState,
  type WhatsAppAuthStore,
} from './auth.ts';
import { acquireWhatsAppLock, type WhatsAppLock } from './lock.ts';
import type { WhatsAppSendSocket } from './send.ts';
import { resolveWhatsAppWebVersion } from './version.ts';

type SocketEventHandler = (...args: any[]) => void;

/**
 * Baileys logs at info level by default, and its info lines carry the registration payload — the
 * client hello, `eRegid`, `eIdent`, the session keys. The account state may not be logged (R2), so
 * the socket gets a logger that discards everything: what the plugin needs to say, it says through
 * its own events, and those carry no protocol bytes. Failures are not lost — they arrive as `error`
 * events with their message, which is the part a reader can act on.
 */
const SILENT_LOGGER = {
  level: 'silent',
  child: () => SILENT_LOGGER,
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
};

export type WhatsAppSocket = Partial<WhatsAppSendSocket> & {
  ev: { on(event: string, handler: SocketEventHandler): unknown };
  end(error?: Error): void;
  requestPairingCode?(phoneNumber: string, customPairingCode?: string): Promise<string>;
  /** Asks the phone to upload media again when the CDN refuses stale bytes. */
  updateMediaMessage?(message: WAMessage): Promise<WAMessage>;
};

/**
 * The one socket call a media download needs. Media bytes themselves are fetched from the envelope
 * the store already holds — `downloadMediaMessage` needs no socket — but an expired object is only
 * replaced by asking the owner's phone to re-upload it, so a download without this is a download
 * that fails permanently the first time WhatsApp expires anything.
 */
export type WhatsAppMediaSocket = {
  updateMediaMessage(message: WAMessage): Promise<WAMessage>;
};

export type SocketFactory = (config: UserFacingSocketConfig) => WhatsAppSocket;

/** Answers Baileys' `getMessage` asks. U2 supplies the store-backed loader; absent means "unknown". */
export type StoredMessageLoader = (key: WAMessageKey) => Promise<proto.IMessage | undefined>;

export type WhatsAppConnectionState = 'connecting' | 'connected' | 'disconnected';

export type WhatsAppConnectionEvent =
  | { type: 'connection'; state: WhatsAppConnectionState }
  | { type: 'pairing-needed'; qr: string }
  | { type: 'pairing-code'; code: string }
  /** Metadata only: the CLI's proof of ingest must not put a message body in a log. */
  | { type: 'message'; id: string; chatId: string; fromMe: boolean }
  /**
   * The socket went away without this module asking, in WhatsApp's own words and with the delay the
   * ladder waits before trying again. A close is otherwise a silent fact: the socket is gone, the
   * reads keep answering from the store, and nothing says the source has gone deaf.
   */
  | { type: 'connection-closed'; reason: string; retryMs?: number }
  | { type: 'logged-out' }
  | { type: 'error'; error: Error; fatal: boolean };

export type WhatsAppConnectionListener = (event: WhatsAppConnectionEvent) => void;

export interface WhatsAppConnectionOptions {
  authDir?: string;
  socketFactory?: SocketFactory;
  /** Rebuilds the store from the account state on disk; a re-pair must read the emptied dir. */
  createAuthStore?: (dir: string) => WhatsAppAuthStore;
  waVersion?: WAVersion;
  resolveWaVersion?: () => Promise<WAVersion>;
  /** When set, an unregistered connect asks for a pairing code as well as offering a QR. */
  pairingPhone?: string;
  reconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
  groupCacheSize?: number;
  getMessage?: StoredMessageLoader;
  /**
   * Binds an open socket to whatever consumes its events (the store's ingest). Called once per
   * socket — so once per connect, including a reconnect — and the returned function is called when
   * that socket closes. This module decides when a socket exists; what it is bound to is the
   * plugin's business, which is why this is a hook and not an import.
   */
  bindSocket?: (socket: WhatsAppSocket) => void | (() => void);
  onError?: (error: Error) => void;
}

/** WhatsApp's own words for a close, with the status code a reader can look up. Never a payload. */
function describeClose(error: unknown): string {
  if (error === undefined) return 'WhatsApp closed the socket without saying why';
  const status = disconnectStatusCode(error);
  const text = asError(error).message || 'no message';
  return status === undefined ? text : `${text} (status ${status})`;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function disconnectStatusCode(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const candidate = error as { statusCode?: number; output?: { statusCode?: number } };
  return candidate.output?.statusCode ?? candidate.statusCode;
}

/** Digits only: Baileys builds the pairing jid from the string, so a `+` or a space is a bad jid. */
export function normalizePhoneNumber(input: string): string {
  return input.replace(/\D/g, '');
}

export class GroupMetadataCache {
  readonly #entries = new Map<string, GroupMetadata>();
  readonly #maxSize: number;

  constructor(maxSize = 100) {
    this.#maxSize = maxSize;
  }

  get(jid: string): GroupMetadata | undefined {
    const value = this.#entries.get(jid);
    if (!value) return undefined;
    this.#entries.delete(jid);
    this.#entries.set(jid, value);
    return value;
  }

  set(metadata: GroupMetadata): void {
    this.#entries.delete(metadata.id);
    this.#entries.set(metadata.id, metadata);
    while (this.#entries.size > this.#maxSize) {
      const oldest = this.#entries.keys().next().value as string | undefined;
      if (!oldest) break;
      this.#entries.delete(oldest);
    }
  }
}

export class WhatsAppConnection {
  readonly #listeners = new Set<WhatsAppConnectionListener>();
  readonly #dir: string;
  readonly #socketFactory: SocketFactory;
  readonly #createAuthStore: (dir: string) => WhatsAppAuthStore;
  readonly #waVersionOption?: WAVersion;
  readonly #resolveWaVersion: () => Promise<WAVersion>;
  readonly #pairingPhone?: string;
  readonly #reconnectDelayMs: number;
  readonly #maxReconnectDelayMs: number;
  readonly #groupCache: GroupMetadataCache;
  readonly #getMessage?: StoredMessageLoader;
  readonly #bindSocket?: (socket: WhatsAppSocket) => void | (() => void);
  readonly #onError?: (error: Error) => void;

  #authStore?: WhatsAppAuthStore;
  #lock?: WhatsAppLock;
  #waVersion?: WAVersion;
  #socket?: WhatsAppSocket;
  #detachSocket?: () => void;
  #reconnectTimer?: ReturnType<typeof setTimeout>;
  #running = false;
  #reconnectAttempt = 0;
  #state: WhatsAppConnectionState = 'disconnected';

  constructor(options: WhatsAppConnectionOptions = {}) {
    this.#dir = options.authDir ?? whatsAppAuthDir();
    this.#socketFactory = options.socketFactory ?? ((config) => makeWASocket(config) as unknown as WhatsAppSocket);
    this.#createAuthStore = options.createAuthStore ?? ((dir) => createFileAuthStore(dir));
    this.#waVersionOption = options.waVersion;
    this.#resolveWaVersion = options.resolveWaVersion ?? resolveWhatsAppWebVersion;
    this.#pairingPhone = options.pairingPhone ? normalizePhoneNumber(options.pairingPhone) : undefined;
    this.#reconnectDelayMs = options.reconnectDelayMs ?? 5_000;
    this.#maxReconnectDelayMs = Math.max(this.#reconnectDelayMs, options.maxReconnectDelayMs ?? 60_000);
    this.#groupCache = new GroupMetadataCache(options.groupCacheSize);
    this.#getMessage = options.getMessage;
    this.#bindSocket = options.bindSocket;
    this.#onError = options.onError;
  }

  /** Where the account state lives and what it looks like: the mode and the count, never the bytes. */
  accountState(): WhatsAppAccountState {
    return accountStateSummary(this.#dir);
  }

  status(): WhatsAppConnectionState {
    return this.#state;
  }

  /**
   * Whether these credentials are a linked device rather than a pairing in progress: the device
   * identity WhatsApp assigned us. The file's existence cannot answer it, because pairing writes
   * `creds` before the phone has confirmed, and `creds.registered` cannot either — rc13 sets that flag
   * only on its pair-device path, so a device paired by QR can carry a live identity with the flag
   * still false (`docs/bugs/2026-11-05-a-dead-socket-was-never-reopened.md`).
   */
  registered(): boolean {
    return Boolean(this.#authStore?.state.creds.me?.id);
  }

  /**
   * Ask the open socket for eight characters instead of a QR. The answer arrives as a
   * `pairing-code` event, and a failure arrives as an `error` event: the QR path is still alive, so
   * the caller is told what went wrong rather than left on a spinner.
   */
  async requestPairingCode(phoneNumber: string): Promise<void> {
    const socket = this.#socket;
    if (!socket) {
      this.#surfaceError(new Error('The WhatsApp socket is not open, so no pairing code can be requested'), false);
      return;
    }
    await this.#requestPairingCode(socket, normalizePhoneNumber(phoneNumber));
  }

  onEvent(listener: WhatsAppConnectionListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * Take the socket lock, read the account state, connect. Throws when another process holds the
   * lock (`WhatsAppLockError`) or when the state on disk is unreadable — both are refusals, and a
   * refused start must not leave a socket behind.
   */
  async start(): Promise<void> {
    if (this.#running) return;
    this.#lock = acquireWhatsAppLock(this.#dir);
    try {
      this.#authStore = this.#createAuthStore(this.#dir);
    } catch (error) {
      this.#lock.release();
      this.#lock = undefined;
      throw error;
    }
    this.#running = true;
    this.#reconnectAttempt = 0;
    await this.#connect();
  }

  async stop(): Promise<void> {
    this.#running = false;
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = undefined;
    this.#detachSocket?.();
    this.#detachSocket = undefined;
    const socket = this.#socket;
    this.#socket = undefined;
    socket?.end(new Error('WhatsApp connection stopped'));
    this.#lock?.release();
    this.#lock = undefined;
    this.#setState('disconnected');
  }

  /** The re-upload call, handed out only while the socket is open — a media download needs it. */
  getMediaSocket(): WhatsAppMediaSocket | undefined {
    if (this.#state !== 'connected') return undefined;
    const socket = this.#socket;
    if (!socket?.updateMediaMessage) return undefined;
    return socket as WhatsAppMediaSocket;
  }

  /** The restricted send surface, handed out only while the socket is open. */
  getSendSocket(): WhatsAppSendSocket | undefined {
    if (this.#state !== 'connected') return undefined;
    const socket = this.#socket;
    if (!socket?.sendMessage || !socket.sendPresenceUpdate || !socket.readMessages) return undefined;
    return socket as WhatsAppSendSocket;
  }

  async #connect(): Promise<void> {
    if (!this.#running || !this.#authStore) return;
    this.#setState('connecting');

    try {
      if (!this.#waVersion) this.#waVersion = await this.#resolveWaVersion();
      const version = this.#waVersionOption ?? this.#waVersion;
      if (!this.#running) return;
      const socket = this.#socketFactory({
        auth: this.#authStore.state,
        // The browser tuple the build-time patch keys on: a Desktop/Mac-OS tuple is what makes the
        // server answer `syncFullHistory` (see `_tools/patch-baileys.mjs`).
        browser: Browsers.macOS('Desktop'),
        version,
        syncFullHistory: true,
        logger: SILENT_LOGGER as unknown as UserFacingSocketConfig['logger'],
        ...(this.#getMessage ? { getMessage: this.#getMessage } : {}),
        cachedGroupMetadata: async (jid) => this.#groupCache.get(jid),
      });
      this.#socket = socket;

      socket.ev.on('connection.update', (update: ConnectionUpdate) => this.#handleConnectionUpdate(update));
      socket.ev.on('creds.update', (update: Record<string, unknown>) => {
        Object.assign(this.#authStore!.state.creds, update);
        void this.#authStore!.saveCreds().catch((error) => this.#surfaceError(error, false));
      });
      socket.ev.on('groups.upsert', (groups: GroupMetadata[]) => {
        for (const group of groups) this.#groupCache.set(group);
      });
      socket.ev.on('messages.upsert', (batch: { messages?: WAMessage[] }) => {
        for (const message of batch.messages ?? []) {
          const key = message.key;
          if (!key?.id || !key.remoteJid) continue;
          this.#emit({ type: 'message', id: key.id, chatId: key.remoteJid, fromMe: key.fromMe === true });
        }
      });

      if (this.#pairingPhone && !this.#authStore.state.creds.registered) {
        void this.#requestPairingCode(socket, this.#pairingPhone);
      }

      // Bound after this module's own handlers, so what the socket reports and what it stores are
      // both listening before the first event arrives. A binding that throws must not cost us the
      // socket: the reads still work, the ingest may not.
      if (this.#bindSocket) {
        try {
          this.#detachSocket = this.#bindSocket(socket) ?? undefined;
        } catch (error) {
          this.#surfaceError(error, false);
        }
      }
    } catch (error) {
      this.#surfaceError(error, true);
      this.#scheduleReconnect();
    }
  }

  /**
   * Ask WhatsApp for eight characters instead of a QR. A failure here is not fatal: the QR path is
   * still alive, so the caller is told what went wrong rather than being left on a spinner.
   */
  async #requestPairingCode(socket: WhatsAppSocket, phoneNumber: string): Promise<void> {
    if (!socket.requestPairingCode) {
      this.#surfaceError(new Error('This WhatsApp client build cannot request a pairing code'), false);
      return;
    }
    try {
      const code = await socket.requestPairingCode(phoneNumber);
      this.#emit({ type: 'pairing-code', code });
    } catch (error) {
      this.#surfaceError(
        new Error(`Pairing code request failed: ${asError(error).message}`),
        false,
      );
    }
  }

  #handleConnectionUpdate(update: ConnectionUpdate): void {
    if (update.qr) {
      this.#reconnectAttempt = 0;
      this.#emit({ type: 'pairing-needed', qr: update.qr });
    }
    if (update.connection === 'connecting') this.#setState('connecting');
    if (update.connection === 'open') {
      this.#reconnectAttempt = 0;
      this.#setState('connected');
    }
    if (update.connection !== 'close') return;

    this.#detachSocket?.();
    this.#detachSocket = undefined;
    this.#socket = undefined;
    this.#setState('disconnected');
    // A close this module asked for — `stop()`, or the terminal path below — is not something the
    // listener needs told twice, and the ladder must not run for it.
    if (!this.#running) return;
    const closed = update.lastDisconnect?.error;
    if (disconnectStatusCode(closed) === DisconnectReason.loggedOut) {
      // Terminal — no reconnect helps. The owner must re-pair, which is why it is never automatic.
      this.#running = false;
      this.#emit({ type: 'logged-out' });
      return;
    }
    // The retry is scheduled first, so a listener that throws costs the report and not the recovery.
    const retryMs = this.#scheduleReconnect();
    this.#emit({ type: 'connection-closed', reason: describeClose(closed), ...(retryMs === undefined ? {} : { retryMs }) });
  }

  /** 5 s doubling to a 60 s ceiling: a socket blip recovers fast, a bad night does not spin. */
  #scheduleReconnect(): number | undefined {
    if (!this.#running || this.#reconnectTimer) return undefined;
    const delay = Math.min(
      this.#reconnectDelayMs * 2 ** Math.min(this.#reconnectAttempt, 10),
      this.#maxReconnectDelayMs,
    );
    this.#reconnectAttempt += 1;
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = undefined;
      void this.#connect();
    }, delay);
    return delay;
  }

  #setState(state: WhatsAppConnectionState): void {
    if (this.#state === state) return;
    this.#state = state;
    this.#emit({ type: 'connection', state });
  }

  #surfaceError(error: unknown, fatal: boolean): void {
    const normalized = asError(error);
    this.#onError?.(normalized);
    this.#emit({ type: 'error', error: normalized, fatal });
  }

  #emit(event: WhatsAppConnectionEvent): void {
    for (const listener of this.#listeners) listener(event);
  }
}

type ConnectionUpdate = {
  connection?: 'close' | 'connecting' | 'open';
  lastDisconnect?: { error?: unknown };
  qr?: string;
};
