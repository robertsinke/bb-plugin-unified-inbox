import { CONVERSATION_URN_SOURCE } from './linkedin-conversation.ts';

/**
 * The LinkedIn change probe: a second in-page read that answers one question —
 * "did anything the inbox shows move since the marker was stored?"
 *
 * It deliberately does none of the work the full read does: no participant or
 * invitation display names, no avatars, no message bodies, no thread opens. The
 * page only reports the timestamps and counters a change check needs, and the
 * arithmetic (newest, totals) happens here in TypeScript so it is testable
 * without a browser.
 */
export type LinkedInProbe = {
  /** Newest conversation `lastActivityAt`: any new message moves it. */
  newestActivityAt: number;
  /** Sum of conversation `unreadCount`: a read/unread change moves it. */
  unreadTotal: number;
  /** Rows in the conversation window: a row added or dropped moves it. */
  conversationCount: number;
  /** Newest invitation `sentTime`: a new pending invitation moves it. */
  newestInvitationAt: number;
  invitationCount: number;
  /** Invitations still marked `unseen`: the row's unread flag in the full read. */
  unreadInvitations: number;
};

export const EMPTY_LINKEDIN_PROBE: LinkedInProbe = {
  newestActivityAt: 0,
  unreadTotal: 0,
  conversationCount: 0,
  newestInvitationAt: 0,
  invitationCount: 0,
  unreadInvitations: 0,
};

/**
 * Same pinned query the inbox read uses; a build that changed the hash answers 400 and the
 * caller falls back to the full read. Kept in step with `linkedin-page.ts`.
 */
const CONVERSATIONS_QUERY = 'messengerConversations.0d5e6781bbee71c3e51c8843c6519f48';
const INVITATIONS_PATH = '/voyager/api/relationships/invitationViews?q=receivedInvitation&start=0&count=20';

/** The signed-in member's own `fsd_profile` urn, which the conversations query needs. */
const MAILBOX = /^urn:li:fsd_profile:[A-Za-z0-9_-]{1,80}$/;

/**
 * A mailbox urn safe to inject, or the empty string. The pattern is the whole guard: anything
 * else would be script text rather than an argument, so a stranger never becomes code.
 */
export function linkedinMailboxUrn(value: unknown): string {
  return typeof value === 'string' && MAILBOX.test(value) ? value : '';
}

/** The page body, given whatever mailbox the caller already knows (empty string asks the page). */
const body = (mailboxUrn: string) => `
    const enc = u => encodeURIComponent(u).replace(/\\(/g, '%28').replace(/\\)/g, '%29');
    const pair = (document.cookie.split('; ').find(c => c.startsWith('JSESSIONID=')) || '').split('=')[1] || '';
    const headers = { 'csrf-token': decodeURIComponent(pair).replace(/^"|"$/g, ''), accept: 'application/vnd.linkedin.normalized+json+2.1', 'x-restli-protocol-version': '2.0.0' };
    const get = async url => { const response = await fetch(url, { headers, credentials: 'include' }); if (!response.ok) throw new Error('LinkedIn ' + response.status + ' for ' + url.split('?')[0]); return JSON.parse(await response.text()); };
    const time = value => { const number = Number(value); return Number.isFinite(number) && number > 0 ? number : 0; };
    // The shared pattern, not the msg_conversation substring: a message urn contains that
    // substring and is not a conversation.
    const conversationUrn = new RegExp(${JSON.stringify(CONVERSATION_URN_SOURCE)});
    const counter = value => { const number = Math.floor(Number(value)); return Number.isFinite(number) && number > 0 ? number : 0; };

    // A remembered mailbox saves the identity round trip; invitations start immediately either way,
    // so the probe is one round of two parallel requests, not three in a row.
    // Started early but settled here, so a failure is this read's error and never an unhandled one.
    const invites = get('${INVITATIONS_PATH}').then(value => ({ value }), error => ({ error }));
    let mailboxUrn = '${mailboxUrn}';
    if (!mailboxUrn) {
      const me = await get('/voyager/api/me');
      const meRef = String(me.data?.['*miniProfile'] || (me.included || []).find(e => /miniProfile/.test(String(e.$type || '')))?.entityUrn || '');
      if (!/^urn:li:fs_miniProfile:/.test(meRef)) throw new Error('LinkedIn session is not signed in');
      mailboxUrn = meRef.replace('fs_miniProfile', 'fsd_profile');
    }

    const inbox = await get('/voyager/api/voyagerMessagingGraphQL/graphql?queryId=${CONVERSATIONS_QUERY}&variables=(mailboxUrn:' + enc(mailboxUrn) + ')');
    const conversations = (inbox.included || [])
      .filter(e => conversationUrn.test(String(e.entityUrn || '')))
      .map(e => ({ at: time(e.lastActivityAt), unread: counter(e.unreadCount) }));

    const settled = await invites;
    if (settled.error) throw settled.error;
    const invitations = (settled.value.included || [])
      .filter(e => /relationships\\.invitation\\.Invitation$/.test(String(e.$type || '')))
      .map(e => ({ at: time(e.sentTime), unread: e.unseen === true }));

    return { conversations, invitations, mailboxUrn };
`;

/** Expression for BB's Browser-page API; evaluates in the already-open LinkedIn tab. */
export function linkedinProbeExpression(mailbox?: string): string {
  // Whatever the caller remembers is injected into an evaluated script, so it is re-validated here.
  const mailboxUrn = linkedinMailboxUrn(mailbox);
  return `(async () => {
  try {
    const payload = await (async () => {${body(mailboxUrn)}})();
    return { ok: true, payload };
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error).split(String.fromCharCode(10))[0] };
  }
})()`;
}

function rows(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((row): row is Record<string, unknown> => !!row && typeof row === 'object') : [];
}

function at(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function count(value: unknown): number {
  const number = Math.floor(Number(value));
  return Number.isFinite(number) && number > 0 ? number : 0;
}

/**
 * The marker a probe produces. Anything the payload does not carry reads as zero, so a source
 * that answers a thinner payload still yields a usable marker instead of throwing.
 */
export function linkedinProbe(payload: unknown): LinkedInProbe {
  const probe = (payload && typeof payload === 'object' ? payload : {}) as { conversations?: unknown; invitations?: unknown };
  const conversations = rows(probe.conversations);
  const invitations = rows(probe.invitations);
  return {
    newestActivityAt: conversations.reduce((newest, row) => Math.max(newest, at(row.at)), 0),
    unreadTotal: conversations.reduce((total, row) => total + count(row.unread), 0),
    conversationCount: conversations.length,
    newestInvitationAt: invitations.reduce((newest, row) => Math.max(newest, at(row.at)), 0),
    invitationCount: invitations.length,
    unreadInvitations: invitations.filter(row => row.unread === true).length,
  };
}
