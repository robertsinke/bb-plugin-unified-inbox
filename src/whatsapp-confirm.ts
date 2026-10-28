import { createHash } from 'node:crypto';

/** SHA-256 of the trimmed text, matching WhatsAgent's approval hash. */
export function approvalHash(text: string): string {
  return createHash('sha256').update(text.trim()).digest('hex');
}

/** Newest inbound message id. Items are chronological, newest last. */
export function latestInboundId(items: readonly { id?: unknown; from_me?: unknown }[]): string | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (!item || item.from_me) continue;
    if (typeof item.id === 'string' && item.id) return item.id;
  }
  return undefined;
}

/** Loopback frontend confirm call. The bearer token is never attached. */
export function confirmProposalRequest(port: number, proposalId: number, baseHash: string, latestInboundId: string | undefined): { url: string; origin: string; body: { base_hash: string; confirmed_latest_inbound_id?: string } } {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid WhatsAgent connection');
  if (!Number.isInteger(proposalId) || proposalId <= 0) throw new Error('Invalid proposal');
  const origin = `http://127.0.0.1:${port}`;
  return {
    url: `${origin}/api/proposals/${proposalId}/confirm`,
    origin,
    body: { base_hash: baseHash, ...(latestInboundId ? { confirmed_latest_inbound_id: latestInboundId } : {}) },
  };
}
