// What the registry hands its adapters (Migration state 3). The transport builds
// these once per plugin instance: the shared cache, one transport per source, and
// the factory that turns a raw provider failure into a scrubbed ProviderError.
import type { createInboxCache } from '../inbox-cache.ts';
import type { GmailFaces } from '../gmail-faces.ts';
import type { ImsgSender } from '../imsg-send.ts';
import type { LinkedInPageSession } from '../linkedin-page-session.ts';
import type { Account, GmailAccount, GmailTransport, ProviderError, WhatsAppTransport } from './types.ts';

export type InboxCache = ReturnType<typeof createInboxCache>;

export interface RegistryDeps {
  cache: InboxCache;
  /** The Gmail transport: typed reads and sends, rejecting with the raw cause. */
  gmail: GmailTransport;
  /**
   * Where a Gmail row's contact photo comes from: the cached answer, and the ask behind the draw.
   * Per account, because each account has its own address book and its own grant.
   */
  gmailFaces: (account: GmailAccount) => GmailFaces;
  /** The WhatsApp transport: stored reads, and sends over the plugin's own socket. */
  whatsapp: WhatsAppTransport;
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
