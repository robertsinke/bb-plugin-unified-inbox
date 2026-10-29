import { z } from 'zod';
import { basename } from 'node:path';
import { IMSG_IMAGE_LIMIT, isImsgImage } from './imsg-media.ts';

const chat = z.object({
  id: z.number().int().positive().safe(), name: z.string().nullish(), display_name: z.string().nullish(),
  identifier: z.string().nullish(), service: z.string().nullish(), last_message_at: z.string().nullish(),
  unread_count: z.number().int().nonnegative(),
});
const attachment = z.object({ filename: z.string().nullish(), transfer_name: z.string().nullish(), mime_type: z.string().nullish(), total_bytes: z.number().nonnegative().nullish(), missing: z.boolean().nullish() }).passthrough();
const historyMessage = z.object({
  id: z.number().int().positive().safe(), guid: z.string().nullish(), sender: z.string().nullish(), sender_name: z.string().nullish(),
  text: z.string().nullish(), created_at: z.string().nullish(), is_from_me: z.boolean().nullish(),
  edited_at: z.string().nullish(), unsent_at: z.string().nullish(), reply_to_guid: z.string().nullish(),
  attachments: z.array(attachment).max(100).nullish(), reactions: z.array(z.object({ sender: z.string().nullish(), emoji: z.string().nullish(), type: z.string().nullish(), is_from_me: z.boolean().nullish() })).nullish(),
});
function timestamp(value: string | null | undefined) {
  if (!value) return 0;
  const result = Date.parse(value);
  return Number.isFinite(result) ? result : 0;
}
export function mapImsgChats(value: unknown) {
  const result = z.object({ chats: z.array(chat).max(100) }).parse(value);
  return result.chats.map(c => ({
    account: 'imessage' as const, id: String(c.id),
    title: c.display_name || c.name || c.identifier || 'Messages conversation',
    preview: c.service || '', date: timestamp(c.last_message_at), unread: c.unread_count > 0,
  }));
}
export function mapImsgHistory(value: unknown) {
  const result = z.object({ messages: z.array(historyMessage).max(500) }).parse(value);
  return result.messages.map(m => ({
    sender: m.is_from_me ? 'You' : m.sender_name || m.sender || 'Unknown sender',
    text: m.unsent_at ? 'Message unsent' : m.text || '',
    edited: !!m.edited_at && !m.unsent_at, replyContext: !!m.reply_to_guid,
    date: timestamp(m.created_at), fromMe: m.is_from_me === true,
    messageId: m.guid || String(m.id), imsgId: String(m.id),
    imsgAttachments: (m.unsent_at ? [] : m.attachments ?? []).map((a, index) => ({
      index, name: basename((a.transfer_name || 'Attachment').replaceAll('\\', '/')).slice(0, 200) || 'Attachment',
      available: a.missing !== true && !!a.filename && isImsgImage(a.mime_type) && (a.total_bytes == null || a.total_bytes <= IMSG_IMAGE_LIMIT),
    })),
    reactions: (m.unsent_at ? [] : m.reactions ?? []).map(r => ({ sender: r.is_from_me ? 'You' : r.sender || 'Unknown sender', label: r.emoji || r.type || 'Reaction' })),
  })).sort((a, b) => a.date - b.date);
}
export function findImsgAttachment(value: unknown, messageId: string, index: number) {
  const result = z.object({ messages: z.array(historyMessage).max(500) }).parse(value);
  const message = result.messages.find(m => String(m.id) === messageId);
  const found = message?.attachments?.[index];
  if (!found || message?.unsent_at || found.missing === true || !found.filename || !isImsgImage(found.mime_type)) throw new Error('This attachment is unavailable.');
  return { filename: found.filename, mime: found.mime_type };
}
export function imsgChatId(id: string) {
  if (!/^[1-9]\d*$/.test(id)) throw new Error('Invalid Messages conversation');
  const value = Number(id);
  if (!Number.isSafeInteger(value)) throw new Error('Invalid Messages conversation');
  return value;
}
