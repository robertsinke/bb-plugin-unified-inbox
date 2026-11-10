/**
 * The one seam between the LinkedIn adapter and the page: typed reads and writes in, one expression
 * out.
 *
 * This module owns the expressions and the envelopes that used to be scattered through the adapter:
 * the expression each read builds (`linkedinPageExpression`, `linkedinProbeExpression`), the write a
 * recording replays (`replayWriteExpression`), the recorder's dump and clear, and every answer each
 * of them returns. Evaluation stays outside — `evaluateInLinkedInProfile` and the Chrome lifecycle
 * are not this module's business — so the seam is testable without a browser.
 *
 * The page answers every read with `{ok, payload}` and the payload is always an object, never a
 * bare array. A page that failed throws here instead of handing back a half-empty payload, and a
 * conversation read refuses a non-conversation urn before the page is asked.
 *
 * A write is answered with `{ok, status, body}` or with nothing this module recognizes; an answer it
 * cannot read is refused here rather than cast into "not accepted, status 0".
 */
import { isConversationId } from './linkedin-inbox.ts';
import { linkedinPageExpression, linkedinPostExpression } from './linkedin-page.ts';
import { linkedinProbeExpression } from './linkedin-probe.ts';
import {
  clearRecordedWritesExpression,
  recordedWritesExpression,
  recorderStatsExpression,
  replayWriteExpression,
  writeBytes,
  LINKEDIN_WRITE_KEEP,
  LINKEDIN_WRITE_LIMIT,
  type RecordedWrite,
} from './linkedin-write.ts';

const SIGN_IN_HINT = 'Run `bb unified-inbox linkedin-signin` to sign in to LinkedIn once.';

/**
 * The list and probe payload: conversation rows and invitation rows. Row fields are narrowed by
 * `linkedin-inbox.ts` and `linkedin-probe.ts`, which own those shapes; this seam promises the
 * object and its row arrays, nothing about each row.
 */
export type LinkedInListPayload = {
  /** The signed-in member's mailbox urn, when the page reported one. */
  mailboxUrn?: string;
  conversations: unknown[];
  invitations: unknown[];
};

/** A conversation's messages, in the page's own order. */
export type LinkedInThreadPayload = { messages: unknown[] };

/** The probe answers a thinner version of the list payload under the same envelope. */
export type LinkedInProbePayload = LinkedInListPayload;

/**
 * One older page: the conversation rows, and where the one after it begins. An empty `nextCursor`
 * is the page saying the walk ends here — it is not a failure, and it is not a cursor.
 */
export type LinkedInOlderPayload = { conversations: unknown[]; nextCursor: string };

/**
 * What a replayed write came back as: whether it landed, with the status the page reported. A
 * refusal is an outcome, not a throw — the caller phrases the reason in its own words.
 */
export type ReplayOutcome = { accepted: true; status: number } | { accepted: false; status: number };

/** How often the recorder's wrappers were called, and why they rejected anything they saw. */
export type LinkedInRecorderStats = {
  fetch: number;
  xhr: number;
  considered: number;
  skipped: Record<string, number>;
  pushed?: number;
  stored?: number;
  last?: string;
  same?: boolean;
};

/** What the recorder kept, newest first, and what its wrappers saw. */
export type LinkedInRecorder = { writes: RecordedWrite[]; seen: LinkedInRecorderStats | null };

export type LinkedInPost = { title: string; author: string; imageUrl: string };

export interface LinkedInPageSession {
  list(): Promise<LinkedInListPayload>;
  thread(id: string): Promise<LinkedInThreadPayload>;
  /** One shared post: its words, its author, and a CDN image URL when the update has one. */
  post(activityUrn: string): Promise<LinkedInPost>;
  /** One page of conversations older than a cursor; the payload says where the next one begins. */
  older(cursor: string, count: number): Promise<LinkedInOlderPayload>;
  probe(mailbox?: string): Promise<LinkedInProbePayload>;
  /** Replays one recorded write once; a refusal is an outcome, an unreadable answer an error. */
  replay(write: RecordedWrite): Promise<ReplayOutcome>;
  /** What the recorder kept, and whether it was watching at all. */
  recorded(): Promise<LinkedInRecorder>;
  /** Empties the recorder, so the page keeps no log of what it watched. */
  clearRecorded(): Promise<void>;
}

