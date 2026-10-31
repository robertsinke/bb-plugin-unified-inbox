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
const UNKNOWN: Capabilities = { send: false, markRead: false, archive: false, media: false, attachments: false };

function declared(capabilities: CapabilityMap | null, account: Account): Capabilities {
  return capabilities?.[account] ?? UNKNOWN;
}

/**
 * A box to write a reply into. `send` is the source's own ability to send; Gmail
 * declares it too, for the mail draft form, and its inline chat composer never
 * appears because mail conversations do not render in the chat layout.
 */
export function canCompose(capabilities: CapabilityMap | null, account: Account): boolean {
  return declared(capabilities, account).send;
}

/** The read/unread toggle, and the read the inbox marks when a conversation is opened. */
export function canMarkRead(capabilities: CapabilityMap | null, account: Account): boolean {
  return declared(capabilities, account).markRead;
}

/** Archive, which only a source with a place to move a conversation out of the inbox can offer. */
export function canArchive(capabilities: CapabilityMap | null, account: Account): boolean {
  return declared(capabilities, account).archive;
}
