import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CONVERSATION_URN_SOURCE,
  conversationKeyOf,
  conversationMailboxOf,
  isConversationUrn,
  parseConversation,
} from '../src/linkedin-conversation.ts';
import { isConversationId } from '../src/linkedin-inbox.ts';
import { conversationKeyOf as conversationKeyFromUi } from '../src/linkedin-ui.ts';
import { isMessageSend, linkedinSendWrite } from '../src/linkedin-write.ts';
import { linkedinPageExpression } from '../src/linkedin-page.ts';
import { linkedinProbeExpression } from '../src/linkedin-probe.ts';

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (...args: string[]) => Function;

const MAILBOX = 'urn:li:fsd_profile:ACoAAme';
const KEY = '2-YWJj';
const URN = `urn:li:msg_conversation:(${MAILBOX},${KEY})`;
const OTHER_URN = 'urn:li:msg_conversation:(urn:li:fsd_profile:OTHER,2-ZZZ)';
/** LinkedIn's message urn wraps the conversation urn; it contains the substring but is a message. */
const MESSAGE_URN = `urn:li:msg_message:(${URN},2-ZGVm)`;
const OVER_LONG = `urn:li:msg_conversation:(${MAILBOX},2-${'x'.repeat(600)})`;

/**
 * The shapes one conversation id arrives in, and what the one rule makes of each. Every module that
 * parses an id is checked against this table, so a module that grows its own idea of the shape
 * fails here rather than in a send.
 */
const SHAPES: Array<{ name: string; value: string; urn: boolean; key: string; mailbox: string }> = [
  { name: 'a thread url', value: `/messaging/thread/${KEY}`, urn: false, key: `/messaging/thread/${KEY}`, mailbox: '' },
  { name: 'a full urn', value: URN, urn: true, key: KEY, mailbox: MAILBOX },
  { name: 'a urn with another mailbox', value: OTHER_URN, urn: true, key: '2-ZZZ', mailbox: 'urn:li:fsd_profile:OTHER' },
  { name: 'an empty string', value: '', urn: false, key: '', mailbox: '' },
  { name: 'a random name', value: 'Ada Lovelace', urn: false, key: 'Ada Lovelace', mailbox: '' },
  { name: 'an over-long value', value: OVER_LONG, urn: false, key: OVER_LONG, mailbox: '' },
  { name: 'a message urn', value: MESSAGE_URN, urn: false, key: MESSAGE_URN, mailbox: '' },
];

test('every module parses the one shape the same way', () => {
  const send = linkedinSendWrite(URN, 'hello');
  assert.ok(send, 'the canonical urn is a send target');
  for (const shape of SHAPES) {
    assert.equal(isConversationUrn(shape.value), shape.urn, `${shape.name}: isConversationUrn`);
    assert.equal(isConversationId(shape.value), shape.urn, `${shape.name}: isConversationId`);
    assert.equal(conversationKeyOf(shape.value), shape.key, `${shape.name}: conversationKeyOf`);
    assert.equal(conversationKeyFromUi(shape.value), shape.key, `${shape.name}: conversationKeyOf via linkedin-ui`);
    assert.equal(conversationMailboxOf(shape.value), shape.mailbox, `${shape.name}: conversationMailboxOf`);
    assert.equal(parseConversation(shape.value)?.key ?? '', shape.urn ? shape.key : '', `${shape.name}: parseConversation`);
    assert.equal(linkedinSendWrite(shape.value, 'hello') !== null, shape.urn, `${shape.name}: linkedinSendWrite`);
    assert.equal(isMessageSend(send!, shape.value), shape.value === URN, `${shape.name}: isMessageSend`);
  }
});

