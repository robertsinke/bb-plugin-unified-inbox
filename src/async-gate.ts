/** Run async work one at a time. A rejection does not block the next call. */
export function createAsyncGate() {
  let tail: Promise<void> = Promise.resolve();
  return function gate<T>(run: () => Promise<T>): Promise<T> {
    const result = tail.then(run, run);
    tail = result.then(() => undefined, () => undefined);
    return result;
  };
}

/**
 * Run async work with at most `limit` calls in flight. A rejection frees its slot, so one failed
 * call cannot shrink the pool. Slots are handed to the waiting call rather than counted down and
 * up again, so the limit holds even when a new caller arrives as one finishes.
 */
export function createAsyncPool(limit: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else active -= 1;
  };
  return async function pool<T>(run: () => Promise<T>): Promise<T> {
    // A free slot is taken; otherwise this call waits for one to be handed over, already counted.
    if (active < limit) active += 1;
    else await new Promise<void>(resolve => waiting.push(resolve));
    try { return await run(); } finally { release(); }
  };
}
