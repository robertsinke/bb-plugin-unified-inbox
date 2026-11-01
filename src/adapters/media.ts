// One media primitive. A file is addressed one of three ways — a message slot,
// a Messages attachment slot, or a Gmail attachment name — and the request says
// which. The adapter that owns the source answers; the caller never picks a
// source by an RPC name.
import { z } from 'zod';

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
