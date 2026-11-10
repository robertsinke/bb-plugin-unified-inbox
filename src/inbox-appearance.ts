import { accentToken, legacyGmailAccounts, type Account } from './adapters/types.ts';

/** Mailbox address → legacy id, filled from `mailbox_status` on this machine. Not written to git. */
const liveLegacy = new Map<string, string>();

export function setGmailAccentMap(legacy: Record<string, string>): void {
  liveLegacy.clear();
  for (const id of legacyGmailAccounts) {
    const address = legacy[id]?.trim().toLowerCase();
    if (address) liveLegacy.set(address, id);
  }
}

function accentFor(account: string): string {
  return liveLegacy.get(account.toLowerCase()) ?? accentToken(account);
}

/**
 * The one bubble every source draws. Width, radius, padding and time placement
 * live on this class in `chat.css`; a source may tint it, never restyle it, so a
 * reply reads the same whether it came from WhatsApp, Messages, LinkedIn or mail.
 */
export const BUBBLE_BASE = 'ui-bubble';

/**
 * The base plus the source accent. This is the only way the panel names a chat
 * bubble, which is what keeps a new source from inventing a second bubble
 * language: there is no other expression that produces the base.
 */
export function bubbleClass(account: Account): string {
  return `${BUBBLE_BASE} is-${accentFor(account)}`;
}

/** The class on a row avatar. The source-icon color rules are descendants of this token. */
export function sourceClass(account: Account): string {
  return `ui-${accentFor(account)}`;
}
