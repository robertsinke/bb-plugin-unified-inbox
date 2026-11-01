// Capability lookup (Migration state 3): the one place that says which
// declared capability governs which action. Adapters consult it instead of
// testing the account name, so a source that cannot do something refuses it in
// the adapter, from its own declaration.
import type { ActionKind, Capabilities } from './types.ts';

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
