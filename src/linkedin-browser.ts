import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { linkedinPageScript, linkedinRunOutput, type LinkedInRead } from './linkedin-page';

const exec = promisify(execFile);
const BB_CLI = process.env.BB_CLI || '/Applications/bb.app/Contents/Resources/app.asar.unpacked/node_modules/bb-app/host-daemon/dist/bb';

/**
 * Runs the LinkedIn read inside the running BB browser, so the session stays where it was
 * created and only the BB CLI is needed. One desktop automation session is opened for the
 * read and released afterwards; the LinkedIn tab itself is reused between reads.
 */
export async function readInBrowser(read: LinkedInRead, threadId?: string): Promise<unknown> {
  if (!threadId || !/^thr_[a-z0-9]+$/.test(threadId)) throw new Error('LinkedIn needs the current BB thread context to use its browser.');
  const host = await browserHost();
  const instance = await desktopInstance(host);
  let session: string | undefined;
  try {
    session = await openSession(host, instance, threadId);
    const script = `const page = await browser.getPage("main");\nconst here = page.url() || "";\nif (!here.startsWith("https://www.linkedin.com/")) await page.goto("https://www.linkedin.com/feed/");\n${linkedinPageScript(read)}`;
    const { stdout } = await exec(BB_CLI, ['browser-automation', 'run', session, '--thread', threadId, '--script', script, '--json'], { timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
    const result = linkedinRunOutput(stdout) as { ok?: boolean; payload?: unknown; error?: unknown };
    if (result?.ok === true) return result.payload;
    const reason = typeof result?.error === 'string' ? result.error : '';
    if (/LinkedIn 401|LinkedIn 403|not signed in/.test(reason)) throw new Error('LinkedIn needs you to sign in again in the BB browser.');
    throw new Error(reason.startsWith('LinkedIn ') ? reason : 'LinkedIn is unavailable. Open LinkedIn in the BB browser and stay signed in.');
  } finally {
    if (session) await exec(BB_CLI, ['browser-automation', 'close', session, '--thread', threadId, '--json'], { timeout: 60000 }).catch(() => undefined);
  }
}

async function json(args: string[]): Promise<any> {
  try {
    const { stdout } = await exec(BB_CLI, args, { timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
    return JSON.parse(stdout);
  } catch (error) {
    const stderr = (error as NodeJS.ErrnoException & { stderr?: string }).stderr;
    throw new Error(stderr?.trim().slice(0, 180) || (error instanceof Error ? error.message.slice(0, 180) : 'BB command failed'));
  }
}

async function browserHost(): Promise<string> {
  const status = JSON.stringify(await json(['status', '--json']));
  const current = status.match(/"hostId"\s*:\s*"([^"]+)"/);
  if (current) return current[1];

  // Global plugin processes may not inherit the invoking thread's BB_THREAD_ID, so
  // `bb status` has no current host. Find a connected host that actually has a BB window.
  const machines = await json(['machine', 'list', '--json']);
  for (const machine of machines) {
    if (machine.status !== 'connected' || typeof machine.id !== 'string') continue;
    try {
      const { instances } = await json(['browser', 'instances', '--host', machine.id, '--json']);
      if (instances?.length) return machine.id;
    } catch { /* try the next connected host */ }
  }
  throw new Error('LinkedIn needs an open BB browser window. Open one and try again.');
}

async function desktopInstance(host: string): Promise<string> {
  const listed = await json(['browser', 'instances', '--host', host, '--json']);
  const instance = (listed.instances ?? [])[0]?.instanceId;
  if (typeof instance !== 'string') throw new Error('LinkedIn needs an open BB browser window. Open one and try again.');
  return instance;
}

async function openSession(host: string, instance: string, threadId: string): Promise<string> {
  const opened = await json(['browser-automation', 'open', '--backend', 'desktop', '--machine', host, '--desktop', instance, '--thread', threadId, '--json']);
  if (typeof opened.id !== 'string') throw new Error('LinkedIn needs an open BB browser window. Open one and try again.');
  return opened.id;
}
