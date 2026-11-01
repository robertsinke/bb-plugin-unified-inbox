// What the registry hands its adapters (Migration state 3). The transport builds
// these once per plugin instance: the shared cache, one runner per source, and
// the factory that turns a raw provider failure into a scrubbed ProviderError.
import type { createInboxCache } from '../inbox-cache.ts';
import type { ImsgSender } from '../imsg-send.ts';
import type { LinkedInPageSession } from '../linkedin-page-session.ts';
import type { Account, ProviderError } from './types.ts';
import type { GwsRunner } from './gws.ts';
import type { WhatsAgentClient } from './whatsagent.ts';

export type InboxCache = ReturnType<typeof createInboxCache>;

export interface RegistryDeps {
  cache: InboxCache;
  /** The Gmail CLI runner: parsed reads and sends, rejecting with the raw cause. */
  gmail: GwsRunner;
  whatsapp: WhatsAgentClient;
  imsg: ImsgSender;
  /** One LinkedIn page session: the reads, the change probe, the recorder, and a write replay. */
  linkedInPage: LinkedInPageSession;
  /**
   * Arms the write recorder so it survives a page load. The page reloads, because an app that
   * captured `fetch` at boot can only be watched by a wrapper that was there first.
   */
  armLinkedInRecorder: () => Promise<unknown>;
  /** The provider-error factory: classification and redaction, never raw stderr. */
  providerError: (account: Account, source: ProviderError['source'], cause: unknown) => ProviderError;
}
