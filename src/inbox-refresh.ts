import { setTimeout as sleep } from 'node:timers/promises';
import type { Account, SyncResult } from './adapters/types.ts';

export interface SourceFreshness {
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  lastError: string | null;
  cacheFallback: boolean;
}

export const unknownFreshness = (): SourceFreshness => ({ lastAttemptAt: null, lastSuccessAt: null, lastError: null, cacheFallback: false });

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

/** Host-owned lifetime; failures back off near the source's own cadence, success restores it. */
export async function runInboxRefresh(
  refresh: () => Promise<unknown>, intervalMs: number, signal: AbortSignal,
  wait: (ms: number, signal: AbortSignal) => Promise<unknown> = (ms, signal) => sleep(ms, undefined, { signal }),
): Promise<void> {
  let delay = intervalMs;
  while (!signal.aborted) {
    try { await refresh(); delay = intervalMs; }
    catch { delay = Math.min(delay * 2, intervalMs * FAILURE_BACKOFF_CEILING); } // refresh persisted the failure
    if (signal.aborted) return;
    try { await wait(delay, signal); }
    catch (error) { if (!signal.aborted) throw error; }
  }
}
