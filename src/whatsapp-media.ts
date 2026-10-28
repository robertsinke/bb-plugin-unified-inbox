export type WhatsAppMedia = {
  messageId: string;
  kind: 'image' | 'sticker' | 'video';
  cached: boolean;
  available: boolean;
  mime?: string;
  filename?: string;
  size?: number;
};

export const IMAGE_LIMIT = 6 * 1024 * 1024;
export const VIDEO_LIMIT = 30 * 1024 * 1024;

/** Keep only the media facts the inbox renders: images, stickers, and videos. */
export function whatsAppMedia(item: { id?: unknown; type?: unknown; media?: unknown }): WhatsAppMedia | undefined {
  if (item.type !== 'image' && item.type !== 'sticker' && item.type !== 'video') return undefined;
  if (typeof item.id !== 'string' || !item.id) return undefined;
  const info = item.media && typeof item.media === 'object' ? item.media as Record<string, unknown> : {};
  return {
    messageId: item.id,
    kind: item.type,
    cached: info.cached === true,
    available: info.error !== 'unavailable',
    ...(typeof info.mime === 'string' && info.mime ? { mime: info.mime } : {}),
    ...(typeof info.filename === 'string' && info.filename ? { filename: info.filename } : {}),
    ...(typeof info.size === 'number' && Number.isFinite(info.size) && info.size > 0 ? { size: info.size } : {}),
  };
}

/** A bounded, renderable data URL; the frame must never render arbitrary bytes. */
export function mediaDataUrl(bytes: Uint8Array, mime: string): string {
  const type = mime.split(';')[0].trim().toLowerCase();
  if (!type.startsWith('image/') && !type.startsWith('video/')) throw new Error('Unsupported media type.');
  if (type === 'image/svg+xml') throw new Error('Unsupported media type.');
  const limit = type.startsWith('video/') ? VIDEO_LIMIT : IMAGE_LIMIT;
  if (bytes.byteLength > limit) throw new Error('This media is too large to show here.');
  return `data:${type};base64,${Buffer.from(bytes).toString('base64')}`;
}
