// What the registry hands its adapters (Migration state 3). The transport builds
// these once per plugin instance: the shared cache, one runner per source, and
// the factory that turns a raw provider failure into a scrubbed ProviderError.
import type { createInboxCache } from '../inbox-cache.ts';
import type { ImsgSender } from '../imsg-send.ts';
import type { LinkedInRead } from '../linkedin-page.ts';
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
  /** One in-page LinkedIn read: the conversation list, or one thread. */
  readLinkedIn: (read: LinkedInRead) => Promise<unknown>;
  /** The provider-error factory: classification and redaction, never raw stderr. */
  providerError: (account: Account, source: ProviderError['source'], cause: unknown) => ProviderError;
}
