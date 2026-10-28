/** WhatsApp's own group-list convention: "Sender: last message". */
export function groupPreview(preview: string, fromMe: boolean, sender: string): string {
  if (!preview.trim()) return preview;
  const name = fromMe ? 'You' : sender.trim();
  return name ? `${name}: ${preview}` : preview;
}