/** Maps the page script's envelope to a payload, or to a message a person can act on. */
export function linkedinReadResult(value: unknown): unknown {
  // An array where the envelope belongs is the fault that once read as an empty inbox, so it is
  // refused here rather than unwrapped into data.
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`LinkedIn did not return a usable response. ${SIGN_IN_HINT}`);
  const result = value as { ok?: unknown; payload?: unknown; error?: unknown };
  if (result.ok === true) return result.payload;
  const reason = typeof result.error === 'string' ? result.error.slice(0, 200) : '';
  // The refresh worker matches this sentence and retries within seconds. A 401 still asks for sign-in.
  if (/\b(?:ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|UND_ERR_|NetworkError|Failed to fetch|fetch failed|Load failed)\b/.test(reason)) {
    throw new Error('LinkedIn could not reach the network.');
  }
  if (/LinkedIn (401|403)/.test(reason) || /not signed in/i.test(reason)) throw new Error(`LinkedIn needs you to sign in again. ${SIGN_IN_HINT}`);
  if (/LinkedIn \d+/.test(reason)) throw new Error(reason);
  throw new Error('LinkedIn is unavailable in its browser.');
}

/** The payload behind a successful envelope, refused when it is not an object. */
function payloadOf(value: unknown): Record<string, unknown> {
  const payload = linkedinReadResult(value);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error(`LinkedIn did not return a usable response. ${SIGN_IN_HINT}`);
  return payload as Record<string, unknown>;
}

/** The list and probe payload, refused when the page answered a payload without its row arrays. */
function listPayload(value: unknown): LinkedInListPayload {
  const payload = payloadOf(value);
  const { conversations, invitations } = payload;
  if (!Array.isArray(conversations) || !Array.isArray(invitations)) throw new Error(`LinkedIn did not return a usable response. ${SIGN_IN_HINT}`);
  return { ...(typeof payload.mailboxUrn === 'string' ? { mailboxUrn: payload.mailboxUrn } : {}), conversations, invitations };
}

function postPayload(value: unknown): LinkedInPost {
  const payload = payloadOf(value);
  return {
    title: typeof payload.title === 'string' ? payload.title : '',
    author: typeof payload.author === 'string' ? payload.author : '',
    imageUrl: typeof payload.imageUrl === 'string' ? payload.imageUrl : '',
  };
}

function threadPayload(value: unknown): LinkedInThreadPayload {
  const payload = payloadOf(value);
  if (!Array.isArray(payload.messages)) throw new Error(`LinkedIn did not return a usable response. ${SIGN_IN_HINT}`);
  return { messages: payload.messages };
}

function olderPayload(value: unknown): LinkedInOlderPayload {
  const payload = payloadOf(value);
  if (!Array.isArray(payload.conversations) || typeof payload.nextCursor !== 'string') throw new Error(`LinkedIn did not return a usable response. ${SIGN_IN_HINT}`);
  return { conversations: payload.conversations, nextCursor: payload.nextCursor };
}

/**
 * The outcome behind a replay's answer, refused unless the page said both what it did and with which
 * status. `true`, `null`, `{}`, `{ok: 'yes'}` and `{ok: true, status: 'HTTP 200'}` are broken
 * answers, not refusals: reading them as "not accepted, status 0" invents a reason for a failure
 * that may never have happened.
 */
function replayOutcome(value: unknown): ReplayOutcome {
  const answer = value && typeof value === 'object' && !Array.isArray(value) ? value as { ok?: unknown; status?: unknown } : null;
  const status = answer?.status;
  if (typeof answer?.ok !== 'boolean' || typeof status !== 'number' || !Number.isInteger(status) || status < 0) {
    throw new Error('LinkedIn did not return a usable answer to that write, so whether it landed is unknown; check the conversation before trying again.');
  }
  return answer.ok ? { accepted: true, status } : { accepted: false, status };
}

