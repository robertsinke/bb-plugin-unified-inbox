// One media primitive. A file is addressed one of three ways — a message slot,
// a Messages attachment slot, or a Gmail attachment name — and the request says
// which. The adapter that owns the source answers; the caller never picks a
// source by an RPC name.
import { z } from 'zod';

// Attachment responses retain the existing 5 MiB ceiling; image/video limits are separate.
export const ATTACHMENT_LIMIT = 5 * 1024 * 1024;
export const IMAGE_LIMIT = 6 * 1024 * 1024;
export const VIDEO_LIMIT = 30 * 1024 * 1024;

/** A bounded, renderable data URL; the frame must never render arbitrary bytes. */
export function mediaDataUrl(bytes: Uint8Array, mime: string): string {
  const type = mime.split(';')[0].trim().toLowerCase();
  if (!type.startsWith('image/') && !type.startsWith('video/')) throw new Error('Unsupported media type.');
  if (type === 'image/svg+xml') throw new Error('Unsupported media type.');
  const limit = type.startsWith('video/') ? VIDEO_LIMIT : IMAGE_LIMIT;
  if (bytes.byteLength > limit) throw new Error('This media is too large to show here.');
  return `data:${type};base64,${Buffer.from(bytes).toString('base64')}`;
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
