/**
 * Reads LinkedIn's inbox inside a Chrome page the plugin starts itself.
 *
 * The session lives in a dedicated browser profile, so nothing is exported: no cookie store is
 * read, no Keychain entry is unlocked, and no request leaves the browser. Each read starts a
 * headless Chrome with that profile, runs the same-origin script in a real page, and stops.
 * Nothing is clicked, accepted, or sent.
 *
 * Chrome for Testing is used because this machine has no system Chrome; the profile is kept
 * apart from any personal browsing profile.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { linkedinPageExpression, type LinkedInRead } from './linkedin-page.ts';
import { linkedinProbeExpression } from './linkedin-probe.ts';
import {
  LINKEDIN_TEXT_LIMIT,
  controlRectExpression,
  controlTextExpression,
  focusControlExpression,
  typingTargetExpression,
  isSendControl,
  linkedInPath,
  pageControlsExpression,
  type PageControl,
} from './linkedin-ui.ts';
import { createAsyncGate } from './async-gate.ts';

/** The signed-in profile is reused by every read; the gate keeps two browser starts apart. */
const gate = createAsyncGate();
const START_URL = 'https://www.linkedin.com/feed/';
const START_TIMEOUT = 20_000;
const READ_TIMEOUT = 60_000;
const NAVIGATE_TIMEOUT = 30_000;
const SIGN_IN_HINT = 'Run `bb unified-inbox linkedin-signin` to sign in to LinkedIn once.';
const SIGN_IN_WINDOW_HINT = 'Close the LinkedIn sign-in window before refreshing the inbox.';

export type CdpTransport = {
  send(message: string): void;
  onMessage(handler: (message: string) => void): void;
  onClose(handler: () => void): void;
  close(): void;
};

type Pending = { resolve(value: unknown): void; reject(error: Error): void };

export function linkedinProfileDir(): string {
  return process.env.UNIFIED_INBOX_LINKEDIN_PROFILE || join(homedir(), '.bb/plugins/unified-inbox/linkedin-profile');
}

/** The Chrome binary to drive: an explicit override, a system Chrome, or a cached Chrome for Testing. */
export function linkedinChromePath(): string {
  const override = process.env.UNIFIED_INBOX_CHROME;
  if (override) {
    if (existsSync(override)) return override;
    throw new Error(`UNIFIED_INBOX_CHROME points at ${override}, which does not exist.`);
  }
  const found = chromeCandidates().find(path => existsSync(path));
  if (found) return found;
  throw new Error('LinkedIn needs a Chrome this plugin can start. Install one with `npx @puppeteer/browsers install chrome@stable`, or set UNIFIED_INBOX_CHROME to the binary.');
}

function chromeCandidates(): string[] {
  const home = homedir();
  const appPath = join('Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing');
  return [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    ...versionedDirs(join(home, '.agent-browser', 'browsers')).flatMap(dir => [join(dir, appPath), ...versionedDirs(dir).map(sub => join(sub, appPath))]),
    ...versionedDirs(join(home, '.cache', 'puppeteer', 'chrome')).flatMap(dir => [join(dir, appPath), ...versionedDirs(dir).map(sub => join(sub, appPath))]),
  ];
}

/** Entries of `root` newest version first, so a newer cached Chrome wins. */
function versionedDirs(root: string): string[] {
  try {
    return readdirSync(root).sort((a, b) => b.localeCompare(a, 'en', { numeric: true })).map(name => join(root, name));
  } catch {
    return [];
  }
}

