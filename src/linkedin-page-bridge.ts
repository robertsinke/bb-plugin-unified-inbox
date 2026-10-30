import { linkedinPageExpression, type LinkedInRead } from './linkedin-page.ts';
import { isConversationId } from './linkedin-inbox.ts';

type BrowserPage = {
  evaluate(expression: string, options?: { world?: 'isolated' | 'main' }): Promise<unknown>;
};
type RegisteredPage = { url: string; page: BrowserPage };

const pages = new Map<string, RegisteredPage>();
const LINKEDIN_URL = /^https:\/\/www\.linkedin\.com(?:\/|$)/i;

export function isLinkedInPageUrl(url: string): boolean { return LINKEDIN_URL.test(url); }

export function registerLinkedInPage(tabId: string, url: string, page: BrowserPage | null): () => void {
  if (!page || !isLinkedInPageUrl(url)) return () => {};
  const registered = { url, page };
  pages.set(tabId, registered);
  return () => {
    if (pages.get(tabId) === registered) pages.delete(tabId);
  };
}

export async function readLinkedInPage(page: BrowserPage, url: string, read: LinkedInRead): Promise<unknown> {
  if (read.mode === 'thread' && !isConversationId(read.id)) throw new Error('That LinkedIn conversation cannot be opened.');
  if (!isLinkedInPageUrl(url)) {
    // The browser-page API is tab-scoped; callers should use a registered LinkedIn tab.
    throw new Error('Open LinkedIn in a BB Browser tab before syncing. The inbox will not open or focus a browser.');
  }
  return readResult(await page.evaluate(linkedinPageExpression(read), { world: 'isolated' }));
}

export async function readRegisteredLinkedInPage(read: LinkedInRead): Promise<unknown> {
  const candidates = [...pages.values()].filter(candidate => isLinkedInPageUrl(candidate.url));
  if (!candidates.length) throw new Error('Open LinkedIn in a BB Browser tab before syncing. The inbox will not open or focus a browser.');
  if (candidates.length > 1) throw new Error('Several LinkedIn tabs are open. Use the sync button on the intended tab.');
  return readLinkedInPage(candidates[0].page, candidates[0].url, read);
}

function readResult(value: unknown): unknown {
  if (!value || typeof value !== 'object') throw new Error('LinkedIn did not return a usable response.');
  const result = value as { ok?: unknown; payload?: unknown; error?: unknown };
  if (result.ok === true) return result.payload;
  const reason = typeof result.error === 'string' && result.error.startsWith('LinkedIn ')
    ? result.error.slice(0, 200)
    : 'LinkedIn is unavailable in this browser tab.';
  throw new Error(reason);
}
