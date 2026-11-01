/**
 * The one seam between the LinkedIn adapter and the page: a typed read in, one expression out.
 *
 * This module owns both halves that used to be scattered: the expression each read builds
 * (`linkedinPageExpression`, `linkedinProbeExpression`) and the envelope the page answers
 * (`linkedinReadResult`). Evaluation stays outside — `evaluateInLinkedInProfile` and the Chrome
 * lifecycle are not this module's business — so the seam is testable without a browser.
 *
 * The page answers every read with `{ok, payload}` and the payload is always an object, never a
 * bare array. A page that failed throws here instead of handing back a half-empty payload, and a
 * conversation read refuses a non-conversation urn before the page is asked.
 */
import { isConversationId } from './linkedin-inbox.ts';
import { linkedinPageExpression } from './linkedin-page.ts';
import { linkedinProbeExpression } from './linkedin-probe.ts';

const SIGN_IN_HINT = 'Run `bb unified-inbox linkedin-signin` to sign in to LinkedIn once.';

/**
 * The list and probe payload: conversation rows and invitation rows. Row fields are narrowed by
 * `linkedin-inbox.ts` and `linkedin-probe.ts`, which own those shapes; this seam promises the
 * object and its row arrays, nothing about each row.
 */
export type LinkedInListPayload = {
  /** The signed-in member's mailbox urn, when the page reported one. */
  mailboxUrn?: string;
  conversations: unknown[];
  invitations: unknown[];
};

/** A conversation's messages, in the page's own order. */
export type LinkedInThreadPayload = { messages: unknown[] };

/** The probe answers a thinner version of the list payload under the same envelope. */
export type LinkedInProbePayload = LinkedInListPayload;

export interface LinkedInPageSession {
  list(): Promise<LinkedInListPayload>;
  thread(id: string): Promise<LinkedInThreadPayload>;
  probe(mailbox?: string): Promise<LinkedInProbePayload>;
}

/** Maps the page script's envelope to a payload, or to a message a person can act on. */
export function linkedinReadResult(value: unknown): unknown {
  // An array where the envelope belongs is the fault that once read as an empty inbox, so it is
  // refused here rather than unwrapped into data.
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`LinkedIn did not return a usable response. ${SIGN_IN_HINT}`);
  const result = value as { ok?: unknown; payload?: unknown; error?: unknown };
  if (result.ok === true) return result.payload;
  const reason = typeof result.error === 'string' ? result.error.slice(0, 200) : '';
  if (/LinkedIn (401|403)/.test(reason) || /not signed in/i.test(reason)) throw new Error(`LinkedIn needs you to sign in again. ${SIGN_IN_HINT}`);
  if (/LinkedIn \d+/.test(reason)) throw new Error(reason);
  throw new Error(`LinkedIn is unavailable in its browser. ${SIGN_IN_HINT}`);
}

/** The payload behind a successful envelope, refused when it is not an object. */
function payloadOf(value: unknown): Record<string, unknown> {
  const payload = linkedinReadResult(value);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error(`LinkedIn did not return a usable response. ${SIGN_IN_HINT}`);
  return payload as Record<string, unknown>;
}

/** The list and probe payload, refused when the page answered a payload without its row arrays. */
function listPayload(value: unknown): LinkedInListPayload {
  const payload = payloadOf(value);
  const { conversations, invitations } = payload;
  if (!Array.isArray(conversations) || !Array.isArray(invitations)) throw new Error(`LinkedIn did not return a usable response. ${SIGN_IN_HINT}`);
  return { ...(typeof payload.mailboxUrn === 'string' ? { mailboxUrn: payload.mailboxUrn } : {}), conversations, invitations };
}

function threadPayload(value: unknown): LinkedInThreadPayload {
  const payload = payloadOf(value);
  if (!Array.isArray(payload.messages)) throw new Error(`LinkedIn did not return a usable response. ${SIGN_IN_HINT}`);
  return { messages: payload.messages };
}

/**
 * One session over whatever evaluates expression strings in the signed-in LinkedIn page. Each
 * read is one expression and one round trip; the caller never sees the envelope or the script.
 */
export function createLinkedInPageSession(evaluate: (expression: string) => Promise<unknown>): LinkedInPageSession {
  return {
    async list() {
      return listPayload(await evaluate(linkedinPageExpression({ mode: 'list' })));
    },
    async thread(id: string) {
      // The boundary is the urn, not the caller: nothing that is not a conversation reaches the page.
      if (!isConversationId(id)) throw new Error('That LinkedIn conversation cannot be opened.');
      return threadPayload(await evaluate(linkedinPageExpression({ mode: 'thread', id })));
    },
    async probe(mailbox?: string) {
      return listPayload(await evaluate(linkedinProbeExpression(mailbox)));
    },
  };
}
