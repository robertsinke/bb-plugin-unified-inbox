// INBOX-7 / spec T8: the policy layer. One gate in front of every adapter send,
// so "refused" means the adapter was never called rather than that a handler
// remembered to check a flag first. The gate owns the delivery call.
//
// What this is: one choke point and one audit trail. What it is not: containment.
// A local process can still reach the source directly; OQ-1 owns that boundary.
import { randomUUID } from 'node:crypto';
import type { Account, SendReceipt } from './types.ts';

/** One attempted send as the gate saw it: no body, no attachment bytes, ever. */
export interface AuditRow {
  at: number;
  operation: 'send';
  account: Account;
  conversationId: string;
  decision: 'allowed' | 'refused';
  /**
   * Which approval this attempt spent. It is an id, never the text: it is what lets
   * spend survive a reload, so a restart cannot revive an approval already used.
   */
  approvalId?: string;
  /** Why a refusal happened, in words a person can read. */
  reason?: string;
}

/** How long one approval stays good. One number, here, so no call site can widen it. */
export const APPROVAL_WINDOW_MS = 5 * 60_000;

/** What the caller says it is allowed to send, and to what. */
export interface SendApproval {
  /** One use only: a second attempt with the same id is a replay. */
  id: string;
  /** The one conversation this approval covers. */
  conversationId: string;
  issuedAt: number;
}

export interface SendRequest {
  account: Account;
  conversationId: string;
  text: string;
}

/** Whether a source may send at all, and why not when it may not. */
export type SendPolicy = { state: 'enabled' } | { state: 'disabled'; reason: string };

/**
 * The owner's decisions as rules the gate reads, so a handler holds no flag of its own.
 * Chat sending was enabled on 2026-11-02 — Messages by explicit request, WhatsApp through
 * the owner's own composer, LinkedIn replies. Gmail stays off until its boundary is
 * verified, and a disabled reason is the caller-facing refusal text.
 */
export const SEND_POLICY: Record<Account, SendPolicy> = {
  personal: { state: 'disabled', reason: 'Gmail sending is not enabled yet. Your draft has not been sent.' },
  business: { state: 'disabled', reason: 'Gmail sending is not enabled yet. Your draft has not been sent.' },
  whatsapp: { state: 'enabled' },
  imessage: { state: 'enabled' },
  linkedin: { state: 'enabled' },
};

/**
 * Where attempts are written and where spend is read back. In the plugin this is the
 * `inbox_send_audit` table, which is why a reload cannot revive a spent approval.
 */
export interface SendAuditStore {
  record(row: AuditRow): void;
  /** Whether this approval was already spent by an earlier attempt, this run or before it. */
  hasSpent(approvalId: string): boolean;
}

export interface SendGateDeps {
  now: () => number;
  store: SendAuditStore;
}

/**
 * The approval a caller's explicit statement earns, or none at all.
 *
 * `allow: 'send'` is the one word the RPC surface has for "yes, this one" — the LinkedIn page
 * driver uses the same word for its irreversible click — so a reply that does not carry it
 * reaches the gate with no approval and is refused and recorded there. This mints the approval;
 * the gate still decides.
 *
 * Honest limit: the transport takes the caller's word for it. The RPC layer validates the send
 * itself (the adapter's write builder, the composer path) but issues no token, so these rules are
 * a choke point and a record, not proof of identity — a host-issued token is containment, which
 * OQ-1 owns. When one arrives, it replaces this value and the gate is unchanged.
 */
export function approvalFor(allow: 'send' | undefined, conversationId: string, at: number): SendApproval | undefined {
  return allow === 'send' ? { id: randomUUID(), conversationId, issuedAt: at } : undefined;
}

export function createSendGate({ now, store }: SendGateDeps) {
  /** The refusal record and the refusal itself, so a refusal can never skip its row. */
  function refuse(request: SendRequest, reason: string, approval?: SendApproval): never {
    store.record({ at: now(), operation: 'send', account: request.account, conversationId: request.conversationId, decision: 'refused', reason, ...(approval ? { approvalId: approval.id } : {}) });
    throw new Error(reason);
  }

  /** Deliver through `deliver` only when this attempt is allowed; the row is written either way. */
  return async function send(request: SendRequest, approval: SendApproval | undefined, deliver: () => Promise<SendReceipt>): Promise<SendReceipt> {
    const policy = SEND_POLICY[request.account];
    if (policy.state === 'disabled') refuse(request, policy.reason);
    if (!approval) refuse(request, 'A send needs an approval for the conversation it goes to; nothing was sent.');
    if (approval.conversationId !== request.conversationId) {
      refuse(request, `The approval does not cover this conversation: it was issued for ${approval.conversationId}, and this send names ${request.conversationId}. Nothing was sent.`);
    }
    const age = now() - approval.issuedAt;
    if (age > APPROVAL_WINDOW_MS) {
      refuse(request, `The approval expired: it is ${Math.round(age / 60_000)} minutes old, and a send approval lasts ${APPROVAL_WINDOW_MS / 60_000} minutes. Approve the send again; nothing was sent.`);
    }
    if (store.hasSpent(approval.id)) {
      refuse(request, 'The approval has already been used; one approval sends one message. Approve this send again; nothing was sent.', approval);
    }
    // Written before delivery, with the approval it spends: a delivery that throws must
    // not leave the approval usable for a retry, which is how one approval becomes two
    // messages. The row is the spend, so a reload cannot undo it.
    store.record({ at: now(), operation: 'send', account: request.account, conversationId: request.conversationId, decision: 'allowed', approvalId: approval.id });
    return deliver();
  };
}