test('conversationKeyOf stays idempotent and never rewrites an unrecognised value', () => {
  assert.equal(conversationKeyOf(URN), KEY);
  assert.equal(conversationKeyOf(conversationKeyOf(URN)), KEY, 'a key read twice is still the same key');
  assert.equal(conversationKeyOf(KEY), KEY, 'a key is already the key');
  for (const value of ['Ada Lovelace', '', MESSAGE_URN, `/messaging/thread/${KEY}`, OVER_LONG]) {
    assert.equal(conversationKeyOf(value), value, `${value.slice(0, 40)} passes through, never guesses`);
  }
  // A non-string cannot name a conversation; the empty string fails every comparison.
  assert.equal(conversationKeyOf(null), '');
  assert.equal(conversationKeyOf(42), '');
});

test('the mailbox round-trips from the urn into the send payload for member and page mailboxes', () => {
  for (const mailbox of ['urn:li:fsd_profile:ACoAAExample', 'urn:li:fsd_company:12345']) {
    const urn = `urn:li:msg_conversation:(${mailbox},${KEY})`;
    assert.equal(conversationMailboxOf(urn), mailbox);
    assert.equal(parseConversation(urn)?.mailbox, mailbox);
    const write = linkedinSendWrite(urn, 'hello');
    assert.ok(write, `${mailbox} is a mailbox a conversation urn can carry`);
    const body = JSON.parse(write.body);
    assert.equal(body.mailboxUrn, mailbox, 'the send says which mailbox it sends as');
    assert.equal(body.message.conversationUrn, urn);
  }
});

/** One in-page expression, run against a fetch stub keyed by the endpoint's part of the url. */
async function runExpression(expression: string, reply: (url: string) => unknown) {
  const fetchStub = async (url: string) => ({ ok: true, status: 200, text: async () => JSON.stringify(reply(url)) });
  const evaluate = new AsyncFunction('fetch', 'document', `return (${expression});`);
  return evaluate(fetchStub, { cookie: 'JSESSIONID="token-1"' }) as Promise<{ ok: boolean; payload: any; error?: string }>;
}

test('a message urn is the shape the loose substring filter took for a conversation, and both filters now refuse it', async () => {
  // The loose filters were `/msg_conversation/`, which every message urn contains: the inbox read
  // listed messages as conversations and the probe counted them. The shared rule is the full urn,
  // so the deliberate choice here is strictness — a message urn is not a conversation anywhere.
  assert.match(MESSAGE_URN, /msg_conversation/);
  assert.equal(isConversationUrn(MESSAGE_URN), false);

  const entities = [URN, OTHER_URN, MESSAGE_URN, OVER_LONG, 'not a conversation'].map((entityUrn, index) => ({
    entityUrn,
    lastActivityAt: 1000 + index,
    unreadCount: index,
    '*conversationParticipants': [],
  }));

  const probeExpression = linkedinProbeExpression('urn:li:fsd_profile:ME');
  const probe = await runExpression(probeExpression, url => {
    if (url.includes('messengerConversations')) return { included: entities };
    return { included: [] };
  });
  assert.equal(probe.ok, true, probe.error);
  assert.equal(probe.payload.conversations.length, 2, 'the probe counts only the two real conversations');
  assert.deepEqual(probe.payload.conversations, [{ at: 1000, unread: 0 }, { at: 1001, unread: 1 }]);

  const pageExpression = linkedinPageExpression({ mode: 'list' });
  const page = await runExpression(pageExpression, url => {
    if (url.includes('messengerConversations')) return { included: entities };
    if (url.includes('invitationViews')) return { included: [] };
    return { data: { '*miniProfile': 'urn:li:fs_miniProfile:ME' } };
  });
  assert.equal(page.ok, true, page.error);
  assert.deepEqual(page.payload.conversations.map((conversation: { id: string }) => conversation.id), [URN, OTHER_URN]);

  // The two in-page filters rebuild their regex from the shared source rather than spelling it again.
  for (const expression of [probeExpression, pageExpression]) {
    assert.ok(expression.includes(JSON.stringify(CONVERSATION_URN_SOURCE)), 'the page reads the shared pattern');
  }
});
