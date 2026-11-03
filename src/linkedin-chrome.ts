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
import {
  LINKEDIN_TEXT_LIMIT,
  findControlExpression,
  invitationTargetOf,
  isSendControl,
  linkedInPath,
  pageControlsExpression,
  recipientsExpression,
  sendApprovalDecision,
  threadKeyExpression,
  type PageControl,
  type SendApproval,
  type SendTarget,
} from './linkedin-ui.ts';
import { writeRecorderExpression } from './linkedin-write.ts';
import { createAsyncGate } from './async-gate.ts';

/** All operations share one gate, but read failures must not tear down an in-progress compose. */
const { gate, write: withLinkedInPage, read: withLinkedInRead } = createLinkedInPageAccess({
  load: warmPage, stop: stopLinkedInBrowser, pauseIdle, keepWarm,
});
const START_URL = 'https://www.linkedin.com/feed/';
const START_TIMEOUT = 20_000;
const READ_TIMEOUT = 60_000;
const LIST_READ_TIMEOUT = 10_000;
const NAVIGATE_TIMEOUT = 30_000;
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

/** Serializes page use and suspends idle teardown during it. Only failed writes reset the page. */
export function createLinkedInPageAccess<P>(deps: {
  load(): Promise<P>;
  stop(): Promise<void>;
  pauseIdle(): void;
  keepWarm(): void;
}) {
  const gate = createAsyncGate();
  function run<T>(operation: (page: P) => Promise<T>, resetOnError: boolean): Promise<T> {
    return gate(async () => {
      deps.pauseIdle();
      try {
        const page = await deps.load();
        try { return await operation(page); }
        catch (error) {
          if (resetOnError) await deps.stop();
          throw error;
        }
      } finally { deps.keepWarm(); }
    });
  }
  return {
    gate,
    read: <T>(operation: (page: P) => Promise<T>) => run(operation, false),
    write: <T>(operation: (page: P) => Promise<T>) => run(operation, true),
  };
}

async function evaluate(page: Page, expression: string, timeout = READ_TIMEOUT): Promise<unknown> {
  const evaluated = await withTimeout(
    page.client.send<{ result?: { value?: unknown }; exceptionDetails?: { exception?: { description?: unknown } } }>(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true },
      page.sessionId,
    ),
    timeout,
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
/** List/probe scripts only issue GETs. Failure or timeout preserves the interactive page/recorder. */
export async function evaluateLinkedInListRead(expression: string): Promise<unknown> {
  return withLinkedInRead(page => evaluate(page, expression, LIST_READ_TIMEOUT));
}

/**
 * The recorder that survives a page load. A web app captures `fetch` (or XHR) when it boots, so a
 * wrapper installed afterwards is never called — the recorder has to be in place before the app's
 * own code runs, which is what `Page.addScriptToEvaluateOnNewDocument` is for. Arming therefore
 * reloads the page; the returned identifier is remembered so a second arm replaces the first
 * instead of stacking wrappers.
 */
let recorderScriptId: string | null = null;

export async function armLinkedInWriteRecorder(): Promise<{ installed: boolean; recording: boolean }> {
  return withLinkedInPage(async page => {
    if (recorderScriptId) {
      await page.client.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: recorderScriptId }, page.sessionId).catch(() => undefined);
      recorderScriptId = null;
    }
    const added = await page.client.send<{ identifier?: string }>(
      'Page.addScriptToEvaluateOnNewDocument',
      { source: writeRecorderExpression() },
      page.sessionId,
    );
    recorderScriptId = added.identifier ?? null;
    // The current document predates the script, so it has to be loaded again for the app to pick
    // up the wrapper. The load is awaited so the caller can act on the page it asked for.
    const loaded = waitForLoad(page.client, page.sessionId);
    await page.client.send('Page.reload', {}, page.sessionId).catch(() => undefined);
    await loaded;
    return { installed: true, recording: true };
  });
}

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
/**
 * Finds the named control once and holds a node handle to it, so every later question — where is it,
 * what does it say — is asked of that same element rather than of an index the next re-render may
 * have moved. The handle is released before returning.
 */
async function withControl<T>(
  page: Page,
  name: string,
  role: string | undefined,
  use: (control: { objectId: string; x: number; y: number }) => Promise<T>,
): Promise<T | null> {
  const found = await page.client.send<{ result?: { objectId?: string } }>(
    'Runtime.evaluate',
    { expression: findControlExpression(name, role), returnByValue: false, awaitPromise: false },
    page.sessionId,
  );
  const objectId = found.result?.objectId;
  if (!objectId) return null;
  try {
    const model = await page.client.send<{ model?: { content?: number[] } }>('DOM.getBoxModel', { objectId }, page.sessionId);
    const content = model.model?.content;
    if (!content || content.length < 8) return null;
    const xs = [content[0], content[2], content[4], content[6]];
    const ys = [content[1], content[3], content[5], content[7]];
    return await use({
      objectId,
      x: Math.round((Math.min(...xs) + Math.max(...xs)) / 2),
      y: Math.round((Math.min(...ys) + Math.max(...ys)) / 2),
    });
  } finally {
    await page.client.send('Runtime.releaseObject', { objectId }, page.sessionId).catch(() => undefined);
  }
}

