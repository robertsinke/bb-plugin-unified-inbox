import assert from 'node:assert/strict';
import test from 'node:test';
import { createLinkedInPageSession } from '../src/linkedin-page-session.ts';
import type { RecordedWrite } from '../src/linkedin-write.ts';

/**
 * The write side of the same seam: `server.ts` injects the raw evaluator as `runLinkedInWrite`, and
 * three adapter call sites cast its `unknown` to `{ ok?, status? }` before asking `ok === true`.
 *
 * That cast hides a whole class of faults. A page that answers `true`, `null`, `{}`, or
 * `{ ok: 'yes' }` is not a refusal — it is a broken answer — but the cast turns every one of them
 * into "not accepted, status 0", and the person reads a confident wrong reason for a failure that
 * never happened. This session refuses such an answer instead, and returns an outcome whose two
 * states cannot both be true.
 */

const write: RecordedWrite = {
  method: 'POST',
  url: '/voyager/api/voyagerMessagingDashMessengerConversations?ids=List(urn%3Ali%3Amsg_conversation%3A(urn%3Ali%3Afsd_profile%3AACoAAme%2C2-YWJj))',
  body: '{"entities":{"urn:li:msg_conversation:(urn:li:fsd_profile:ACoAAme,2-YWJj)":{"patch":{"$set":{"read":true}}}},"originToken":"t"}',
  capturedAt: 1_800_000_000_000,
};

function fakePage(replies: unknown[]) {
  const asked: string[] = [];
  return {
    asked,
    evaluate: async (expression: string) => {
      asked.push(expression);
      if (!replies.length) throw new Error('the page was asked more often than scripted');
      return replies.shift();
    },
  };
}

test('an accepted write is accepted, with the status the page reported', async () => {
  const page = fakePage([{ ok: true, status: 200, body: {} }]);
  const session = createLinkedInPageSession(page.evaluate);

  assert.deepEqual(await session.replay(write), { accepted: true, status: 200 });
  assert.equal(page.asked.length, 1, 'one round trip per write');
});

test('a refused write is an outcome, not a throw: the caller phrases its own reason', async () => {
  const page = fakePage([{ ok: false, status: 403, body: {} }]);
  const session = createLinkedInPageSession(page.evaluate);

  assert.deepEqual(await session.replay(write), { accepted: false, status: 403 });
});

test('an answer that is not an outcome is refused, never read as "status 0"', async () => {
  // Every one of these used to reach the adapter as `{ ok: undefined }` and surface as
  // "did not accept (status 0)" — a wrong reason told with confidence.
  for (const broken of [true, null, {}, { ok: 'yes', status: 200 }, { ok: true }, { ok: true, status: 'HTTP 200' }]) {
    const session = createLinkedInPageSession(fakePage([broken]).evaluate);
    await assert.rejects(() => session.replay(write), /usable answer/i, `refused: ${JSON.stringify(broken)}`);
  }
});

test('the recorded request reaches the page unchanged, and a malformed write never reaches it', async () => {
  const page = fakePage([{ ok: true, status: 204, body: '' }]);
  const session = createLinkedInPageSession(page.evaluate);
  await session.replay(write);
  assert.ok(page.asked[0].includes(write.url.split('?')[0]), 'the recorded path is replayed, not rebuilt');

  const untouched = fakePage([]);
  const refusing = createLinkedInPageSession(untouched.evaluate);
  await assert.rejects(() => refusing.replay({ ...write, method: 'GET' }), /must be one of POST/i);
  assert.equal(untouched.asked.length, 0, 'a write that cannot be replayed is not sent');
});
