import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  adoptRunningBrowser,
  browserArgs,
  chromeStartupError,
  createCdpClient,
  linkedinChromePath,
  parseDevtoolsUrl,
  prewarmLinkedInBrowser,
  runningBrowserUrl,
  stopLinkedInBrowser,
  type CdpTransport,
} from '../src/linkedin-chrome.ts';

function fakeTransport() {
  const messages: string[] = [];
  const closeHandlers: (() => void)[] = [];
  let receive: (message: string) => void = () => {};
  const transport: CdpTransport = {
    send(message) { messages.push(message); },
    onMessage(handler) { receive = handler; },
    onClose(handler) { closeHandlers.push(handler); },
    close() { for (const handler of closeHandlers) handler(); },
  };
  return { transport, messages, reply: (message: unknown) => receive(JSON.stringify(message)), close: () => transport.close() };
}

test('Chrome announces its DevTools endpoint on stderr', () => {
  const line = 'DevTools listening on ws://127.0.0.1:51234/devtools/browser/1a2b-3c4d\n';
  assert.equal(parseDevtoolsUrl(line), 'ws://127.0.0.1:51234/devtools/browser/1a2b-3c4d');
  assert.equal(parseDevtoolsUrl('noise only'), undefined);
});

test('browser args isolate the profile and only expose DevTools when asked', () => {
  const headless = browserArgs({ profile: '/tmp/profile', url: 'about:blank', headless: true, debugging: true });
  assert.ok(headless.includes('--headless=new'));
  assert.ok(headless.includes('--remote-debugging-port=0'));
  assert.ok(headless.includes('--user-data-dir=/tmp/profile'));
  assert.equal(headless.at(-1), 'about:blank');

  const signIn = browserArgs({ profile: '/tmp/profile', url: 'https://www.linkedin.com/login', headless: false, debugging: false });
  assert.ok(!signIn.includes('--headless=new'));
  assert.ok(!signIn.some(arg => arg.startsWith('--remote-debugging-port')));
  assert.equal(signIn.at(-1), 'https://www.linkedin.com/login');
});

test('an explicit Chrome override wins and a wrong one is reported', () => {
  const directory = mkdtempSync(join(tmpdir(), 'linkedin-chrome-'));
  const binary = join(directory, 'chrome');
  writeFileSync(binary, '');
  process.env.UNIFIED_INBOX_CHROME = binary;
  try {
    assert.equal(linkedinChromePath(), binary);
    process.env.UNIFIED_INBOX_CHROME = join(directory, 'missing');
    assert.throws(() => linkedinChromePath(), /does not exist/);
  } finally {
    delete process.env.UNIFIED_INBOX_CHROME;
  }
});

test('CDP requests resolve by id and events keep their session', async () => {
  const { transport, messages, reply } = fakeTransport();
  const client = createCdpClient(transport);
  const seen: (string | undefined)[] = [];
  client.on('Page.loadEventFired', (_params, sessionId) => seen.push(sessionId));

  const created = client.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' });
  assert.deepEqual(JSON.parse(messages[0]), { id: 1, method: 'Target.createTarget', params: { url: 'about:blank' } });
  reply({ id: 1, result: { targetId: 'target-1' } });
  assert.deepEqual(await created, { targetId: 'target-1' });

  const attached = client.send('Target.attachToTarget', { targetId: 'target-1', flatten: true }, 'session-1');
  assert.equal(JSON.parse(messages[1]).sessionId, 'session-1');
  reply({ method: 'Page.loadEventFired', sessionId: 'session-1', params: {} });
  reply({ id: 2, error: { message: 'Target closed' } });
  await assert.rejects(attached, /Target closed/);
  assert.deepEqual(seen, ['session-1']);
});

test('a closed connection rejects in-flight work instead of hanging', async () => {
  const { transport, close } = fakeTransport();
  const client = createCdpClient(transport);
  const pending = client.send('Runtime.evaluate', { expression: '1' });
  client.close();
  await assert.rejects(pending, /connection closed/);
  assert.doesNotThrow(close);
});

