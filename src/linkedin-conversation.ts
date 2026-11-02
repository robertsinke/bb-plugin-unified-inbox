/**
 * One LinkedIn conversation id, parsed in one place.
 *
 * LinkedIn names a conversation three ways, and only one of them says everything:
 *
 *   - the full urn — `urn:li:msg_conversation:(<mailbox urn>,<key>)` — which the inbox rows, the
 *     stored cache, a send approval and a replayed write all carry;
 *   - the short key — the `2-…` inside the parentheses — which a thread URL names and a send
 *     approval may arrive as;
 *   - a message urn — `urn:li:msg_message:(urn:li:msg_conversation:(…),<key>)` — which *contains*
 *     the conversation substring but is not a conversation. A substring test cannot tell the two
 *     apart, so the inbox read used to list messages as conversations.
 *
 * So the rule here is the full urn, and every other shape is derived from it: the key is read out
 * of it, and an id that is already a key is passed through unchanged (which is what makes
 * `conversationKeyOf` idempotent). Anything unrecognised is passed through too, or refused — never
 * rewritten into something that might match.
 *
 * The in-page filters in `linkedin-page.ts` and `linkedin-probe.ts` cannot import this module, so
 * they build their regex from `CONVERSATION_URN_SOURCE`. That source *is* the rule; it is not a
 * second copy of it.
 */

/**
 * The longest id any caller may hand us. This id reaches a GraphQL variable, a REST body and a
 * url, and a real urn observed from LinkedIn is ~150 characters, so the bound is a refusal of the
 * nonsense rather than a fit to a real value.
 */
const ID_LIMIT = 512;

/**
 * The urn pattern, as source text so the page expressions can rebuild it.
 *
 * The leading lookahead bounds the length, so the bound cannot be forgotten by a caller that only
 * has the source. `[\s\S]` rather than `.` for the bound: it must not depend on a line terminator
 * the rest of the pattern already refuses. The mailbox is a member's `fsd_profile` or a page's
 * `fsd_company` — the same pair the page read's `identityKey` recognises — and the key is the
 * `2-…` a thread URL carries.
 */
export const CONVERSATION_URN_SOURCE = `^(?=[\\s\\S]{1,${ID_LIMIT}}$)urn:li:msg_conversation:\\((urn:li:fsd_(?:profile|company):[^,()\\s]+),([^,()\\s]+)\\)$`;

const CONVERSATION_URN = new RegExp(CONVERSATION_URN_SOURCE);

/** A conversation id read down to what a caller compares or sends: its mailbox and its short key. */
export type ConversationId = { urn: string; mailbox: string; key: string };

/** The conversation a full urn names, or null for any other value. */
export function parseConversation(value: unknown): ConversationId | null {
  if (typeof value !== 'string') return null;
  const match = CONVERSATION_URN.exec(value);
  return match ? { urn: value, mailbox: match[1], key: match[2] } : null;
}

/** True when the value is a full conversation urn this plugin can act on. */
export function isConversationUrn(value: unknown): value is string {
  return parseConversation(value) !== null;
}

/** The mailbox the conversation urn belongs to, or the empty string. */
export function conversationMailboxOf(value: unknown): string {
  return parseConversation(value)?.mailbox ?? '';
}

/**
 * The short conversation key a thread URL names — the `2-…` inside a full urn's parentheses. A
 * thread URL carries the key alone; a cached row carries the full urn; a send approval may arrive
 * as either, so both are read down to the key before they are compared. Anything this does not
 * recognise is passed through unchanged, so an unrecognised value can only fail the comparison,
 * never pass it by transformation.
 */
export function conversationKeyOf(value: unknown): string {
  if (typeof value !== 'string') return '';
  return parseConversation(value)?.key ?? value;
}