export function browserArgs(options: { profile: string; url: string; headless: boolean; debugging: boolean }): string[] {
  return [
    ...(options.headless ? ['--headless=new'] : []),
    ...(options.debugging ? ['--remote-debugging-port=0'] : []),
    `--user-data-dir=${options.profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-default-apps',
    '--disable-sync',
    '--metrics-recording-only',
    '--disable-features=Translate',
    '--hide-scrollbars',
    '--window-size=1280,800',
    options.url,
  ];
}

/** Chrome announces its DevTools endpoint on stderr; that line is how the port is discovered. */
export function parseDevtoolsUrl(text: string): string | undefined {
  return /DevTools listening on (ws:\/\/\S+)/.exec(text)?.[1];
}

export function createCdpClient(transport: CdpTransport) {
  let nextId = 1;
  const pending = new Map<number, Pending>();
  const listeners = new Map<string, Set<(params: unknown, sessionId?: string) => void>>();
  transport.onMessage(raw => {
    let message: { id?: unknown; method?: unknown; params?: unknown; sessionId?: unknown; result?: unknown; error?: { message?: unknown } };
    try {
      message = JSON.parse(raw) as typeof message;
    } catch {
      return;
    }
    if (typeof message.id === 'number') {
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      if (message.error) entry.reject(new Error(typeof message.error.message === 'string' ? message.error.message : 'Chrome DevTools Protocol error'));
      else entry.resolve(message.result);
      return;
    }
    if (typeof message.method !== 'string') return;
    for (const listener of listeners.get(message.method) ?? []) {
      listener(message.params, typeof message.sessionId === 'string' ? message.sessionId : undefined);
    }
  });
  transport.onClose(() => {
    for (const entry of pending.values()) entry.reject(new Error('The browser connection closed.'));
    pending.clear();
  });
  return {
    send<T = unknown>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
      const id = nextId++;
      return new Promise<T>((resolve, reject) => {
        pending.set(id, { resolve: value => resolve(value as T), reject });
        transport.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      });
    },
    on(method: string, handler: (params: unknown, sessionId?: string) => void): () => void {
      const set = listeners.get(method) ?? new Set();
      listeners.set(method, set);
      set.add(handler);
      return () => { set.delete(handler); };
    },
    close() { transport.close(); },
  };
}

export function webSocketTransport(url: string): Promise<CdpTransport> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const messageHandlers = new Set<(message: string) => void>();
    const closeHandlers = new Set<() => void>();
    socket.addEventListener('message', event => {
      if (typeof event.data === 'string') for (const handler of messageHandlers) handler(event.data);
    });
    socket.addEventListener('close', () => { for (const handler of closeHandlers) handler(); });
    socket.addEventListener('error', () => reject(new Error('Could not connect to the LinkedIn browser.')));
    socket.addEventListener('open', () => resolve({
      send(message) { socket.send(message); },
      onMessage(handler) { messageHandlers.add(handler); },
      onClose(handler) { closeHandlers.add(handler); },
      close() { socket.close(); },
    }));
  });
}

/** Maps the page script's envelope to a payload, or to a message a person can act on. */
export function linkedinReadResult(value: unknown): unknown {
  if (!value || typeof value !== 'object') throw new Error(`LinkedIn did not return a usable response. ${SIGN_IN_HINT}`);
  const result = value as { ok?: unknown; payload?: unknown; error?: unknown };
  if (result.ok === true) return result.payload;
  const reason = typeof result.error === 'string' ? result.error.slice(0, 200) : '';
  if (/LinkedIn (401|403)/.test(reason) || /not signed in/i.test(reason)) throw new Error(`LinkedIn needs you to sign in again. ${SIGN_IN_HINT}`);
  if (/LinkedIn \d+/.test(reason)) throw new Error(reason);
  throw new Error(`LinkedIn is unavailable in its browser. ${SIGN_IN_HINT}`);
}

/** Chrome aborts when another process holds the profile; that abort is the sign-in window still being open. */
export function chromeStartupError(stderr: string, code: number | null): Error {
  if (/ProcessSingleton|SingletonLock|File exists \(17\)/.test(stderr)) return new Error(SIGN_IN_WINDOW_HINT);
  const tail = stderr.trim().split('\n').at(-1)?.slice(0, 200);
  return new Error(`Chrome exited before LinkedIn could be read (code ${code ?? 'unknown'})${tail ? `: ${tail}` : '.'}`);
}

type Browser = { wsUrl: string; alive: boolean; stop(): Promise<void> };
type Page = { client: ReturnType<typeof createCdpClient>; sessionId: string; browser: Browser };

/** Chrome's own start dominates a read, so one page is kept open for a short while between reads. */
const IDLE_MS = 90_000;
let warm: Page | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;

async function startBrowser(profile: string): Promise<Browser> {
  const child = spawn(linkedinChromePath(), browserArgs({ profile, url: 'about:blank', headless: true, debugging: true }), { stdio: ['ignore', 'ignore', 'pipe'] });
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    const exited = await Promise.race([once(child, 'exit'), sleep(3000).then(() => false)]);
    if (exited === false && child.exitCode === null) child.kill('SIGKILL');
  };
  const browser: Browser = { wsUrl: '', alive: true, stop };
  const wsUrl = await new Promise<string>((resolve, reject) => {
    let buffered = '';
    const timer = setTimeout(() => finish(new Error('The LinkedIn browser did not start in time.')), START_TIMEOUT);
    const finish = (error: Error | null, value?: string) => {
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value as string);
    };
    child.stderr?.on('data', (chunk: Buffer) => {
      buffered = (buffered + chunk.toString()).slice(-8000);
      const found = parseDevtoolsUrl(buffered);
      if (found) finish(null, found);
    });
    child.once('error', error => finish(new Error(`Could not start Chrome for LinkedIn: ${error.message}`)));
    child.once('exit', code => { browser.alive = false; finish(chromeStartupError(buffered, code)); });
  }).catch(async error => {
    await stop();
    throw error;
  });
  browser.wsUrl = wsUrl;
  return browser;
}

/** Runs one in-page read. Rejects rather than returning a partial result. */
export async function readLinkedInInChrome(read: LinkedInRead): Promise<unknown> {
  // The probe is its own expression, but it answers through the same envelope as the other two
  // reads: a page that failed must throw here, not hand back a half-empty payload.
  if (read.mode === 'probe') return linkedinReadResult(await evaluateInLinkedInProfile(linkedinProbeExpression(read.mailbox)));
  if (read.mode === 'thread' && !/^urn:li:msg_conversation:.+/.test(read.id)) throw new Error('That LinkedIn conversation cannot be opened.');
  return linkedinReadResult(await evaluateInLinkedInProfile(linkedinPageExpression(read)));
}

/**
 * Runs one sequence against the warm page while holding the gate, so a lookup and the input that
 * follows it see the same page. A failure drops the browser: a page that failed mid-action is not
 * trusted for the next one.
 */
async function withLinkedInPage<T>(run: (page: Page) => Promise<T>): Promise<T> {
  return gate(async () => {
    const page = await warmPage();
    keepWarm();
    try {
      return await run(page);
    } catch (error) {
      await stopLinkedInBrowser();
      throw error;
    }
  });
}

async function evaluate(page: Page, expression: string): Promise<unknown> {
  const evaluated = await withTimeout(
    page.client.send<{ result?: { value?: unknown }; exceptionDetails?: { exception?: { description?: unknown } } }>(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true },
      page.sessionId,
    ),
    READ_TIMEOUT,
    'LinkedIn did not answer in time.',
  );
  const description = evaluated.exceptionDetails?.exception?.description;
  if (typeof description === 'string') throw new Error(`LinkedIn failed in the browser: ${description.split('\n')[0].slice(0, 200)}`);
  return evaluated.result?.value;
}

/** Evaluates one expression in a signed-in LinkedIn page of the plugin's own profile. */
export async function evaluateInLinkedInProfile(expression: string): Promise<unknown> {
  return withLinkedInPage(page => evaluate(page, expression));
}

/** Moves the plugin's LinkedIn tab to one allowlisted path. A refused path throws before navigating. */
export async function openInLinkedInProfile(path: string): Promise<void> {
  const target = linkedInPath(path);
  if (!target) throw new Error(`Not a LinkedIn path this plugin will open: ${typeof path === 'string' ? path.slice(0, 120) : String(path)}`);
  await withLinkedInPage(async page => {
    const loaded = waitForLoad(page.client, page.sessionId);
    await page.client.send('Page.navigate', { url: `https://www.linkedin.com${target}` }, page.sessionId);
    await withTimeout(loaded, NAVIGATE_TIMEOUT, 'LinkedIn did not load that page in time.');
  });
}