test('a profile held by the sign-in window is reported as such, not as a crash', () => {
  const stderr = 'Failed to create .../SingletonLock: File exists (17)\nFailed to create a ProcessSingleton for your profile directory.';
  assert.throws(() => { throw chromeStartupError(stderr, 21); }, /Close the LinkedIn sign-in window/);
  assert.throws(() => { throw chromeStartupError('some other failure', 3); }, /\(code 3\): some other failure/);
});

test('prewarming is best effort and stopping an idle browser is safe', async () => {
  process.env.UNIFIED_INBOX_CHROME = '/nonexistent/chrome';
  process.env.UNIFIED_INBOX_LINKEDIN_PROFILE = join(mkdtempSync(join(tmpdir(), 'linkedin-profile-')), 'profile');
  try {
    await assert.doesNotReject(prewarmLinkedInBrowser());
    await assert.doesNotReject(stopLinkedInBrowser());
  } finally {
    delete process.env.UNIFIED_INBOX_CHROME;
    delete process.env.UNIFIED_INBOX_LINKEDIN_PROFILE;
  }
});

/** A profile as the plugin's own browser left it: it wrote its endpoint there when it started. */
function profileWithEndpoint(): string {
  const profile = mkdtempSync(join(tmpdir(), 'linkedin-profile-'));
  writeFileSync(join(profile, 'DevToolsActivePort'), '51234\n/devtools/browser/1a2b-3c4d\n');
  return profile;
}

/** A browser that answers every request with `version`, so adoption can be asked without a Chrome. */
function answeringBrowser(version: { product?: string; userAgent?: string }) {
  const sent: { method?: string }[] = [];
  let receive: (message: string) => void = () => {};
  const transport: CdpTransport = {
    send(message) {
      const request = JSON.parse(message) as { id: number; method: string };
      sent.push(request);
      receive(JSON.stringify({ id: request.id, result: version }));
    },
    onMessage(handler) { receive = handler; },
    onClose() {},
    close() {},
  };
  return { connect: async () => transport, sent };
}

test('the endpoint a browser wrote into the profile is the profile\'s ws url', () => {
  const profile = mkdtempSync(join(tmpdir(), 'linkedin-profile-'));
  // The sign-in window runs without remote debugging, so it leaves no endpoint behind.
  assert.equal(runningBrowserUrl(profile), undefined);
  writeFileSync(join(profile, 'DevToolsActivePort'), '51234\n/devtools/browser/1a2b-3c4d\n');
  assert.equal(runningBrowserUrl(profile), 'ws://127.0.0.1:51234/devtools/browser/1a2b-3c4d');
  writeFileSync(join(profile, 'DevToolsActivePort'), 'half written');
  assert.equal(runningBrowserUrl(profile), undefined);
});

test('a headless browser holding the profile is taken over, not replaced', async () => {
  const { connect, sent } = answeringBrowser({ product: 'HeadlessChrome/131.0.6778.85', userAgent: 'Mozilla/5.0 HeadlessChrome/131.0.6778.85' });
  const browser = await adoptRunningBrowser(profileWithEndpoint(), connect);
  assert.equal(browser?.alive, true);
  assert.equal(browser?.wsUrl, 'ws://127.0.0.1:51234/devtools/browser/1a2b-3c4d');
  await browser?.stop();
  // The browser is closed through the protocol: nothing here holds a child handle to signal.
  assert.deepEqual(sent.map(request => request.method), ['Browser.getVersion', 'Browser.close']);
});

test('a window the owner opened on the profile is left alone, not adopted', async () => {
  const { connect, sent } = answeringBrowser({ product: 'Chrome/131.0.6778.85', userAgent: 'Mozilla/5.0 (Macintosh) Chrome/131.0.6778.85 Safari/537.36' });
  assert.equal(await adoptRunningBrowser(profileWithEndpoint(), connect), undefined);
  assert.deepEqual(sent.map(request => request.method), ['Browser.getVersion']);
});

test('an endpoint with no browser behind it does not become a browser', async () => {
  const refused = async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:51234'); };
  assert.equal(await adoptRunningBrowser(profileWithEndpoint(), refused), undefined);
});
