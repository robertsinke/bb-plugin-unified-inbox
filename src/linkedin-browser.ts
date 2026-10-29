import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { linkedinPageScript, linkedinRunOutput, type LinkedInRead } from './linkedin-page';

const exec = promisify(execFile);

/**
 * Runs the LinkedIn read inside the running BB browser, so the session stays where it was
 * created and only the BB CLI is needed. One desktop automation session is opened for the
 * read and released afterwards; the LinkedIn tab itself is reused between reads.
 */
export async function readInBrowser(read: LinkedInRead): Promise<unknown> {
  const host = await browserHost();
  const instance = await desktopInstance(host);
  let session: string | undefined;
  try {
    session = await openSession(host, instance);
    const script = `const page = await browser.getPage("main");\nconst here = page.url() || "";\nif (!here.startsWith("https://www.linkedin.com/")) await page.goto("https://www.linkedin.com/feed/");\n${linkedinPageScript(read)}`;
    const { stdout } = await exec('bb', ['browser-automation', 'run', session, '--script', script, '--json'], { timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
    const result = linkedinRunOutput(stdout) as { ok?: boolean; payload?: unknown; error?: unknown };
    if (result?.ok === true) return result.payload;
    const reason = typeof result?.error === 'string' ? result.error : '';
    if (/LinkedIn 401|LinkedIn 403|not signed in/.test(reason)) throw new Error('LinkedIn needs you to sign in again in the BB browser.');
    throw new Error(reason.startsWith('LinkedIn ') ? reason : 'LinkedIn is unavailable. Open LinkedIn in the BB browser and stay signed in.');
  } finally {
    if (session) await exec('bb', ['browser-automation', 'close', session, '--json'], { timeout: 60000 }).catch(() => undefined);
  }
}

async function json(args: string[]): Promise<any> {
  const { stdout } = await exec('bb', args, { timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
  return JSON.parse(stdout);
}

async function browserHost(): Promise<string> {
  const found = JSON.stringify(await json(['status', '--json'])).match(/"hostId"\s*:\s*"([^"]+)"/);
  if (!found) throw new Error('LinkedIn needs the BB browser, which this machine has not reported.');
  return found[1];
}

async function desktopInstance(host: string): Promise<string> {
  const listed = await json(['browser', 'instances', '--host', host, '--json']);
  const instance = (listed.instances ?? [])[0]?.instanceId;
  if (typeof instance !== 'string') throw new Error('LinkedIn needs an open BB browser window. Open one and try again.');
  return instance;
}

async function openSession(host: string, instance: string): Promise<string> {
  const opened = await json(['browser-automation', 'open', '--backend', 'desktop', '--machine', host, '--desktop', instance, '--json']);
  if (typeof opened.id !== 'string') throw new Error('LinkedIn needs an open BB browser window. Open one and try again.');
  return opened.id;
}
