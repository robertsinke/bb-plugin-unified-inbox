// WhatsAgent installations may contain older seconds-based rows as well as milliseconds.
export function whatsappTimestamp(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0;
  return value < 1e12 ? value * 1000 : value;
}
