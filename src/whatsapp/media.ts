// Media fetched on demand from the stored envelope (plan D5, unit U2 — lifted from WhatsAgent's
// `channels/whatsapp/media.ts`; U6 wires it to the panel).
//
// The bytes are fetched with the *stored* `WAMessage`, so this needs no live message object and no
// socket of its own. The lesson carried across whole is the failure classification: a missing or
// expired WhatsApp-side object is terminal and must not be retried on every open, while a network or
// decryption failure is retriable — see
// docs/bugs/2026-11-04-media-download-failure-is-not-temporary.md.
import { BufferJSON, downloadMediaMessage, extractMessageContent, type WAMessage } from 'baileys';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

/** Long-like protobuf counts (`fileLength`) and plain numbers, as one number. */
function toNumber(value: number | { toNumber(): number } | null | undefined): number | undefined {
  if (value == null) return undefined;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  const n = value.toNumber();
  return Number.isFinite(n) ? n : undefined;
}

/**
 * A document's name, size and type, read from the stored envelope — `documentMessage` is the only
 * place they exist, because no column holds them. The wrapper is not always the outermost key
 * (`documentWithCaptionMessage` is the common case), so the content is unwrapped the way ingest
 * unwraps it. An envelope that will not parse answers no facts rather than throwing at a read.
 */
export function documentFacts(raw: string | null | undefined): { filename?: string; size?: number; mime?: string } | undefined {
  if (!raw) return undefined;
  let envelope: WAMessage;
  try {
    envelope = JSON.parse(raw, BufferJSON.reviver) as WAMessage;
  } catch {
    return undefined;
  }
  const document = extractMessageContent(envelope?.message)?.documentMessage;
  if (!document) return undefined;
  const filename = document.fileName?.trim();
  const mime = document.mimetype?.trim();
  const size = toNumber(document.fileLength);
  return {
    ...(filename ? { filename } : {}),
    ...(size === undefined ? {} : { size }),
    ...(mime ? { mime } : {}),
  };
}

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

/**
 * Empty `{dataDir}/media`. Called by `clear_cache` beside the store's own clear: the rows name the
 * bytes, so dropping the rows and keeping the files would leave pictures of conversations on disk
 * that nothing can reach, which is not what clearing this plugin's cache promises.
 *
 * A file that cannot be removed is skipped rather than raised: a clear that half-succeeds has still
 * removed nothing the panel can show, and failing here would leave the caller with rows gone and an
 * error instead of the result it asked for.
 */
export function clearCachedMedia(dataDir: string): number {
  const mediaDir = join(dataDir, 'media');
  let names: string[];
  try {
    names = readdirSync(mediaDir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    try {
      rmSync(join(mediaDir, name), { force: true });
      removed += 1;
    } catch {
      // Keep going: one unremovable file must not leave the rest behind.
    }
  }
  return removed;
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
  const relativeRef = join('media', `${cacheId}${extensionForType(stored.type, documentFacts(stored.raw)?.filename)}`);
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

/**
 * Take back the bytes of one message, when what landed is a file nothing will ever show. A refusal
 * that leaves the file behind is disk the sender chose the size of, and `{dataDir}/media` is empty
 * only when the owner clears the cache by hand — so the file and the row's ref go together. A ref
 * that does not resolve inside `{dataDir}/media` is never removed.
 */
export function discardCachedMedia(store: WhatsAppStore, messageId: string, dataDir: string): boolean {
  const ref = store.getMessage(messageId)?.media_ref;
  if (!ref) return false;
  const absolutePath = resolve(dataDir, ref);
  const insideMedia = relative(resolve(join(dataDir, 'media')), absolutePath);
  if (!insideMedia || insideMedia.startsWith('..') || isAbsolute(insideMedia)) return false;
  try {
    rmSync(absolutePath, { force: true });
  } catch {
    return false;
  }
  store.forgetMediaRef(messageId);
  return true;
}

function extensionForType(type: string, filename?: string): string {
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
    case 'document':
      // A document is saved as the file it was sent as, so its own extension is the honest one; an
      // extension the serving table does not know still opens, because the envelope carries the type.
      return documentExtension(filename);
    default:
      return '.bin';
  }
}

/** A bounded suffix taken from the sender's filename: never a path, never a long one. */
function documentExtension(filename?: string): string {
  const extension = filename ? extname(filename).toLowerCase() : '';
  return /^\.[a-z0-9]{1,8}$/.test(extension) ? extension : '.bin';
}
