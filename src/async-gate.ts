/** Run async work one at a time. A rejection does not block the next call. */
export function createAsyncGate() {
  let tail: Promise<void> = Promise.resolve();
  return function gate<T>(run: () => Promise<T>): Promise<T> {
    const result = tail.then(run, run);
    tail = result.then(() => undefined, () => undefined);
    return result;
  };
}
