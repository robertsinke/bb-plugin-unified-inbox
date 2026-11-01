// What the inbox offers one source, asked of its capability declaration rather
// than its account name (slice B2). The gateway returns the declarations the
// adapters make (`capabilities` RPC); these rules read that answer, so a new
// source needs a declaration, not a new branch in app.tsx.
//
// Pure: no React and no DOM, so the rules are testable in Node while the jsdom
// render harness arrives in slice G.
import type { Account, Capabilities } from './adapters/types.ts';

/** Declarations keyed as the `capabilities` RPC returns them. */
export type CapabilityMap = Record<Account, Capabilities>;

/** Nothing is known before the declarations arrive, or if asking for them failed: offer no control. */
const UNKNOWN: Capabilities = { send: false, markRead: false, archive: false, invitations: false, media: false, attachments: false, threads: false, followsList: false };

function declared(capabilities: CapabilityMap | null, account: Account): Capabilities {
  return capabilities?.[account] ?? UNKNOWN;
}

/**
 * Whether the box may send. Drafting does not need this — a draft is kept on this
 * machine for every source — so a source without `send` still gets the box, and
 * only the send control disappears.
 */
export function canSend(capabilities: CapabilityMap | null, account: Account): boolean {
  return declared(capabilities, account).send;
}

/** The read/unread toggle, and the read the inbox marks when a conversation is opened. */
export function canMarkRead(capabilities: CapabilityMap | null, account: Account): boolean {
  return declared(capabilities, account).markRead;
}

/** Answering a pending invitation: accept or ignore, from the invitation's own row. */
export function canAnswerInvitation(capabilities: CapabilityMap | null, account: Account): boolean {
  return declared(capabilities, account).invitations;
}

/** Archive, which only a source with a place to move a conversation out of the inbox can offer. */
export function canArchive(capabilities: CapabilityMap | null, account: Account): boolean {
  return declared(capabilities, account).archive;
}

/**
 * Whether the conversation is read as a thread and answered in a composer. A source that opens a
 * document instead keeps its own reading surface, so the composer is not offered for it.
 */
export function hasThread(capabilities: CapabilityMap | null, account: Account): boolean {
  return declared(capabilities, account).threads;
}

/**
 * Whether the open conversation may be re-read when a refresh changes its row. A source whose
 * read is expensive declares false, and what it already showed stays until the thread is reopened.
 */
export function followsList(capabilities: CapabilityMap | null, account: Account): boolean {
  return declared(capabilities, account).followsList;
}
