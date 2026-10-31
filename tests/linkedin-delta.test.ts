import assert from 'node:assert/strict';
import test from 'node:test';
import { LINKEDIN_MARKER_PREFIX, linkedinDelta, linkedinMarker, parseLinkedInMarker } from '../src/linkedin-delta.ts';
import { EMPTY_LINKEDIN_PROBE, type LinkedInProbe } from '../src/linkedin-probe.ts';

const probe: LinkedInProbe = {
  newestActivityAt: 1_760_000_000_000,
  unreadTotal: 3,
  conversationCount: 20,
  newestInvitationAt: 1_750_000_000_000,
  invitationCount: 4,
  unreadInvitations: 1,
};

const stored = linkedinMarker(probe);

test('the marker survives a round trip and rejects anything it did not write', () => {
  assert.deepEqual(parseLinkedInMarker(stored), probe);
  assert.ok(stored.startsWith(`${LINKEDIN_MARKER_PREFIX}:`));
  assert.equal(parseLinkedInMarker(null), null);
  assert.equal(parseLinkedInMarker(undefined), null);
  assert.equal(parseLinkedInMarker(''), null);
});

test('first run reads in full: no marker has been stored yet', () => {
  assert.deepEqual(linkedinDelta({ stored: null, probe }), { action: 'read', reason: 'first-run' });
});

test('unchanged activity, unread total, and invitations skip the full read', () => {
  assert.deepEqual(linkedinDelta({ stored, probe: { ...probe } }), { action: 'skip' });
});

test('newest activity moved reads: a new message in the newest conversation', () => {
  assert.deepEqual(linkedinDelta({ stored, probe: { ...probe, newestActivityAt: probe.newestActivityAt + 1 } }), { action: 'read', reason: 'newest-activity' });
});

test('unread total moved reads: a conversation was read or went unread', () => {
  assert.deepEqual(linkedinDelta({ stored, probe: { ...probe, unreadTotal: probe.unreadTotal - 1 } }), { action: 'read', reason: 'unread-total' });
});

test('a conversation row appearing or dropping reads', () => {
  assert.deepEqual(linkedinDelta({ stored, probe: { ...probe, conversationCount: probe.conversationCount + 1 } }), { action: 'read', reason: 'conversations' });
});

test('a new invitation, a dropped one, or one seen for the first time reads', () => {
  // Invitations are inbox rows of their own; they do not move the conversation window.
  assert.deepEqual(linkedinDelta({ stored, probe: { ...probe, newestInvitationAt: probe.newestInvitationAt + 1 } }), { action: 'read', reason: 'invitations' });
  assert.deepEqual(linkedinDelta({ stored, probe: { ...probe, invitationCount: probe.invitationCount - 1 } }), { action: 'read', reason: 'invitations' });
  assert.deepEqual(linkedinDelta({ stored, probe: { ...probe, unreadInvitations: 0 } }), { action: 'read', reason: 'invitations' });
});

test('a forced refresh reads even when the probe agrees with the marker', () => {
  assert.deepEqual(linkedinDelta({ stored, probe: { ...probe }, force: true }), { action: 'read', reason: 'forced' });
  assert.deepEqual(linkedinDelta({ stored, probe: null, force: true }), { action: 'read', reason: 'forced' });
});

test('a malformed marker never skips: it falls back to a full read', () => {
  const broken = [
    'not a marker at all',
    `${LINKEDIN_MARKER_PREFIX}:not json`,
    `${LINKEDIN_MARKER_PREFIX}:null`,
    `${LINKEDIN_MARKER_PREFIX}:[]`,
    `${LINKEDIN_MARKER_PREFIX}:{}`,
    `${LINKEDIN_MARKER_PREFIX}:{"newestActivityAt":1,"unreadTotal":0,"conversationCount":20,"newestInvitationAt":0,"invitationCount":0}`,
    `${LINKEDIN_MARKER_PREFIX}:{"newestActivityAt":"1","unreadTotal":0,"conversationCount":20,"newestInvitationAt":0,"invitationCount":0,"unreadInvitations":0}`,
    `${LINKEDIN_MARKER_PREFIX}:{"newestActivityAt":1,"unreadTotal":-1,"conversationCount":20,"newestInvitationAt":0,"invitationCount":0,"unreadInvitations":0}`,
    'some-other-source-v1:{"historyId":"123"}',
  ];
  for (const value of broken) {
    assert.deepEqual(linkedinDelta({ stored: value, probe }), { action: 'read', reason: 'marker' }, value);
  }
});

test('a marker whose fields happened to match an empty probe still reads when it is malformed', () => {
  // The dangerous case: junk that looks unchanged. Absent evidence must not skip.
  const junk = `${LINKEDIN_MARKER_PREFIX}:${JSON.stringify({ ...EMPTY_LINKEDIN_PROBE, newestActivityAt: 'now' })}`;
  assert.deepEqual(linkedinDelta({ stored: junk, probe: EMPTY_LINKEDIN_PROBE }), { action: 'read', reason: 'marker' });
});

test('no probe means no evidence, so the refresh reads', () => {
  assert.deepEqual(linkedinDelta({ stored, probe: null }), { action: 'read', reason: 'probe' });
});
