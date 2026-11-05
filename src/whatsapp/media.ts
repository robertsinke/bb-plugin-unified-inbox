// Media fetched on demand from the stored envelope (plan D5, unit U2 — lifted from WhatsAgent's
// `channels/whatsapp/media.ts`; U6 wires it to the panel).
//
// The bytes are fetched with the *stored* `WAMessage`, so this needs no live message object and no
// socket of its own. The lesson carried across whole is the failure classification: a missing or
// expired WhatsApp-side object is terminal and must not be retried on every open, while a network or
// decryption failure is retriable — see
// docs/bugs/2026-11-04-media-download-failure-is-not-temporary.md.
import { BufferJSON, downloadMediaMessage, type WAMessage } from 'baileys';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';
import type { MediaFailureReason, WhatsAppStore } from './store.ts';

export type MediaDownloader = (
  message: WAMessage,
  type: 'buffer',
  options: Record<string, unknown>,
  ctx?: {
    reuploadRequest: (msg: WAMessage) => Promise<WAMessage>;
    logger: { info: (...args: unknown[]) => void; error?: (...args: unknown[]) => void };
  },
) => Promise<Buffer>;

export type DownloadMediaOptions = {
  /** Where the cached bytes live: the plugin's own data directory, never the account state. */
  dataDir: string;
  /** Injected for tests; defaults to Baileys' `downloadMediaMessage`. */
  download?: MediaDownloader;
  /** Phone re-upload when the CDN refuses (404/410/412/418). */
  reuploadRequest?: (msg: WAMessage) => Promise<WAMessage>;
};

export type DownloadMediaResult = { mediaRef: string; bytes: number };

const noopLogger = { info: () => undefined, error: () => undefined };

/**
 * The plugin's data directory — `{dataDir}/media` is where cached bytes live, beside `data.db`. The
 * override exists for tests and for a second BB pointed at a scratch directory, the way
 * `whatsAppAuthDir()` has one for the account state.
 */
export function whatsAppDataDir(): string {
  return process.env.UNIFIED_INBOX_WHATSAPP_DATA || join(homedir(), '.bb/plugins/unified-inbox');
}

/**
 * The bytes behind a stored `media_ref`, or nothing when the file is gone or the ref walks out of
 * the cache directory. No reader supplies a path: the ref is what `downloadAndCacheMedia` wrote.
 */
export function readCachedMedia(dataDir: string, mediaRef: string): Uint8Array | undefined {
  const mediaDir = resolve(join(dataDir, 'media'));
  const absolutePath = resolve(dataDir, mediaRef);
  const insideMedia = relative(mediaDir, absolutePath);
  if (!insideMedia || insideMedia.startsWith('..') || isAbsolute(insideMedia)) return undefined;
  try {
    return readFileSync(absolutePath);
  } catch {
    return undefined;
  }
}

/** The type to serve a cached file as, from the extension `extensionForType` gave it. */
export function mediaMime(mediaRef: string): string | undefined {
  switch (extname(mediaRef).toLowerCase()) {
    case '.jpg':
      return 'image/jpeg';
    case '.png':
      return 'image/png';
    case '.webp':
      return 'image/webp';
    case '.mp4':
      return 'video/mp4';
    case '.ogg':
      return 'audio/ogg';
    default:
      return undefined;
  }
}

/** Raised by {@link downloadAndCacheMedia}; carries the persisted failure reason. */
export class MediaDownloadFailure extends Error {
  readonly reason: MediaFailureReason;

  constructor(reason: MediaFailureReason, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'MediaDownloadFailure';
    this.reason = reason;
    this.cause = cause;
  }
}

function statusCodeOf(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const candidate = error as { status?: number; statusCode?: number; output?: { statusCode?: number } };
  return candidate.output?.statusCode ?? candidate.statusCode ?? candidate.status;
}

