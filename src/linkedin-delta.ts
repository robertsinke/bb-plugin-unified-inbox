/**
 * The LinkedIn delta decision, pure: a stored marker in, `skip` or `read` out.
 *
 * Nothing here reads a browser or the cache, so the rule that decides whether a refresh
 * can keep the cached rows is testable on its own. The marker rides in the existing
 * `inbox_sync` cursor column, so it needs no schema of its own.
 */
import { linkedinMailboxUrn, type LinkedInProbe } from './linkedin-probe.ts';

/** Bumped when the marker's meaning changes, which turns every stored marker back into a full read. */
export const LINKEDIN_MARKER_PREFIX = 'linkedin-v1';

const FIELDS = ['newestActivityAt', 'unreadTotal', 'conversationCount', 'newestInvitationAt', 'invitationCount', 'unreadInvitations'] as const;

export type LinkedInReadReason =
  | 'forced'
  | 'probe'
  | 'first-run'
  | 'marker'
  | 'newest-activity'
  | 'unread-total'
  | 'conversations'
  | 'invitations';

export type LinkedInDelta = { action: 'skip' } | { action: 'read'; reason: LinkedInReadReason };

/**
 * The marker string to store after a probe, or after a full read made from that probe. The
 * member's mailbox rides along so the next probe needs no identity request; it is state about
 * the session, never part of what the comparison checks.
 */
export function linkedinMarker(probe: LinkedInProbe, mailbox?: string): string {
  const marker = Object.fromEntries(FIELDS.map(field => [field, probe[field]]));
  const urn = linkedinMailboxUrn(mailbox);
  return `${LINKEDIN_MARKER_PREFIX}:${JSON.stringify(urn ? { ...marker, mailboxUrn: urn } : marker)}`;
}

/** The mailbox a stored marker remembers, or the empty string, which makes the probe ask who it is. */
export function linkedinMarkerMailbox(stored: string | null | undefined): string {
  if (typeof stored !== 'string' || !stored.startsWith(`${LINKEDIN_MARKER_PREFIX}:`)) return '';
  try {
    const parsed = JSON.parse(stored.slice(LINKEDIN_MARKER_PREFIX.length + 1)) as { mailboxUrn?: unknown };
    return linkedinMailboxUrn(parsed?.mailboxUrn);
  } catch {
    return '';
  }
}

/**
 * The stored marker, or null when it is absent, from another version, or not a marker at all.
 * A broken marker is never trusted: the caller reads in full instead of skipping.
 */
export function parseLinkedInMarker(stored: string | null | undefined): LinkedInProbe | null {
  if (typeof stored !== 'string' || !stored.startsWith(`${LINKEDIN_MARKER_PREFIX}:`)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored.slice(LINKEDIN_MARKER_PREFIX.length + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const probe = {} as LinkedInProbe;
  for (const field of FIELDS) {
    const value = (parsed as Record<string, unknown>)[field];
    // A marker is only as good as its numbers: a missing or nonsense field means "read".
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
    probe[field] = value;
  }
  return probe;
}

/**
 * decide:
 *
 * | force | probe | stored marker      | action |
 * |-------|-------|--------------------|--------|
 * | yes   | any   | any                | read (forced) |
 * | no    | none  | any                | read (probe): no evidence, no skip |
 * | no    | yes   | absent             | read (first-run) |
 * | no    | yes   | unusable           | read (marker) |
 * | no    | yes   | newest activity moved | read (newest-activity) |
 * | no    | yes   | unread total moved | read (unread-total) |
 * | no    | yes   | conversation count moved | read (conversations) |
 * | no    | yes   | invitations moved | read (invitations) |
 * | no    | yes   | identical          | skip |
 */
export function linkedinDelta(input: { stored?: string | null; probe?: LinkedInProbe | null; force?: boolean }): LinkedInDelta {
  if (input.force === true) return { action: 'read', reason: 'forced' };
  if (!input.probe) return { action: 'read', reason: 'probe' };
  if (input.stored == null) return { action: 'read', reason: 'first-run' };
  const marker = parseLinkedInMarker(input.stored);
  if (!marker) return { action: 'read', reason: 'marker' };
  if (input.probe.newestActivityAt !== marker.newestActivityAt) return { action: 'read', reason: 'newest-activity' };
  if (input.probe.unreadTotal !== marker.unreadTotal) return { action: 'read', reason: 'unread-total' };
  if (input.probe.conversationCount !== marker.conversationCount) return { action: 'read', reason: 'conversations' };
  // Invitations are inbox rows too, so a new one, a dropped one, or a seen-then-unseen change reads.
  if (input.probe.newestInvitationAt !== marker.newestInvitationAt
    || input.probe.invitationCount !== marker.invitationCount
    || input.probe.unreadInvitations !== marker.unreadInvitations) return { action: 'read', reason: 'invitations' };
  return { action: 'skip' };
}
