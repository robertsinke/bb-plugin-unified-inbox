// What a failed WhatsApp send attempt means (lifted from WhatsAgent's outbox/failure.ts).
//
// - `offline`   the send never left this process: there is no socket. No packet reached WhatsApp.
// - `terminal`  WhatsApp, or Baileys' own payload validation, rejected it in a way a repeat cannot change.
// - `transient` everything else: the outcome is unknown, so the panel must say so rather than pretend.
//
// 4xx is not "rejected": Baileys reuses the HTTP status space for connection lifecycle
// (`DisconnectReason`), so a bare rule would permanently fail every send attempted across a reconnect.
// Sources, all in `node_modules/baileys/lib`: 408 timedOut/connectionLost (`Utils/generics.js`),
// 411 multideviceMismatch, 428 connectionClosed (`Socket/socket.js`), 440 connectionReplaced,
// 429 rate limited.
import { WhatsAppDisconnectedError } from './send.ts';

export type SendFailureKind = 'offline' | 'terminal' | 'transient';

const TRANSIENT_STATUS = new Set([408, 411, 428, 429, 440]);

function statusCodeOf(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const candidate = error as { status?: number; statusCode?: number; output?: { statusCode?: number } };
  return candidate.output?.statusCode ?? candidate.statusCode ?? candidate.status;
}

/**
 * Deliberate polarity: **unknown means retry is safe**, so the panel reports an unknown outcome
 * instead of claiming a failure. Guessing `terminal` on an unrecognised error tells the owner a
 * message that may have arrived did not.
 */
export function classifySendFailure(error: unknown): SendFailureKind {
  if (error instanceof WhatsAppDisconnectedError) return 'offline';
  const status = statusCodeOf(error);
  if (status === undefined) return 'transient';
  if (TRANSIENT_STATUS.has(status)) return 'transient';
  return status >= 400 && status < 500 ? 'terminal' : 'transient';
}

/** Owner-facing failure reason; trimmed so one bad throw cannot bloat a row. */
export function failureMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (!collapsed) return 'Send failed';
  return collapsed.length > 300 ? `${collapsed.slice(0, 299)}…` : collapsed;
}