/** What a person could act on in the open page, in document order. */
export async function inspectLinkedInPage(): Promise<PageControl[]> {
  const controls = await evaluateInLinkedInProfile(pageControlsExpression());
  if (!Array.isArray(controls)) throw new Error('LinkedIn did not return a list of usable controls.');
  return controls as PageControl[];
}

/**
 * Clicks the control at `index` with trusted mouse input. A control that sends, accepts, connects,
 * or publishes is refused — before a single event is dispatched — unless the caller passes
 * `{ allow: 'send' }`, because that click changes real state on the owner's LinkedIn account.
 */
export async function clickInLinkedInPage(
  index: number,
  approval?: { allow: 'send' },
): Promise<{ clicked: boolean; control?: PageControl; reason?: string }> {
  // Built before the page opens, so a bad index never starts a browser.
  const expression = controlRectExpression(index);
  return withLinkedInPage(async page => {
    const found = await evaluate(page, expression);
    if (typeof found === 'string') return { clicked: false, reason: found };
    const control = found as PageControl | null | undefined;
    if (!control || typeof control !== 'object') return { clicked: false, reason: 'LinkedIn did not answer with that control.' };
    if (isSendControl(control) && approval?.allow !== 'send') {
      return { clicked: false, control, reason: `"${control.name}" sends to LinkedIn; pass { allow: 'send' } to approve this one click.` };
    }
    const x = Math.round(control.x + control.width / 2);
    const y = Math.round(control.y + control.height / 2);
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased'] as const) {
      await page.client.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 }, page.sessionId);
    }
    return { clicked: true, control };
  });
}