/** A page's count, or zero: the recorder's bookkeeping is diagnostic, never load-bearing. */
const counted = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0);

/** The recorder's own report, refused only when it is not an object at all. */
function recorderStats(value: unknown): LinkedInRecorderStats | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const seen = value as Record<string, unknown>;
  const skipped: Record<string, number> = {};
  if (seen.skipped && typeof seen.skipped === 'object' && !Array.isArray(seen.skipped)) {
    for (const [reason, times] of Object.entries(seen.skipped as Record<string, unknown>)) if (typeof times === 'number') skipped[reason] = counted(times);
  }
  const stats: LinkedInRecorderStats = { fetch: counted(seen.fetch), xhr: counted(seen.xhr), considered: counted(seen.considered), skipped };
  if (typeof seen.pushed === 'number') stats.pushed = counted(seen.pushed);
  if (typeof seen.stored === 'number') stats.stored = counted(seen.stored);
  if (typeof seen.last === 'string') stats.last = seen.last.slice(0, 512);
  if (typeof seen.same === 'boolean') stats.same = seen.same;
  return stats;
}

/** The page hands back whatever it stored; only well-formed, bounded writes leave this module. */
function recordedWrites(value: unknown): RecordedWrite[] {
  const rows = Array.isArray(value) ? value : [];
  return rows.flatMap(row => {
    if (!row || typeof row !== 'object') return [];
    const write = row as Partial<RecordedWrite>;
    if (typeof write.method !== 'string' || typeof write.url !== 'string' || typeof write.body !== 'string') return [];
    if (!/^[A-Z]{3,7}$/.test(write.method)) return [];
    if (writeBytes(write.body) > LINKEDIN_WRITE_LIMIT) return [];
    return [{ method: write.method, url: write.url.slice(0, 2048), body: write.body, capturedAt: Number(write.capturedAt) || 0 }];
  }).slice(-LINKEDIN_WRITE_KEEP);
}

/** The writes behind a dump's answer; a bare array is not one, so it reads as nothing recorded. */
function dumpedWrites(value: unknown): RecordedWrite[] {
  const answer = value && typeof value === 'object' && !Array.isArray(value) ? value as { writes?: unknown } : {};
  return recordedWrites(answer.writes);
}

/**
 * One session over whatever evaluates expression strings in the signed-in LinkedIn page. Each method
 * builds its own expression and parses its own answer; the caller never sees either.
 */
export function createLinkedInPageSession(
  evaluate: (expression: string) => Promise<unknown>,
  evaluateListRead: (expression: string) => Promise<unknown> = evaluate,
): LinkedInPageSession {
  return {
    async list() {
      return listPayload(await evaluateListRead(linkedinPageExpression({ mode: 'list' })));
    },
    async thread(id: string) {
      // The boundary is the urn, not the caller: nothing that is not a conversation reaches the page.
      if (!isConversationId(id)) throw new Error('That LinkedIn conversation cannot be opened.');
      return threadPayload(await evaluate(linkedinPageExpression({ mode: 'thread', id })));
    },
    async post(activityUrn: string) {
      // The expression throws before evaluate when the urn is not an activity, so a bad id never reaches the page.
      return postPayload(await evaluate(linkedinPostExpression(activityUrn)));
    },
    /** One page further back. The cursor is the adapter's, and the page read refuses one it cannot quote. */
    async older(cursor: string, count: number) {
      return olderPayload(await evaluateListRead(linkedinPageExpression({ mode: 'older', cursor, count })));
    },
    async probe(mailbox?: string) {
      return listPayload(await evaluateListRead(linkedinProbeExpression(mailbox)));
    },
    async replay(write: RecordedWrite) {
      // The expression is built first, so a write that cannot be replayed never reaches the page.
      return replayOutcome(await evaluate(replayWriteExpression(write)));
    },
    async recorded() {
      const writes = dumpedWrites(await evaluate(recordedWritesExpression()));
      return { writes, seen: recorderStats(await evaluate(recorderStatsExpression())) };
    },
    async clearRecorded() {
      // The answer names how many writes went; nothing reads it, so only the page is asked.
      await evaluate(clearRecordedWritesExpression());
    },
  };
}
