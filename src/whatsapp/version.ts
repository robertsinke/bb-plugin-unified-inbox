// Which WhatsApp Web version this client claims to be.
//
// Baileys speaks a versioned protocol and WhatsApp rejects a stale version before it emits the
// first pairing QR, so the pinned library's bundled version is not usable on its own. Two facts,
// one decision: a runtime probe with a 10-second budget, and the last value we saw answer live.
// They live together because shipping one without the other is the "Connecting…" that never ends.
import { fetchLatestWaWebVersion, type WAVersion } from 'baileys';

/** The last live-tested value; used only when the probe is unavailable or times out. */
export const WA_WEB_VERSION_FALLBACK: WAVersion = [2, 3000, 1043856522];

/** How long the probe may take before the fallback is used. */
export const VERSION_PROBE_TIMEOUT_MS = 10_000;

export type WhatsAppVersionFetcher = () => Promise<{ version: WAVersion; error?: unknown }>;

function defaultFetcher(): ReturnType<WhatsAppVersionFetcher> {
  return fetchLatestWaWebVersion({ signal: AbortSignal.timeout(VERSION_PROBE_TIMEOUT_MS) });
}

/**
 * The version to present. Never throws: a probe that fails, times out, or answers with an error
 * resolves the fallback constant, because a wrong-but-known version pairs more often than no
 * connection attempt at all.
 */
export async function resolveWhatsAppWebVersion(
  fetchVersion: WhatsAppVersionFetcher = defaultFetcher,
): Promise<WAVersion> {
  try {
    const result = await fetchVersion();
    return result.error ? WA_WEB_VERSION_FALLBACK : result.version;
  } catch {
    return WA_WEB_VERSION_FALLBACK;
  }
}
