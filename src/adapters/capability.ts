// Capability lookup (Migration state 3): the one place that says which
// declared capability governs which action. Adapters consult it instead of
// testing the account name, so a source that cannot do something refuses it in
// the adapter, from its own declaration.
import { z } from 'zod';
import type { ActionKind, Capabilities } from './types.ts';

/**
 * The capabilities a source declares, named once. Everything that has to know the
 * set reads this list: `Capabilities` is keyed by it, `NO_CAPABILITIES` and
 * `capabilitiesSchema` are built from it, and a declaration that leaves one out is
 * a type error. Adding a capability is one entry here plus the adapters that declare
 * it `true` — never another hand-kept list.
 *
 * - `send`: the source sends at all (gmail, whatsapp, imessage; the policy layer
 *   keeps gmail disabled).
 * - `markRead`: read/unread is a state the source keeps.
 * - `archive`: the source has a place to move a conversation out of the inbox.
 * - `invitations`: pending invitations can be answered (accept / ignore) from here.
 * - `media`: pictures, stickers and video can be read.
 * - `attachments`: files attached to a message can be listed and fetched.
 * - `threads`: the conversation is a thread of messages, read top to bottom and
 *   answered in a composer, rather than opened as a document and answered in a
 *   mail form.
 * - `followsList`: re-reading one conversation is cheap enough that the open thread
 *   may follow a list refresh. A source whose read is expensive declares false and
 *   keeps what it showed until reopened.
 */
export const CAPABILITY_KEYS = ['send', 'markRead', 'archive', 'invitations', 'media', 'attachments', 'threads', 'followsList'] as const;

export type CapabilityKey = (typeof CAPABILITY_KEYS)[number];

/**
 * Nothing is known before a source declares it, or if asking failed, so no control is
 * offered. Derived from the list, so a capability added there arrives false.
 */
export const NO_CAPABILITIES = Object.fromEntries(
  CAPABILITY_KEYS.map(key => [key, false]),
) as Record<CapabilityKey, boolean>;

/**
 * The gateway's view of one declaration, built from the same list as the type.
 * Strict: a declaration that invents a capability is refused here, rather than
 * travelling to the UI unread.
 */
export const capabilitiesSchema = z.strictObject({
  ...Object.fromEntries(CAPABILITY_KEYS.map(key => [key, z.boolean()])) as Record<CapabilityKey, z.ZodBoolean>,
  search: z.boolean().optional(),
});

/**
 * The capability flag behind each state-changing action. Deliberately partial:
 * `reply` (and LinkedIn's `confirm` / `reject`, which answer an invitation) is a
 * surface the source implements or does not — it is not a boolean the UI offers.
 */
const STATE_ACTION: Partial<Record<ActionKind, 'markRead' | 'archive'>> = {
  read: 'markRead',
  unread: 'markRead',
  archive: 'archive',
};

/** Whether these capabilities cover a state-changing action; `false` is why an adapter refuses it. */
export function canChange(capabilities: Capabilities, kind: ActionKind): boolean {
  const flag = STATE_ACTION[kind];
  return flag !== undefined && capabilities[flag];
}

