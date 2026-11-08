// The adapter registry (Migration state 3): which object answers for which
// account. server.ts asks the registry; it never tests the account name to
// decide behaviour. A new source is a new adapter plus a capability
// declaration, not a new branch in the transport.
import type { RegistryDeps } from './deps.ts';
import { createGmailAdapter } from './gmail.ts';
import { createIMessageAdapter } from './imessage.ts';
import { createLinkedInAdapter } from './linkedin.ts';
import { createWhatsAppAdapter } from './whatsapp.ts';
import { legacyGmailAccounts } from './types.ts';
import type { Account, Adapter, Capabilities, SourceMap } from './types.ts';

export type { InboxCache, RegistryDeps } from './deps.ts';
export { accounts } from './types.ts';

/**
 * One adapter per account the process is serving. Gmail ids are the credential
 * files still registered; the default keeps the two legacy slots for callers
 * that have not listed the credential directory.
 */
export function createRegistry(deps: RegistryDeps, gmailIds: readonly string[] = legacyGmailAccounts): Record<Account, Adapter> {
  const registry: Record<Account, Adapter> = {};
  for (const id of gmailIds) registry[id] = createGmailAdapter(deps, id);
  registry.whatsapp = createWhatsAppAdapter(deps);
  registry.imessage = createIMessageAdapter(deps);
  registry.linkedin = createLinkedInAdapter(deps);
  return registry;
}

/** Every adapter's declared capabilities, keyed as the `capabilities` RPC returns them. */
export function registryCapabilities(registry: Record<Account, Adapter>): Record<Account, Capabilities> {
  return Object.fromEntries(Object.entries(registry).map(([account, adapter]) => [account, adapter.capabilities()]));
}

/** Every adapter's declaration, keyed as the `sources` RPC returns them. */
export function registrySources(registry: Record<Account, Adapter>): SourceMap {
  return Object.fromEntries(Object.entries(registry).map(([account, adapter]) => [account, adapter.source]));
}
