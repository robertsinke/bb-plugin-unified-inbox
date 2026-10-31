// The adapter registry (Migration state 3): which object answers for which
// account. server.ts asks the registry; it never tests the account name to
// decide behaviour. A new source is a new adapter plus a capability
// declaration, not a new branch in the transport.
import type { RegistryDeps } from './deps.ts';
import { createGmailAdapter } from './gmail.ts';
import { createIMessageAdapter } from './imessage.ts';
import { createLinkedInAdapter } from './linkedin.ts';
import { createWhatsAppAdapter } from './whatsapp.ts';
import { accounts } from './types.ts';
import type { Account, Adapter, Capabilities } from './types.ts';

export type { InboxCache, RegistryDeps } from './deps.ts';
export { accounts } from './types.ts';

/** One adapter per account, every account covered. */
export function createRegistry(deps: RegistryDeps): Record<Account, Adapter> {
  return {
    personal: createGmailAdapter(deps, 'personal'),
    business: createGmailAdapter(deps, 'business'),
    whatsapp: createWhatsAppAdapter(deps),
    imessage: createIMessageAdapter(deps),
    linkedin: createLinkedInAdapter(deps),
  };
}

/** Every adapter's declared capabilities, keyed as the `capabilities` RPC returns them. */
export function registryCapabilities(registry: Record<Account, Adapter>): Record<Account, Capabilities> {
  return Object.fromEntries(accounts.map(account => [account, registry[account].capabilities()])) as Record<Account, Capabilities>;
}
