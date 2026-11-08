// The panel reads the cache only from `tick`. A phone webview reports the page as
// hidden while the inbox is on screen, so a beat that waits for `visible` never
// reads again. These tests are that gate.
import assert from 'node:assert/strict';
import test from 'node:test';
import { startInboxHeartbeat } from '../src/inbox-heartbeat.ts';

type Visibility = 'hidden' | 'visible';

function view(initial: Visibility, shell: boolean) {
  let visibilityState: Visibility = initial;
  const windowListeners = new Map<string, Set<() => void>>();
  const documentListeners = new Map<string, Set<() => void>>();
  const resumeListeners = new Set<(event: { type?: string }) => void>();
  let beat: (() => void) | null = null;
  let intervalMs = 0;
  const api = {
    document: {
      get visibilityState() { return visibilityState; },
      hasFocus: () => false,
      addEventListener(type: string, listener: () => void) {
        const set = documentListeners.get(type) ?? new Set<() => void>();
        set.add(listener);
        documentListeners.set(type, set);
      },
      removeEventListener(type: string, listener: () => void) {
        documentListeners.get(type)?.delete(listener);
      },
    },
    setInterval(handler: () => void, timeout: number) {
      beat = handler;
      intervalMs = timeout;
      return 1;
    },
    clearInterval() { beat = null; },
    addEventListener(type: string, listener: () => void) {
      const set = windowListeners.get(type) ?? new Set<() => void>();
      set.add(listener);
      windowListeners.set(type, set);
    },
    removeEventListener(type: string, listener: () => void) {
      windowListeners.get(type)?.delete(listener);
    },
    ...(shell ? {
      bb: {
        native: {
          subscribe(listener: (event: { type?: string }) => void) {
            resumeListeners.add(listener);
            return () => { resumeListeners.delete(listener); };
          },
        },
      },
    } : {}),
    fire(type: 'pagehide' | 'pageshow' | 'focus') {
      for (const listener of windowListeners.get(type) ?? []) listener();
    },
    hide() {
      visibilityState = 'hidden';
      for (const listener of documentListeners.get('visibilitychange') ?? []) listener();
    },
    reveal() {
      visibilityState = 'visible';
      for (const listener of documentListeners.get('visibilitychange') ?? []) listener();
    },
    resume() {
      for (const listener of resumeListeners) listener({ type: 'resume' });
    },
    interval() { beat?.(); },
    get intervalMs() { return intervalMs; },
  };
  return api;
}

function session() {
  const ticks: number[] = [];
  let flushes = 0;
  return {
    ticks,
    get flushes() { return flushes; },
    api: {
      tick(now: number) { ticks.push(now); },
      flush() { flushes += 1; },
    },
  };
}

test('a hidden desktop page does not tick, and becoming visible ticks at once', () => {
  const seen = session();
  const win = view('hidden', false);
  const stop = startInboxHeartbeat(seen.api, win as unknown as Window);
  assert.equal(win.intervalMs, 1_000);
  win.interval();
  assert.equal(seen.ticks.length, 0, 'a hidden desktop tab does not read the inbox');
  win.reveal();
  assert.equal(seen.ticks.length, 1, 'showing the page ticks without waiting for the next interval');
  win.interval();
  assert.equal(seen.ticks.length, 2);
  win.hide();
  assert.equal(seen.flushes, 1, 'hiding writes a draft that is still inside its debounce');
  win.interval();
  assert.equal(seen.ticks.length, 2, 'hiding stops the beat');
  stop();
  win.reveal();
  win.interval();
  assert.equal(seen.ticks.length, 2, 'unmount stops the beat');
});

test('the phone shell keeps ticking while the page reports hidden', () => {
  const seen = session();
  const win = view('hidden', true);
  startInboxHeartbeat(seen.api, win as unknown as Window);
  win.interval();
  assert.equal(seen.ticks.length, 1, 'the phone webview reports hidden while the inbox is on screen');
  win.hide();
  win.interval();
  assert.equal(seen.ticks.length, 2, 'a hidden report from that webview does not stop the beat');
  win.fire('pagehide');
  win.interval();
  assert.equal(seen.ticks.length, 2, 'the page itself hiding does stop the beat');
  assert.ok(seen.flushes >= 1);
  win.resume();
  assert.equal(seen.ticks.length, 3, 'the shell resume event ticks at once');
  win.interval();
  assert.equal(seen.ticks.length, 4);
});