/** One character at a time, the way a keyboard delivers it: some editors only listen to keys. */
async function typeAsKeys(page: Page, text: string): Promise<void> {
  for (const character of text) {
    const base = { key: character, text: character, unmodifiedText: character };
    await page.client.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base }, page.sessionId);
    await page.client.send('Input.dispatchKeyEvent', { type: 'char', ...base }, page.sessionId);
    await page.client.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base }, page.sessionId);
  }
}

/**
 * Focuses the control at `index` and inserts `text` as trusted input. `el.value = …` and
 * `textContent = …` are ignored by Lexical and React, so the text has to arrive as a real editing
 * command.
 */
export async function typeInLinkedInPage(index: number, text: string): Promise<{ typed: boolean; control?: PageControl; reason?: string }> {
  if (typeof text !== 'string') throw new Error('LinkedIn typing needs the text to type.');
  const expression = typingTargetExpression(index);
  const typed = text.slice(0, LINKEDIN_TEXT_LIMIT);
  return withLinkedInPage(async page => {
    const found = await evaluate(page, expression);
    if (typeof found === 'string') return { typed: false, reason: found };
    const target = found as (PageControl & { editable?: boolean }) | null;
    if (!target || typeof target !== 'object') return { typed: false, reason: 'LinkedIn did not answer with that control.' };
    if (target.editable !== true) return { typed: false, reason: `"${target.name}" has nothing in it a person can type into.` };
    if (isSendControl(target)) return { typed: false, control: target, reason: `"${target.name}" sends to LinkedIn; typing into it is not a step this plugin takes.` };
    const control: PageControl = { ...target, index };
    const landed = async () => String(await evaluate(page, controlTextExpression(index)) ?? '').includes(typed.slice(0, 40));
    // A trusted click puts the caret in the editor. DOM focus alone does not: LinkedIn's composer is
    // a Lexical contenteditable that only opens an editing session on a real pointer event.
    const x = Math.round(control.x + control.width / 2);
    const y = Math.round(control.y + control.height / 2);
    const textLanded = async () => String(await evaluate(page, controlTextExpression(index)) ?? '').includes(typed.slice(0, 40));
    if (typed) {
      for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
        await page.client.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 }, page.sessionId);
      }
      await page.client.send('Input.insertText', { text: typed }, page.sessionId);
      // LinkedIn's composer drops a browser-level insert, so the text arrives the way a person's does:
      // one key at a time. Both are verified below, because believing an unverified insert would send
      // an empty message.
      if (!(await textLanded())) await typeAsKeys(page, typed);
      if (!(await textLanded())) return { typed: false, control, reason: 'LinkedIn did not accept the text; the field still reads empty.' };
    }
    // Report the control that took the text, so a wrong index is visible instead of silent.
    return { typed: true, control };
  });
}

