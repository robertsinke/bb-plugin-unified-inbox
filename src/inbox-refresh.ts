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

/** Host-owned lifetime; failures back off up to one hour, success restores the source cadence. */
export async function runInboxRefresh(
  refresh: () => Promise<unknown>, intervalMs: number, signal: AbortSignal,
  wait: (ms: number, signal: AbortSignal) => Promise<unknown> = (ms, signal) => sleep(ms, undefined, { signal }),
): Promise<void> {
  let delay = intervalMs;
  while (!signal.aborted) {
    try { await refresh(); delay = intervalMs; }
    catch { delay = Math.min(delay * 2, Math.max(intervalMs, 3_600_000)); } // refresh persisted the failure
    if (signal.aborted) return;
    try { await wait(delay, signal); }
    catch (error) { if (!signal.aborted) throw error; }
  }
}
