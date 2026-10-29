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

/** 1:1 messages carry no sender in WhatsAgent; fall back to the chat name. */
export function whatsappSender(fromMe: boolean, senderName: string, group: boolean, chatTitle: string): string {
  if (fromMe) return 'You';
  const name = senderName.trim() || (group ? '' : chatTitle.trim());
  return name || 'Unknown';
}

/** WhatsApp stub/protocol events have no readable text and only add noise. */
export function isWhatsAppNoise(type: string, text: string): boolean {
  const value = text.trim();
  return type === 'system' || type === 'protocol' || value === '[system]' || value === '[protocol]';
}

/** Also catches previews that already include a sender prefix. */
export function isWhatsAppNoisePreview(preview: string): boolean {
  const value = preview.trim();
  return value === '[system]' || value === '[protocol]' || /:\s*\[(system|protocol)\]$/.test(value);
}
