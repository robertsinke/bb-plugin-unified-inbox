import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { createInboxCache } from '../src/inbox-cache.ts';
import { createInboxRefresh, runInboxRefresh } from '../src/inbox-refresh.ts';
import { accounts } from '../src/adapters/types.ts';

function fixture(sync: Parameters<typeof createInboxRefresh>[0]['sync']) {
  const db = new Database(':memory:');
  const cache = createInboxCache(db);
  let now = 100;
  const refresh = createInboxRefresh({ sync, read: cache.freshness, hasCachedRows: account => cache.list().some(row => row.account === account), save: cache.saveFreshness, error: () => 'Source unavailable.', now: () => now });
  return { db, cache, refresh: refresh.refresh, time: (value: number) => { now = value; } };
}

test('success, failed attempt and recovery persist independently; cached rows survive failure', async () => {
  let fail = false;
  const f = fixture(async () => { if (fail) throw new Error('private provider payload'); return { items: [], updatedAt: 1 }; });
  try {
    f.cache.save('personal', [{ account: 'personal', id: 't', title: 'Subject', preview: 'Hello', date: 1, unread: true }]);
    await f.refresh('personal');
    fail = true;
    f.time(200);
    await assert.rejects(f.refresh('personal'), /^Error: Source unavailable\.$/);
    const reloaded = createInboxCache(f.db);
    assert.deepEqual(reloaded.freshness('personal'), { lastAttemptAt: 200, lastSuccessAt: 100, lastError: 'Source unavailable.', cacheFallback: true });
    assert.equal(reloaded.list().length, 1);
    fail = false;
    f.time(300);
    await f.refresh('personal');
    assert.deepEqual(reloaded.freshness('personal'), { lastAttemptAt: 300, lastSuccessAt: 300, lastError: null, cacheFallback: false });
  } finally { f.db.close(); }
});

test('failed refresh only reports cache fallback when this source has cached rows', async () => {
  const f = fixture(async () => { throw new Error('offline'); });
  try {
    f.cache.save('business', [{ account: 'business', id: 't', title: 'Other source', preview: '', date: 1, unread: false }]);
    await assert.rejects(f.refresh('personal'));
    assert.equal(f.cache.freshness('personal').cacheFallback, false);
    assert.equal(f.cache.freshness('personal').lastSuccessAt, null);
    assert.equal(f.cache.freshness('personal').lastError, 'Source unavailable.');
    await assert.rejects(f.refresh('business'));
    assert.equal(f.cache.freshness('business').cacheFallback, true);
  } finally { f.db.close(); }
});

test('manual and worker calls coalesce per source while other sources continue', async () => {
  let release!: () => void;
  const calls: string[] = [];
  const f = fixture(async account => {
    calls.push(account);
    if (account === 'personal') await new Promise<void>(resolve => { release = resolve; });
    return { items: [], updatedAt: 0 };
  });
  try {
    const first = f.refresh('personal');
    const second = f.refresh('personal');
    assert.equal(first, second);
    await f.refresh('linkedin');
    assert.deepEqual(calls, ['personal', 'linkedin']);
    release();
    await first;
  } finally { f.db.close(); }
});

test('workers refresh every source without a UI and stop on host abort', async () => {
  const seen: string[] = [];
  const f = fixture(async account => { seen.push(account); return { items: [], updatedAt: 0 }; });
  const controller = new AbortController();
  const workers = accounts.map(account => runInboxRefresh(async () => {
    await f.refresh(account);
    if (seen.length === accounts.length) controller.abort();
  }, 1, controller.signal));
  try {
    await Promise.all(workers);
    assert.deepEqual(seen.sort(), [...accounts].sort());
    const count = seen.length;
    await runInboxRefresh(async () => { seen.push('unexpected'); }, 1, controller.signal);
    assert.equal(seen.length, count);
  } finally { f.db.close(); }
});

test('consecutive failures back off to one hour; success resets the delay', async () => {
  const controller = new AbortController();
  const delays: number[] = [];
  let attempts = 0;
  await runInboxRefresh(async () => {
    attempts++;
    if (attempts !== 10 && attempts !== 11) throw new Error('offline');
  }, 45_000, controller.signal, async (delay, signal) => {
    assert.equal(signal, controller.signal);
    delays.push(delay);
    if (delays.length === 13) controller.abort();
  });
  assert.equal(attempts, 13);
  assert.deepEqual(delays, [90_000, 180_000, 360_000, 720_000, 1_440_000, 2_880_000,
    3_600_000, 3_600_000, 3_600_000, 45_000, 45_000, 90_000, 180_000]);
});

test('abort cancels a pending worker sleep without another refresh', async () => {
  const controller = new AbortController();
  let attempts = 0;
  const worker = runInboxRefresh(async () => { attempts++; }, 3_600_000, controller.signal);
  await Promise.resolve();
  controller.abort();
  await worker;
  assert.equal(attempts, 1);
});

test('worker retries failure on cadence and cancels its sleep', async () => {
  const controller = new AbortController();
  let attempts = 0;
  await runInboxRefresh(async () => {
    if (++attempts === 1) throw new Error('offline');
    controller.abort();
  }, 1, controller.signal);
  assert.equal(attempts, 2);
});

test('legacy bodies have unknown age and cache repair preserves body verification time', () => {
  const db = new Database(':memory:');
  try {
    db.exec("CREATE TABLE inbox_thread (account TEXT NOT NULL, id TEXT NOT NULL, messages TEXT NOT NULL, PRIMARY KEY(account,id)); INSERT INTO inbox_thread VALUES ('personal', 'old', '[]')");
    const cache = createInboxCache(db);
    assert.equal(cache.threadUpdatedAt('personal', 'old'), null);
    cache.saveThread('personal', 'new', [], 123);
    cache.saveThread('personal', 'new', [{ text: 'repaired' }], cache.threadUpdatedAt('personal', 'new'));
    assert.equal(cache.threadUpdatedAt('personal', 'new'), 123);
  } finally { db.close(); }
});
