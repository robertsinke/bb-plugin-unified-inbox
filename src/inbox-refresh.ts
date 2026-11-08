import { setTimeout as sleep } from 'node:timers/promises';
import type { Account, SyncResult } from './adapters/types.ts';

export interface SourceFreshness {
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  lastError: string | null;
  cacheFallback: boolean;
}

export const unknownFreshness = (): SourceFreshness => ({ lastAttemptAt: null, lastSuccessAt: null, lastError: null, cacheFallback: false });

const SERVICE_NAME = /^[a-zA-Z0-9_-]+$/;

/** BB accepts letters, digits, "-" and "_" in a service name. A mailbox id is not that shape. */
export function refreshServiceName(account: string): string {
  const body = SERVICE_NAME.test(account) ? account : Buffer.from(account, 'utf8').toString('hex');
  return `refresh-${body}`;
}

/** Manual and background refresh share one flight per source. Failures never advance success. */
export function createInboxRefresh(deps: {
  sync(account: Account, limit?: number): Promise<SyncResult>;
  read(account: Account): SourceFreshness;
  hasCachedRows(account: Account): boolean;
  save(account: Account, state: SourceFreshness): void;
  error(account: Account, cause: unknown): string;
  now(): number;
}) {
  const flights = new Map<Account, Promise<SyncResult>>();
  function refresh(account: Account, limit?: number): Promise<SyncResult> {
    const pending = flights.get(account);
    if (pending) return pending;
    const previous = deps.read(account);
    const attempt = { ...previous, lastAttemptAt: deps.now() };
    deps.save(account, attempt);
    const flight = Promise.resolve().then(() => deps.sync(account, limit)).then(result => {
      const updatedAt = deps.now();
      deps.save(account, { ...attempt, lastSuccessAt: updatedAt, lastError: null, cacheFallback: false });
      return { ...result, updatedAt };
    }).catch(cause => {
      const message = deps.error(account, cause);
      deps.save(account, { ...attempt, lastError: message, cacheFallback: deps.hasCachedRows(account) });
      throw new Error(message);
    }).finally(() => { flights.delete(account); });
    flights.set(account, flight);
    return flight;
  }
  return { refresh };
}

/**
 * How far a failing source may back off, in multiples of its own cadence. Consecutive failures
 * double the delay, but the delay stays near the source's poll interval rather than growing to an
 * hour: a transient cause (a locked keychain, a cold browser) outlives an hour's wait, so a source
 * that recovered ten minutes ago would still be reported as broken. Four intervals bounds the retry
 * traffic while keeping the recovery visible (3 minutes at LinkedIn's 45-second cadence).
 */
const FAILURE_BACKOFF_CEILING = 4;

/**
 * A wake tries to refresh before DNS answers. That miss retries on its own ladder, from 5 seconds
 * up to one poll, so the line clears when the network returns. The sentence is the one
 * `linkedinReadResult` throws; the codes are the ones `toProviderError` copies off `error.cause`.
 */
const NETWORK_RETRY_MS = 5_000;
const NETWORK_FAILURE = /\b(?:ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|UND_ERR_|NetworkError|Failed to fetch|fetch failed|Load failed|could not reach the network)\b/;

function networkFailure(cause: unknown): boolean {
  return NETWORK_FAILURE.test(cause instanceof Error ? cause.message : '');
}

/** Host-owned lifetime. A network miss retries within seconds; any other failure backs off near the source cadence. */
export async function runInboxRefresh(
  refresh: () => Promise<unknown>, intervalMs: number, signal: AbortSignal,
  wait: (ms: number, signal: AbortSignal) => Promise<unknown> = (ms, signal) => sleep(ms, undefined, { signal }),
): Promise<void> {
  let delay = intervalMs;
  let steady = intervalMs;
  let networkDelay = NETWORK_RETRY_MS;
  while (!signal.aborted) {
    try {
      await refresh();
      delay = intervalMs;
      steady = intervalMs;
      networkDelay = NETWORK_RETRY_MS;
    } catch (cause) {
      // The refresh already stored the failure. The two ladders stay apart, so a DNS miss
      // does not shorten an auth backoff and an auth failure does not inherit the 5-second ladder.
      if (networkFailure(cause)) {
        delay = Math.min(networkDelay, intervalMs);
        networkDelay = Math.min(networkDelay * 2, intervalMs);
      } else {
        steady = Math.min(steady * 2, intervalMs * FAILURE_BACKOFF_CEILING);
        delay = steady;
        networkDelay = NETWORK_RETRY_MS;
      }
    }
    if (signal.aborted) return;
    try { await wait(delay, signal); }
    catch (error) { if (!signal.aborted) throw error; }
  }
}
