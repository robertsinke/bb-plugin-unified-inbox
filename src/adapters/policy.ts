// INBOX-7 / spec T8: the policy layer. One gate in front of every adapter send,
// so "refused" means the adapter was never called rather than that a handler
// remembered to check a flag first. The gate owns the delivery call.
//
// What this is: one choke point and one audit trail. What it is not: containment.
// A local process can still reach the source directly; OQ-1 owns that boundary.
import type { Account, SendReceipt } from './types.ts';

/** One attempted send as the gate saw it: no body, no attachment bytes, ever. */
export interface AuditRow {
  at: number;
  operation: 'send';
  account: Account;
  conversationId: string;
  decision: 'allowed' | 'refused';
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

export interface SendGateDeps {
  now: () => number;
  audit: (row: AuditRow) => void;
}

export function createSendGate({ now, audit }: SendGateDeps) {
  /** The refusal record and the refusal itself, so a refusal can never skip its row. */
  function refuse(request: SendRequest, reason: string): never {
    audit({ at: now(), operation: 'send', account: request.account, conversationId: request.conversationId, decision: 'refused', reason });
    throw new Error(reason);
  }

  /** Deliver through `deliver` only when this attempt is allowed; the row is written either way. */
  return async function send(request: SendRequest, approval: SendApproval | undefined, deliver: () => Promise<SendReceipt>): Promise<SendReceipt> {
    if (!approval) refuse(request, 'A send needs an approval for the conversation it goes to; nothing was sent.');
    if (approval.conversationId !== request.conversationId) {
      refuse(request, `The approval does not cover this conversation: it was issued for ${approval.conversationId}, and this send names ${request.conversationId}. Nothing was sent.`);
    }
    const age = now() - approval.issuedAt;
    if (age > APPROVAL_WINDOW_MS) {
      refuse(request, `The approval expired: it is ${Math.round(age / 60_000)} minutes old, and a send approval lasts ${APPROVAL_WINDOW_MS / 60_000} minutes. Approve the send again; nothing was sent.`);
    }
    return deliver();
  };
}
