import { accentToken, type Account } from './adapters/types.ts';

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
  return `${BUBBLE_BASE} is-${accentToken(account)}`;
}

/** The class on a row avatar. The source-icon color rules are descendants of this token. */
export function sourceClass(account: Account): string {
  return `ui-${accentToken(account)}`;
}
