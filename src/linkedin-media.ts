/**
 * LinkedIn message images. A message's payload carries a signed URL on LinkedIn's
 * own CDN, and fetching it needs no session — the URL is the whole authorization.
 *
 * The URL reaches this fetch from a browser read and then from the cache, so it
 * is re-verified here rather than trusted: only LinkedIn's CDN is fetched, a
 * redirect is refused instead of followed, the answer must be an image, and it
 * carries the same 6 MiB bound every other image in the inbox carries.
 */
import type { MediaPayload } from './adapters/types.ts';
import { IMAGE_LIMIT, mediaDataUrl } from './adapters/media.ts';

const FETCH_TIMEOUT = 10_000;

/** A message photo URL, or empty: first-party LinkedIn CDN over HTTPS only. */
export function linkedinCdnUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 4096) return '';
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return '';
    return url.hostname === 'licdn.com' || url.hostname.endsWith('.licdn.com') ? url.href : '';
  } catch {
    return '';
  }
}

/** One bounded, renderable photo; the fetcher is injectable so the bounds are testable. */
export async function readLinkedInImage(value: unknown, fetcher: typeof fetch = fetch): Promise<MediaPayload> {
  const url = linkedinCdnUrl(value);
  if (!url) throw new Error('This photo is not served by LinkedIn.');
  let response: Response;
  try {
    response = await fetcher(url, { redirect: 'error', signal: AbortSignal.timeout(FETCH_TIMEOUT) });
  } catch {
    throw new Error('This photo could not be loaded from LinkedIn.');
  }
  if (!response.ok) throw new Error('This photo could not be loaded from LinkedIn.');
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > IMAGE_LIMIT) throw new Error('This photo is too large to show here.');
  const mime = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (!mime.startsWith('image/')) throw new Error('This photo is not an image.');
  return { dataUrl: mediaDataUrl(new Uint8Array(await response.arrayBuffer()), mime), mime };
}