/**
 * The keys a caller may press. `char` is the step that inserts a character, and only Enter carries
 * one; Tab, Escape, Backspace and ArrowDown take their default action from the raw key down alone.
 */
const PRESSABLE_KEYS: Record<string, { code: string; keyCode: number; text?: string }> = {
  Enter: { code: 'Enter', keyCode: 13, text: '\r' },
  Escape: { code: 'Escape', keyCode: 27 },
  Tab: { code: 'Tab', keyCode: 9 },
  Backspace: { code: 'Backspace', keyCode: 8 },
  ArrowDown: { code: 'ArrowDown', keyCode: 40 },
};

/** Presses one key in the page, from a short allowlist. Anything else throws before touching it. */
export async function pressKeyInLinkedInPage(key: string): Promise<void> {
  const mapped = typeof key === 'string' ? PRESSABLE_KEYS[key] : undefined;
  if (!mapped) throw new Error(`LinkedIn accepts only ${Object.keys(PRESSABLE_KEYS).join(', ')} here; got ${String(key)}.`);
  await withLinkedInPage(async page => {
    const base = { key, code: mapped.code, windowsVirtualKeyCode: mapped.keyCode, nativeVirtualKeyCode: mapped.keyCode };
    await page.client.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base }, page.sessionId);
    if (mapped.text !== undefined) {
      await page.client.send('Input.dispatchKeyEvent', { type: 'char', ...base, text: mapped.text, unmodifiedText: mapped.text }, page.sessionId);
    }
    await page.client.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base }, page.sessionId);
  });
}

/** Loads the LinkedIn page ahead of the first read; a failure leaves the next read to report it. */
export async function prewarmLinkedInBrowser(): Promise<void> {
  try {
    await gate(async () => { await warmPage(); keepWarm(); });
  } catch { /* the first real read surfaces the reason */ }
}

/** Stops the warm browser, if any; safe to call repeatedly. */
export async function stopLinkedInBrowser(): Promise<void> {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  const page = warm;
  warm = null;
  if (!page) return;
  try { page.client.close(); } catch { /* the connection is going away anyway */ }
  await page.browser.stop();
}

/** Opens the same profile in a visible window so the owner can sign in once. */
export async function openLinkedInSignIn(): Promise<string> {
  await stopLinkedInBrowser();
  const profile = linkedinProfileDir();
  mkdirSync(profile, { recursive: true });
  const child = spawn(linkedinChromePath(), browserArgs({ profile, url: 'https://www.linkedin.com/login', headless: false, debugging: false }), { detached: true, stdio: 'ignore' });
  child.unref();
  return profile;
}

async function warmPage(): Promise<Page> {
  if (warm?.browser.alive) return warm;
  await stopLinkedInBrowser();
  const profile = linkedinProfileDir();
  mkdirSync(profile, { recursive: true });
  const browser = await startBrowser(profile);
  const client = createCdpClient(await webSocketTransport(browser.wsUrl));
  try {
    const { targetId } = await client.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await client.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
    await client.send('Page.enable', {}, sessionId);
    const loaded = waitForLoad(client, sessionId);
    await client.send('Page.navigate', { url: START_URL }, sessionId).catch(() => undefined);
    await loaded;
    warm = { client, sessionId, browser };
    return warm;
  } catch (error) {
    try { client.close(); } catch { /* nothing left to close */ }
    await browser.stop();
    throw error;
  }
}

function keepWarm(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { void stopLinkedInBrowser(); }, IDLE_MS);
  idleTimer.unref?.();
}

function waitForLoad(client: ReturnType<typeof createCdpClient>, sessionId: string): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(done, START_TIMEOUT);
    const off = client.on('Page.loadEventFired', (_params, eventSession) => { if (eventSession === sessionId) done(); });
    function done() {
      clearTimeout(timer);
      off();
      resolve();
    }
  });
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function once(child: { once(event: 'exit', handler: () => void): unknown }, event: 'exit'): Promise<boolean> {
  return new Promise(resolve => child.once(event, () => resolve(true)));
}