/** What that held element says right now, read from the same node the action used. */
async function controlText(page: Page, objectId: string): Promise<string> {
  const answer = await page.client.send<{ result?: { value?: unknown } }>(
    'Runtime.callFunctionOn',
    { objectId, functionDeclaration: 'function () { return String(this.value != null ? this.value : (this.innerText || this.textContent || "")); }', returnByValue: true },
    page.sessionId,
  );
  return String(answer.result?.value ?? '');
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
 * What the page itself says a send is addressed to, in one read: the compose box's recipient chips,
 * or — when there are no chips to read, as in a reply box — the conversation key the open thread's
 * URL names. The caller makes the send decision on this answer and names the send-log row for it,
 * so the two cannot be about different readers of a page that re-renders.
 */
export async function readSendTarget(): Promise<SendTarget> {
  const chips = await evaluateInLinkedInProfile(recipientsExpression());
  const recipients = Array.isArray(chips) ? chips.map(chip => String(chip)) : [];
  const threadKey = recipients.length ? '' : String(await evaluateInLinkedInProfile(threadKeyExpression()) ?? '');
  return { recipients, threadKey };
}

/**
 * A send click is only allowed when it names an allowlisted recipient *and* the compose box is
 * addressed to exactly that one person. Reading the chips is the whole point: a name search offers
 * whoever matches, and the first suggestion is not necessarily who was asked for.
 *
 * `target` is the page read a caller already made (`readSendTarget`) so its send-log row and this
 * decision share one answer; without it, this call reads the page itself.
 */
export async function clickNamedControl(
  name: string,
  role?: string,
  approval?: SendApproval,
  target?: SendTarget,
): Promise<{ clicked: boolean; name?: string; reason?: string; recipients?: string[] }> {
  // An invitation button answers or makes a connection, so it is gated even though its label names
  // a person rather than the action — LinkedIn's send pattern cannot see it.
  const sending = isSendControl({ index: 0, role: role ?? 'button', name, tag: 'button', x: 0, y: 0, width: 0, height: 0, focused: false }) || invitationTargetOf(name) !== null;
  if (sending) {
    // What the page says about the addressee: chips in a compose box, the open thread's own urn
    // in a reply. The policy decision is one pure function, so it is tested without a browser.
    const observed = target ?? await readSendTarget();
    const decision = sendApprovalDecision(approval, name, observed);
    if (!decision.ok) return { clicked: false, recipients: observed.recipients, reason: decision.reason };
  }
  return (await withLinkedInPage(page => withControl(page, name, role, async control => {
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased'] as const) {
      await page.client.send('Input.dispatchMouseEvent', { type, x: control.x, y: control.y, button: 'left', clickCount: 1 }, page.sessionId);
    }
    return { clicked: true };
  }))) ?? { clicked: false, reason: `LinkedIn shows no control named "${name}".` };
}

export async function typeIntoNamedControl(name: string, text: string, role?: string, replace?: boolean): Promise<{ typed: boolean; reason?: string }> {
  if (typeof text !== 'string' || !text) throw new Error('LinkedIn typing needs the text to type.');
  const typed = text.slice(0, LINKEDIN_TEXT_LIMIT);
  return (await withLinkedInPage(page => withControl(page, name, role, async control => {
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased'] as const) {
      await page.client.send('Input.dispatchMouseEvent', { type, x: control.x, y: control.y, button: 'left', clickCount: 1 }, page.sessionId);
    }
    if (replace) {
      // Select what is there, so the text replaces it instead of appending to a draft nobody meant.
      const selectAll = { key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 4 };
      await page.client.send('Input.dispatchKeyEvent', { type: 'keyDown', ...selectAll }, page.sessionId);
      await page.client.send('Input.dispatchKeyEvent', { type: 'keyUp', ...selectAll }, page.sessionId);
    }
    await page.client.send('Input.insertText', { text: typed }, page.sessionId);
    const heldNow = await controlText(page, control.objectId);
    if (heldNow.includes(typed) && (!replace || heldNow.trim() === typed.trim())) return { typed: true };
    await typeAsKeys(page, typed);
    const after = await controlText(page, control.objectId);
    return after.includes(typed.slice(0, 20))
      ? { typed: true }
      : { typed: false, reason: `LinkedIn's "${name}" still reads ${JSON.stringify(after.slice(0, 40))} after typing.` };
  }))) ?? { typed: false, reason: `LinkedIn shows no control named "${name}".` };
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

function pauseIdle(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
}

function keepWarm(): void {
  pauseIdle();
  if (!warm) return;
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
