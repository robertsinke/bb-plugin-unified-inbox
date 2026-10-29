export type AvatarSource = 'whatsapp' | 'linkedin';

/** Accept only first-party HTTPS avatar hosts; never render arbitrary provider URLs. */
export function sourceAvatarUrl(value: unknown, source: AvatarSource): string | undefined {
  if (typeof value !== 'string' || value.length > 2048) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return undefined;
    const host = url.hostname.toLowerCase();
    const allowed = source === 'whatsapp'
      ? host === 'whatsapp.net' || host.endsWith('.whatsapp.net')
      : host === 'licdn.com' || host.endsWith('.licdn.com');
    return allowed ? url.href : undefined;
  } catch {
    return undefined;
  }
}
