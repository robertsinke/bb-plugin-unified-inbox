export type AvatarSource = 'whatsapp' | 'linkedin' | 'gmail';

/**
 * Accept only first-party HTTPS avatar hosts; never render arbitrary provider URLs. Google's contact
 * photos come from the same host that serves Drive files (`/d/`) and uploaded images (`/u/`), so this
 * checks the path shape as well as the host: a profile photo is an opaque id under `/a/` (current)
 * or `/a-/` (older). Google's API has no photo-only grant (`src/gmail-faces.ts` says why), which is
 * why the source is named for the face and not for the scope.
 */
export function sourceAvatarUrl(value: unknown, source: AvatarSource): string | undefined {
  if (typeof value !== 'string' || value.length > 2048) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return undefined;
    const host = url.hostname.toLowerCase();
    const allowed = source === 'whatsapp'
      ? host === 'whatsapp.net' || host.endsWith('.whatsapp.net')
      : source === 'linkedin'
        ? host === 'licdn.com' || host.endsWith('.licdn.com')
        : host === 'lh3.googleusercontent.com' && /^\/a-?\/[\w-]/.test(url.pathname);
    return allowed ? url.href : undefined;
  } catch {
    return undefined;
  }
}
