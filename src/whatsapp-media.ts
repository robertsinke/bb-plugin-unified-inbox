import { MEDIA_KINDS, type MediaKind } from './adapters/media.ts';

export type WhatsAppMedia = {
  messageId: string;
  kind: MediaKind;
  cached: boolean;
  available: boolean;
  mime?: string;
  filename?: string;
  size?: number;
};

/** The stored row, as far as its media state is concerned. */
export type WhatsAppMediaRow = {
  id: string;
  type: string;
  media_ref?: string | null;
  media_state?: string | null;
  media_error?: string | null;
};

/**
 * A document's own facts — name, size, type. No column holds them, so the reader that can unpack the
 * envelope (`src/whatsapp/media.ts`, which already unpacks one to download it) supplies them and this
 * module only merges them in.
 */
export type WhatsAppDocumentFacts = { filename?: string; size?: number; mime?: string };

/** The types the inbox draws as media. Audio is not one of them yet: it has no player. */
const RENDERED_MEDIA = new Set<string>(MEDIA_KINDS);

/**
 * The media facts the inbox renders for one stored message: images, stickers, videos and documents,
 * and whether the bytes are cached. Nothing here is inferred — `media_state` and `media_error` are
 * what the downloader persisted, and `unavailable` is terminal (WhatsApp-side expiry; see
 * docs/bugs/2026-11-04-media-download-failure-is-not-temporary.md), while a transient failure may be
 * retried on a later open.
 */
export function whatsAppMedia(row: WhatsAppMediaRow, document?: WhatsAppDocumentFacts): WhatsAppMedia | undefined {
  if (!RENDERED_MEDIA.has(row.type)) return undefined;
  if (!row.id) return undefined;
  const facts: WhatsAppMedia = {
    messageId: row.id,
    kind: row.type as WhatsAppMedia['kind'],
    cached: Boolean(row.media_ref) && row.media_state === 'ready',
    available: row.media_error !== 'unavailable',
  };
  return row.type === 'document' ? { ...facts, ...document } : facts;
}
