import assert from 'node:assert/strict';
import test from 'node:test';
import { createLinkedInPageSession } from '../src/linkedin-page-session.ts';

/**
 * The LinkedIn page talks through one seam: a string in, an envelope out. These tests pin what
 * the adapter is entitled to depend on — a typed payload per read, one round trip per read, and
 * a refusal — rather than the shape of the expression each read happens to build.
 *
 * The three faults this seam has already produced in production, all silent:
 *   - an envelope read as data, so every refresh skipped over an empty inbox;
 *   - a read whose result was a bare array, so the recorder saw nothing;
 *   - a page that failed and handed back a half-empty payload instead of throwing.
 */

/** A page stub: answers with the scripted replies in order and records what it was asked. */
function fakePage(replies: unknown[]) {
  const asked: string[] = [];
  const evaluate = async (expression: string) => {
    asked.push(expression);
    if (!replies.length) throw new Error(`the page was asked a fourth time: ${expression.slice(0, 120)}`);
    return replies.shift();
  };
  return { evaluate, asked };
}

const listPayload = {
  mailboxUrn: 'urn:li:fsd_mailbox:2-YWJj',
  conversations: [{ entityUrn: 'urn:li:msg_conversation:(urn:li:fsd_profile:ACoAAme,2-YWJj)' }],
  invitations: [],
};

test('list answers with the payload, never the envelope around it', async () => {
  const page = fakePage([{ ok: true, payload: listPayload }]);
  const session = createLinkedInPageSession(page.evaluate);

  assert.deepEqual(await session.list(), listPayload);
  assert.equal(page.asked.length, 1, 'one round trip per read');
});

test('a reply that is not an envelope is refused, not treated as data', async () => {
  // The fault that made a real read look like an empty inbox: an array arrived where the
  // envelope was expected, and the empty result was indistinguishable from "nothing to show".
  const page = fakePage([[...listPayload.conversations]]);
  const session = createLinkedInPageSession(page.evaluate);

  await assert.rejects(() => session.list(), /usable response/i);
});

test('a page that says why it failed says so, and a silent failure names sign-in', async () => {
  const signedOut = createLinkedInPageSession(fakePage([{ ok: false, error: 'LinkedIn 401 Unauthorized' }]).evaluate);
  await assert.rejects(() => signedOut.list(), /sign in again/i);

  const quiet = createLinkedInPageSession(fakePage([{ ok: false }]).evaluate);
  await assert.rejects(() => quiet.list(), /unavailable/i);
});

test('a conversation that is not a conversation urn is refused before the page is asked', async () => {
  const page = fakePage([]);
  const session = createLinkedInPageSession(page.evaluate);

  await assert.rejects(() => session.thread('2-YWJj'), /cannot be opened/i);
  assert.equal(page.asked.length, 0, 'the page is not asked to open something that is not a conversation');
});

test('thread and probe answer through the same envelope as list', async () => {
  const thread = { messages: [{ entityUrn: 'urn:li:msg_message:(urn:li:msg_conversation:(urn:li:fsd_profile:ACoAAme,2-YWJj),2-ZGVm)' }] };
  const page = fakePage([{ ok: true, payload: thread }, { ok: true, payload: listPayload }]);
  const session = createLinkedInPageSession(page.evaluate);

  assert.deepEqual(await session.thread('urn:li:msg_conversation:(urn:li:fsd_profile:ACoAAme,2-YWJj)'), thread);
  assert.deepEqual(await session.probe('urn:li:fsd_mailbox:2-YWJj'), listPayload);
});

test('the probe is its own expression, and every read is one expression', async () => {
  const page = fakePage([{ ok: true, payload: listPayload }, { ok: true, payload: listPayload }]);
  const session = createLinkedInPageSession(page.evaluate);

  await session.list();
  await session.probe('urn:li:fsd_mailbox:2-YWJj');

  assert.equal(page.asked.length, 2);
  assert.notEqual(page.asked[0], page.asked[1], 'the probe does not reuse the list expression');
  for (const expression of page.asked) {
    assert.equal(typeof expression, 'string');
    assert.ok(expression.length > 0);
  }
});
