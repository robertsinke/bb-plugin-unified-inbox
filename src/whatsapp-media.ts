export type WhatsAppMedia = {
  messageId: string;
  kind: 'image' | 'sticker' | 'video';
  cached: boolean;
  available: boolean;
  mime?: string;
  filename?: string;
  size?: number;
};

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
