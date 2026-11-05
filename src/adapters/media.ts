// One media primitive. A file is addressed one of three ways — a message slot,
// a Messages attachment slot, or a Gmail attachment name — and the request says
// which. The adapter that owns the source answers; the caller never picks a
// source by an RPC name.
import { z } from 'zod';

// A file the panel hands to the browser inline keeps its 5 MiB ceiling; image/video limits are separate.
export const ATTACHMENT_LIMIT = 5 * 1024 * 1024;
// What may land in the owner's Downloads folder instead (`../media-save.ts`). A sender chooses its size,
// so there is still a bound — but it exists to stop a runaway download, not to decide what the owner
// can receive.
export const SAVE_LIMIT = 100 * 1024 * 1024;
export const IMAGE_LIMIT = 6 * 1024 * 1024;
export const VIDEO_LIMIT = 30 * 1024 * 1024;
/**
 * A voice note is played whole, so its ceiling is what one data URL may carry — not what a stream may.
 * Measured from the live account's stored envelopes on 2026-11-05: 7 voice notes, 5,184 B … 175,401 B,
 * 2 … 69 s (≈2.5 kB/s), every one `audio/ogg; codecs=opus`. 4 MiB is 23× the largest of those and
 * ≈27 minutes at the same rate: a bound for what WhatsApp will record, not only for what it did.
 */
export const AUDIO_LIMIT = 4 * 1024 * 1024;

/**
 * The kinds a message may carry as media. One list: the message shape, the RPC schema and the panel
 * each used to spell it out, and a kind added to one of them was a hole in the other two.
 */
export const MEDIA_KINDS = ['image', 'sticker', 'video', 'audio', 'document'] as const;

export type MediaKind = (typeof MEDIA_KINDS)[number];

/** A bounded, renderable data URL; the frame must never render arbitrary bytes. */
export function mediaDataUrl(bytes: Uint8Array, mime: string): string {
  const type = mime.split(';')[0].trim().toLowerCase();
  const family = type.slice(0, type.indexOf('/'));
  if (family !== 'image' && family !== 'video' && family !== 'audio') throw new Error('Unsupported media type.');
  // An XML document is not a picture, a video or a sound: `image/svg+xml` is the trick, and any other
  // spelling of it that reached a media slot is refused the same way.
  if (type.endsWith('xml')) throw new Error('Unsupported media type.');
  const limit = family === 'video' ? VIDEO_LIMIT : family === 'audio' ? AUDIO_LIMIT : IMAGE_LIMIT;
  if (bytes.byteLength > limit) throw new Error('This media is too large to show here.');
  return `data:${type};base64,${Buffer.from(bytes).toString('base64')}`;
}

/** A declared type is passed on only when it is a type; anything else is an unknown file. */
const MIME_PATTERN = /^[\w.+-]+\/[\w.+-]+$/;

/** The declared type when it is a type, and an unknown file when it is not: one rule for every file. */
export function attachmentMime(declared?: string): string {
  return declared && MIME_PATTERN.test(declared.trim()) ? declared.trim() : 'application/octet-stream';
}

/**
 * A file the panel saves rather than draws: the bytes behind a data URL, the type to save them as,
 * and the name to save them under. One type rule for both sources that serve files — Gmail attachments
 * and WhatsApp documents — so a file cannot arrive through the looser of two paths.
 *
 * Above this ceiling the bytes are not refused: `../media-save.ts` writes them to the owner's Downloads
 * folder instead. This function stays free of the disk because the panel bundle imports this module.
 */
export function attachmentPayload(
  bytes: Uint8Array,
  options: { mime?: string; filename: string },
): { dataUrl: string; mime: string; filename: string; size: number } {
  if (bytes.byteLength > ATTACHMENT_LIMIT) throw new Error('This attachment is too large to open here.');
  const mime = attachmentMime(options.mime);
  return {
    dataUrl: `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`,
    mime,
    filename: options.filename,
    size: bytes.byteLength,
  };
}

/** A media slot on one message, indexed from the first attachment. */
export const messageMediaRequestSchema = z.object({
  kind: z.literal('message'),
  id: z.string().min(1).max(512),
  index: z.number().int().min(0).max(99).default(0),
}).strict();

/** A Messages attachment slot: index-addressed inside its conversation. */
export const imsgMediaRequestSchema = z.object({
  kind: z.literal('imsg'),
  chatId: z.string().min(1).max(512),
  messageId: z.string().min(1).max(512),
  index: z.number().int().min(0).max(99),
}).strict();

/** A Gmail attachment, addressed by the message id and the filename the row carries. */
export const attachmentMediaRequestSchema = z.object({
  kind: z.literal('attachment'),
  id: z.string().min(1).max(512),
  filename: z.string().min(1).max(255),
}).strict();

export const mediaRequestSchema = z.discriminatedUnion('kind', [
  messageMediaRequestSchema,
  imsgMediaRequestSchema,
  attachmentMediaRequestSchema,
]);

export type MediaRequest =
  | z.infer<typeof messageMediaRequestSchema>
  | z.infer<typeof imsgMediaRequestSchema>
  | z.infer<typeof attachmentMediaRequestSchema>;
