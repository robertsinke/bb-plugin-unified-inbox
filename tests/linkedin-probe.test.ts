import assert from 'node:assert/strict';
import test from 'node:test';
import { linkedinProbe, linkedinProbeExpression } from '../src/linkedin-probe.ts';

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (...args: string[]) => Function;

const expression = linkedinProbeExpression();

test('probe expression compiles and reads only through the same authenticated same-origin fetch', () => {
  assert.doesNotThrow(() => new AsyncFunction(`return (${expression});`));
  assert.match(expression, /credentials: 'include'/);
  assert.match(expression, /'csrf-token'/);
  assert.match(expression, /messengerConversations\./);
  assert.doesNotMatch(expression, /\.goto\(|browser\.getPage|document\.cookie\s*=/);
});

test('probe makes three requests and resolves no names, avatars, or message bodies', () => {
  // Session check, the conversation window, and the invitation view — nothing per participant.
  assert.equal(expression.match(/await get\(/g)?.length, 3);
  assert.doesNotMatch(expression, /identity\/dash\/profiles|organization\/companies|avatarOf|nameOf/);
  assert.doesNotMatch(expression, /messengerMessages|body\?\.text|renderContent/);
});

test('the probe reports the newest activity and the totals the change check compares', () => {
  const probe = linkedinProbe({
    conversations: [
      { at: 1_700_000_000_000, unread: 0 },
      { at: 1_760_000_000_000, unread: 3 },
      { at: 1_690_000_000_000, unread: 2 },
    ],
    invitations: [
      { at: 1_750_000_000_000, unread: true },
      { at: 1_740_000_000_000, unread: false },
    ],
  });
  assert.deepEqual(probe, {
    newestActivityAt: 1_760_000_000_000,
    unreadTotal: 5,
    conversationCount: 3,
    newestInvitationAt: 1_750_000_000_000,
    invitationCount: 2,
    unreadInvitations: 1,
  });
});

test('an empty inbox and a thinner payload both count as zero rather than throwing', () => {
  assert.deepEqual(linkedinProbe({ conversations: [], invitations: [] }), {
    newestActivityAt: 0, unreadTotal: 0, conversationCount: 0, newestInvitationAt: 0, invitationCount: 0, unreadInvitations: 0,
  });
  assert.equal(linkedinProbe(null).conversationCount, 0);
  assert.deepEqual(linkedinProbe({ conversations: 'nope', invitations: [null, 7] }).invitationCount, 0);
});

/** Runs the real expression against a fake page: three same-origin GETs, no other global needed. */
async function runProbe(replies: (url: string) => { status: number; body: unknown }) {
  const seen: { url: string; headers: Record<string, string>; credentials?: string }[] = [];
  const fetchStub = async (url: string, init: { headers: Record<string, string>; credentials?: string }) => {
    seen.push({ url, headers: init.headers, credentials: init.credentials });
    const reply = replies(url);
    return { ok: reply.status === 200, status: reply.status, text: async () => JSON.stringify(reply.body) };
  };
  const evaluate = new AsyncFunction('fetch', 'document', `return (${expression});`);
  return { result: await evaluate(fetchStub, { cookie: 'JSESSIONID="token-1"' }), seen };
}

test('the probe asks for the conversation window and invitation view under the session csrf token', async () => {
  const { result, seen } = await runProbe(url => {
    if (url === '/voyager/api/me') return { status: 200, body: { data: { '*miniProfile': 'urn:li:fs_miniProfile:ME' } } };
    if (url.includes('messengerConversations')) {
      return { status: 200, body: { included: [
        { entityUrn: 'urn:li:msg_conversation:1', lastActivityAt: 1000, unreadCount: 2 },
        { entityUrn: 'urn:li:msg_conversation:2', lastActivityAt: 2000, unreadCount: 0 },
      ] } };
    }
    return { status: 200, body: { included: [{ $type: 'com.linkedin.voyager.relationships.invitation.Invitation', sentTime: 3000, unseen: true }] } };
  });

  assert.deepEqual(result, {
    ok: true,
    payload: {
      conversations: [{ at: 1000, unread: 2 }, { at: 2000, unread: 0 }],
      invitations: [{ at: 3000, unread: true }],
    },
  });
  assert.equal(seen.length, 3);
  assert.ok(seen.every(request => request.credentials === 'include' && request.headers['csrf-token'] === 'token-1'));
  assert.ok(seen[1].url.includes('mailboxUrn:urn%3Ali%3Afsd_profile%3AME'));
  assert.deepEqual(linkedinProbe((result as { payload: unknown }).payload), {
    newestActivityAt: 2000, unreadTotal: 2, conversationCount: 2, newestInvitationAt: 3000, invitationCount: 1, unreadInvitations: 1,
  });
});

test('a rejected probe reports a LinkedIn status and never returns half a marker', async () => {
  const { result } = await runProbe(() => ({ status: 401, body: {} }));
  assert.deepEqual(result, { ok: false, error: 'LinkedIn 401 for /voyager/api/me' });
  assert.deepEqual(linkedinProbe(undefined), { newestActivityAt: 0, unreadTotal: 0, conversationCount: 0, newestInvitationAt: 0, invitationCount: 0, unreadInvitations: 0 });
});

test('nonsense numbers in a payload never produce a negative or NaN marker', () => {
  const probe = linkedinProbe({
    conversations: [{ at: 'yesterday', unread: -4 }, { at: -1, unread: 'x' }, { at: 42.9, unread: 1.8 }],
    invitations: [{ at: -5, unread: 'true' }],
  });
  assert.equal(probe.newestActivityAt, 42.9);
  assert.equal(probe.unreadTotal, 1);
  assert.equal(probe.newestInvitationAt, 0);
  assert.equal(probe.unreadInvitations, 0);
  assert.equal(probe.conversationCount, 3);
});
