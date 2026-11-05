/** A byte count a person can read: small files are bytes, not a rounded kilobyte. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
}

/**
 * A length a person can read, from the seconds a voice note declares: `0:07`, `1:09`, `1:02:03`. The
 * envelope answers this, so a player is labelled before any byte of it is decoded.
 */
export function formatDuration(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  const parts = [Math.floor(whole / 3600), Math.floor((whole % 3600) / 60), whole % 60];
  const shown = parts[0] > 0 ? parts : parts.slice(1);
  return shown.map((part, index) => (index === 0 ? String(part) : String(part).padStart(2, '0'))).join(':');
}