/**
 * `unavailable` (terminal) vs `transient` (retriable), off a concrete Baileys signal rather than a
 * guess. Baileys maps the phone's reupload verdict onto HTTP-ish codes (`MEDIA_RETRY_STATUS_MAP`:
 * NOT_FOUND → 404, DECRYPTION_ERROR → 412, GENERAL_ERROR → 418) and throws a plain status for a CDN
 * fetch. 404/410 is the bytes being gone.
 *
 * Age is the second signal, because a status alone cannot tell "gone" from "hiccup": an expired
 * reupload comes back as 412/418/5xx rather than 404. Measured 2026-11-04 — media 9 days old
 * downloaded first try, 19 days old refused on every attempt. A connection error never says the bytes
 * are gone, so it stays retriable at any age.
 */
export const MEDIA_SERVE_WINDOW_DAYS = 14;

export function classifyMediaFailure(
  error: unknown,
  options: { messageTs?: number; now?: number } = {},
): MediaFailureReason {
  const status = statusCodeOf(error);
  if (status === 404 || status === 410) return 'unavailable';
  if (status === undefined) return 'transient';
  const { messageTs, now = Date.now() } = options;
  if (typeof messageTs !== 'number' || !Number.isFinite(messageTs)) return 'transient';
  // `wa_messages.ts` stores seconds; compare in the same unit as the window.
  const ageSeconds = now / 1000 - messageTs;
  return ageSeconds > MEDIA_SERVE_WINDOW_DAYS * 86_400 ? 'unavailable' : 'transient';
}

/**
 * Download the media of one stored message, cache the bytes under `{dataDir}/media/`, and write
 * `media_ref` on the row. The state machine is persisted at every step so no reader has to guess.
 */
export async function downloadAndCacheMedia(
  store: WhatsAppStore,
  messageId: string,
  options: DownloadMediaOptions,
): Promise<DownloadMediaResult> {
  const stored = store.getMessage(messageId);
  if (!stored) throw new Error(`Unknown message: ${messageId}`);
  if (!stored.raw) throw new Error(`Message ${messageId} has no raw envelope`);

  const envelope = JSON.parse(stored.raw, BufferJSON.reviver) as WAMessage;
  const download = options.download ?? (downloadMediaMessage as unknown as MediaDownloader);
  const ctx = options.reuploadRequest
    ? { reuploadRequest: options.reuploadRequest, logger: noopLogger }
    : undefined;

  store.setMediaState(messageId, 'downloading');

  let buffer: Buffer;
  try {
    buffer = await download(envelope, 'buffer', {}, ctx);
  } catch (error) {
    const reason = classifyMediaFailure(error, { messageTs: stored.ts });
    store.setMediaState(messageId, 'failed', reason);
    throw new MediaDownloadFailure(reason, error);
  }

  const mediaDir = join(options.dataDir, 'media');
  const cacheId = createHash('sha256').update(messageId).digest('hex');
  const relativeRef = join('media', `${cacheId}${extensionForType(stored.type)}`);
  const absolutePath = resolve(options.dataDir, relativeRef);
  // The id is the only input, but a traversal must not be reachable from a future ref-shape change.
  const relativeToMedia = relative(resolve(mediaDir), absolutePath);
  if (relativeToMedia.startsWith('..') || relativeToMedia.includes('/../')) {
    store.setMediaState(messageId, 'failed', 'transient');
    throw new MediaDownloadFailure('transient', new Error('Unsafe media cache path'));
  }

  try {
    mkdirSync(mediaDir, { recursive: true, mode: 0o700 });
    writeFileSync(absolutePath, buffer, { mode: 0o600 });
  } catch (error) {
    // Local IO — always retriable.
    store.setMediaState(messageId, 'failed', 'transient');
    throw new MediaDownloadFailure('transient', error);
  }

  store.setMediaRef(messageId, relativeRef);
  return { mediaRef: relativeRef, bytes: buffer.byteLength };
}

function extensionForType(type: string): string {
  switch (type) {
    case 'image':
      return '.jpg';
    case 'video':
    case 'ptv':
      return '.mp4';
    case 'audio':
      return '.ogg';
    case 'sticker':
      return '.webp';
    default:
      return '.bin';
  }
}
