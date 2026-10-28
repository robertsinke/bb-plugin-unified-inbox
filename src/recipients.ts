import addressparser from 'nodemailer/lib/addressparser/index.js';

/** Display name for an inbox row. Falls back to the address when a From header has no name. */
export function mailSenderName(from: string): string {
  const first = addressparser(from, { flatten: true }).find(entry => entry.name?.trim() || entry.address?.trim());
  const name = first?.name?.trim();
  if (name) return name;
  const address = first?.address?.trim();
  if (address) return address;
  const fallback = from.trim();
  return fallback || 'Unknown sender';
}

function addresses(value: string): string[] {
  if (!value) return [];
  return addressparser(value, { flatten: true }).map(x => x.address?.trim() || '').filter(Boolean);
}

/** Derive editable reply suggestions. The caller must show them to the user. */
export function replyRecipients(input: { from: string; replyTo: string; to: string; cc: string; self: string }): { to: string; cc: string } {
  const self = input.self.toLowerCase();
  const from = addresses(input.from);
  const selfSent = from.some(a => a.toLowerCase() === self);
  const primary = selfSent ? addresses(input.to) : addresses(input.replyTo || input.from);
  const seen = new Set([self]);
  const unique = (values: string[]) => values.filter(value => {
    const key = value.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
  const to = unique(primary);
  const cc = unique([...addresses(input.to), ...addresses(input.cc)]);
  return { to: to.join(', '), cc: cc.join(', ') };
}
