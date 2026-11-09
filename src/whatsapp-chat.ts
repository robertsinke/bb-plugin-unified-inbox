import { isPollCreationType, isPollUpdateType } from './whatsapp/poll.ts';

/** WhatsApp's own group-list convention: "Sender: last message". */
export function groupPreview(preview: string, fromMe: boolean, sender: string): string {
  if (!preview.trim()) return preview;
  const name = fromMe ? 'You' : sender.trim();
  return name ? `${name}: ${preview}` : preview;
}

/** WhatsApp phone JIDs only; group and LID JIDs are not phone numbers. */
export function whatsappPhone(jid: string): string {
  const value = jid.trim();
  if (!value) return '';
  const at = value.indexOf('@');
  const domain = at >= 0 ? value.slice(at) : '';
  if (domain && domain !== '@s.whatsapp.net' && domain !== '@c.us') return '';
  const local = at >= 0 ? value.slice(0, at) : value;
  return /^\d{6,15}$/.test(local) ? `+${local}` : '';
}

/** Prefer a saved name, then a dialable phone number, then the raw JID. */
export function whatsappTitle(name: string, displayJid: string): string {
  const clean = name.trim();
  if (clean) return clean;
  return whatsappPhone(displayJid) || displayJid.trim();
}

/** A 1:1 message carries no participant; fall back to the chat's own name. */
export function whatsappSender(fromMe: boolean, senderName: string, group: boolean, chatTitle: string): string {
  if (fromMe) return 'You';
  const name = senderName.trim() || (group ? '' : chatTitle.trim());
  return name || 'Unknown';
}

/**
 * What a row shows when it has no text of its own: a picture speaks for itself, anything else names
 * its type — a call or a protocol stub is not an empty bubble.
 *
 * A document or a voice note keeps its label even though it has media, because its control does not
 * speak for it in a chat list — a document chip carries a filename, an audio player is not drawn there
 * at all. The bubble hides the label it would repeat, so `[document]` and `[audio]` are read in a chat
 * list and nowhere else.
 */
export function whatsappText(text: string, type: string, media?: { kind: string }): string {
  if (isPollCreationType(type)) return 'Poll';
  if (text.trim()) return text;
  if (media && media.kind !== 'document' && media.kind !== 'audio') return '';
  return !type || type === 'text' ? '' : `[${type}]`;
}

/** WhatsApp stub/protocol events have no readable text and only add noise. */
export function isWhatsAppNoise(type: string, text: string): boolean {
  const value = text.trim();
  return type === 'system' || type === 'protocol' || isPollUpdateType(type) || value === '[system]' || value === '[protocol]' || value === '[pollUpdate]';
}

/** Also catches previews that already include a sender prefix. */
export function isWhatsAppNoisePreview(preview: string): boolean {
  const value = preview.trim();
  return value === '[system]' || value === '[protocol]' || value === '[pollUpdate]' || /:\s*\[(system|protocol|pollUpdate)\]$/.test(value);
}
