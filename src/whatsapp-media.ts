export type WhatsAppMedia = {
  messageId: string;
  kind: 'image' | 'sticker' | 'video';
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
 * The media facts the inbox renders for one stored message: images, stickers and videos only, and
 * whether its bytes are cached. Nothing here is inferred — `media_state` and `media_error` are what
 * the downloader persisted, and `unavailable` is terminal (WhatsApp-side expiry; see
 * docs/bugs/2026-11-04-media-download-failure-is-not-temporary.md), while a transient failure may be
 * retried on a later open.
 */
export function whatsAppMedia(row: WhatsAppMediaRow): WhatsAppMedia | undefined {
  if (row.type !== 'image' && row.type !== 'sticker' && row.type !== 'video') return undefined;
  if (!row.id) return undefined;
  return {
    messageId: row.id,
    kind: row.type,
    cached: Boolean(row.media_ref) && row.media_state === 'ready',
    available: row.media_error !== 'unavailable',
  };
}
