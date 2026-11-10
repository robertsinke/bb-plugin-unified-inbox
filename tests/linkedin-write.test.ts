import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LINKEDIN_WRITE_LIMIT,
  clearRecordedWritesExpression,
  isMessageSend,
  messageSendTemplate,
  recordedWritesExpression,
  replayWriteExpression,
  recordedSendText,
  recorderStatsExpression,
  linkedinInvitationWrite,
  type InvitationAction,
  linkedinReactWrite,
  linkedinReplyWrite,
  linkedinSendWrite,
  markReadWrite,
  markReadTarget,
  sameConversationUrn,
  writeRecorderExpression,
  type RecordedWrite,
} from '../src/linkedin-write.ts';

/** The dump as the adapter reads it: an object with `writes`, never a bare array. */
const dumpOf = async (page: { evaluate: (expression: string) => Promise<unknown> }) => (await page.evaluate(recordedWritesExpression()) as { writes: RecordedWrite[] }).writes;


const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (...args: string[]) => Function;

const ORIGIN = 'https://www.linkedin.com';

type Reply = (url: string, init: { method?: string; body?: unknown }) => { status?: number; json?: unknown };

/** A fake LinkedIn page: a same-origin fetch stub, the session cookie, and an evaluator for one expression. */
function fakePage(cookie = 'JSESSIONID="token-1"', reply: Reply = () => ({ status: 200 })) {
  const calls: { url: string; init: { method?: string; body?: unknown; headers?: Record<string, string>; credentials?: string } }[] = [];
  const window: Record<string, any> = { location: { origin: ORIGIN } };
  window.fetch = async (url: string, init: { method?: string; body?: unknown }) => {
    calls.push({ url, init });
    const { status = 200, json } = reply(url, init);
    const text = json === undefined ? '' : JSON.stringify(json);
    return { ok: status >= 200 && status < 300, status, text: async () => text };
  };
  const document = { cookie };
  const evaluate = async (expression: string) => {
    const run = new AsyncFunction('window', 'location', 'document', 'fetch', `return (${expression});`);
    return await run(window, window.location, document, window.fetch);
  };
  return { window, document, calls, evaluate };
}

const CONVERSATION = 'urn:li:msg_conversation:(urn:li:fsd_profile:ACoAAExample,2-MTc5Y2Rl)';

/** A messengerMessages-shaped send, compacted the way the page's own JSON.stringify writes it. */
const SEND: RecordedWrite = {
  method: 'POST',
  url: '/voyager/api/voyagerMessagingGraphQL/graphql?queryId=messengerMessages.5846eeb71c981f11e0134cb6626cc314',
  body: JSON.stringify({
    variables: {
      conversationUrn: CONVERSATION,
      message: {
        body: { text: 'Hello there' },
        renderContent: [],
        originToken: '1700000000000',
      },
    },
    queryId: 'messengerMessages.5846eeb71c981f11e0134cb6626cc314',
  }),
  capturedAt: 1_760_000_000_000,
};

test('the recorder arms once, wraps once, and lets the page’s own call through', async () => {
  const page = fakePage();
  assert.deepEqual(await page.evaluate(writeRecorderExpression()), { installed: true, recording: true });
  const armed = page.window.fetch;
  assert.deepEqual(await page.evaluate(writeRecorderExpression()), { installed: true, recording: true });
  assert.equal(page.window.fetch, armed);

  const response = await page.window.fetch('/voyager/api/graphql', { method: 'POST', body: '{"a":1}' });
  assert.equal(response.status, 200);
  assert.equal(page.calls.length, 1);
  const recorded = await dumpOf(page);
  assert.equal(recorded.length, 1);
});

test('a recorder bookkeeping fault still returns the real response', async () => {
  const page = fakePage();
  await page.evaluate(writeRecorderExpression());
  // Storing reads the body of whatever the page handed fetch; a throwing getter stands in for any
  // fault inside the recorder's own path.
  const hostile = { method: 'POST', get body(): string { throw new Error('bookkeeping exploded'); } };
  const response = await page.window.fetch('/voyager/api/graphql', hostile);
  assert.equal(response.status, 200);
  assert.equal(page.calls.length, 1);
  assert.deepEqual(await dumpOf(page), []);
});

test('any same-origin mutating request is recorded, whatever path it carries', async () => {
  // LinkedIn does not keep every write under /voyager/api/ - an invitation accept was lost to
  // exactly that assumption - so origin is the recorder's boundary, not a path prefix.
  const page = fakePage();
  await page.evaluate(writeRecorderExpression());
  await page.window.fetch('/voyager/api/graphql', { method: 'POST', body: '{"a":1}' });
  await page.window.fetch(`${ORIGIN}/voyager/api/voyagerMessagingGraphQL/graphql?queryId=x`, { method: 'POST', body: '{"b":2}' });
  await page.window.fetch('/voyager/api/graphql', { method: 'GET' });
  await page.window.fetch('/voyager/api/graphql', { method: 'HEAD' });
  await page.window.fetch('https://elsewhere.test/voyager/api/graphql', { method: 'POST', body: '{"c":3}' });
  await page.window.fetch('//elsewhere.test/voyager/api/graphql', { method: 'POST', body: '{"d":4}' });
  await page.window.fetch('/relationships/invitation', { method: 'POST', body: '{"e":5}' });

  const recorded = await dumpOf(page);
  // Newest first, and the recorder strips its own origin so a template names no host.
  assert.deepEqual(recorded.map((write: RecordedWrite) => write.url), [
    '/relationships/invitation',
    '/voyager/api/voyagerMessagingGraphQL/graphql?queryId=x',
    '/voyager/api/graphql',
  ]);
  assert.ok((recorded as RecordedWrite[]).every(write => write.method === 'POST'));
  // And the sampler keeps the tail of what came through, so a lost request can name itself.
  const stats = (await page.evaluate(recorderStatsExpression()) as { paths?: string[] });
  assert.ok(stats.paths!.includes('POST /relationships/invitation'));
});

test('the recorder keeps five writes, newest last, and drops an oversized body', async () => {
  const page = fakePage();
  await page.evaluate(writeRecorderExpression());
  for (let index = 0; index < 6; index += 1) {
    await page.window.fetch('/voyager/api/graphql', { method: 'POST', body: JSON.stringify({ index }) });
  }
  const recorded = await dumpOf(page);
  assert.deepEqual(recorded.map((write: RecordedWrite) => JSON.parse(write.body).index), [5, 4, 3, 2, 1]);
  assert.deepEqual(page.window.__unifiedInboxWrites.map((write: RecordedWrite) => JSON.parse(write.body).index), [1, 2, 3, 4, 5]);

  assert.deepEqual(await page.evaluate(clearRecordedWritesExpression()), { cleared: 5 });
  assert.deepEqual(await dumpOf(page), []);

  await page.window.fetch('/voyager/api/graphql', { method: 'POST', body: JSON.stringify({ padding: 'x'.repeat(LINKEDIN_WRITE_LIMIT) }) });
  assert.deepEqual(await dumpOf(page), []);
  // The bound is bytes, so a shorter multi-byte body over the same limit is dropped too.
  await page.window.fetch('/voyager/api/graphql', { method: 'POST', body: JSON.stringify({ padding: '😀'.repeat(LINKEDIN_WRITE_LIMIT / 4) }) });
  assert.deepEqual(await dumpOf(page), []);

  // Clearing empties the array in place, so the armed wrapper keeps recording into it.
  await page.window.fetch('/voyager/api/graphql', { method: 'POST', body: '{"fresh":true}' });
  assert.equal((await dumpOf(page)).length, 1);
});

test('replay refuses anything that is not a same-origin path or a real JSON write', () => {
  const base = { method: 'POST', url: '/voyager/api/graphql', body: '{}', capturedAt: 1 };
  const hostileUrls = [
    `${ORIGIN}/voyager/api/graphql`, // absolute, even on the right host
    'https://elsewhere.test/voyager/api/graphql',
    '//elsewhere.test/voyager/api/graphql',
    '/voyager/api\\graphql',
    '/voyager/api/../secrets',
    '/voyager/api/%2e%2e/graphql',
    'javascript:alert(1)',
    'data:application/json,{}',
    '',
  ];
  for (const url of hostileUrls) {
    assert.throws(() => replayWriteExpression({ ...base, url }), /same-origin path/, url);
  }
  assert.throws(() => replayWriteExpression({ ...base, method: 'GET' }), /must be one of POST, PUT, PATCH, DELETE/);
  assert.throws(() => replayWriteExpression({ ...base, url: '/voyager/api/graphql', body: 'not json' }), /must be JSON/);
  assert.throws(() => replayWriteExpression({ ...base, url: '/voyager/api/graphql', body: 42 as unknown as string }), /body string/);
  assert.throws(
    () => replayWriteExpression({ ...base, body: `{"a":"${'x'.repeat(LINKEDIN_WRITE_LIMIT)}"}` }),
    /at most \d+ bytes/,
  );
  assert.throws(
    () => replayWriteExpression({ ...base, body: `{"a":"${'😀'.repeat(LINKEDIN_WRITE_LIMIT / 4)}"}` }),
    /at most \d+ bytes/,
  );
  // A refused template never becomes a page expression, so nothing is interpolated before the check.
  assert.equal(typeof replayWriteExpression({ ...base, url: '/voyager/api/graphql' }), 'string');
});

test('replay sends the live csrf token and reports a 4xx instead of throwing', async () => {
  const page = fakePage('JSESSIONID="token-live"', url => (
    url.startsWith('/voyager/api/voyagerMessagingGraphQL')
      ? { status: 422, json: { status: 422, message: 'nope' } }
      : { status: 200, json: { ok: 1 } }
  ));
  // A template carrying its own stale token in the body must not influence the header sent.
  const write: RecordedWrite = { ...SEND, body: JSON.stringify({ variables: { conversationUrn: CONVERSATION }, stale: 'csrf-token=template-token' }) };
  const expression = replayWriteExpression(write);
  assert.equal(expression.match(/'csrf-token'/g)?.length, 1);

  const result = await page.evaluate(expression);
  assert.deepEqual(result, { ok: false, status: 422, body: { status: 422, message: 'nope' } });
  const [{ url, init }] = page.calls;
  assert.equal(url, write.url);
  assert.equal(init.method, 'POST');
  assert.equal(init.body, write.body);
  assert.equal(init.credentials, 'include');
  assert.equal(init.headers?.['csrf-token'], 'token-live');
  assert.match(init.headers?.accept ?? '', /^application\/vnd\.linkedin\.normalized\+json\+2\.1$/);
  assert.equal(init.headers?.['x-restli-protocol-version'], '2.0.0');
  assert.equal(init.headers?.['content-type'], 'application/json');
});

test('a message template replaces only the outgoing text', () => {
  const text = 'Updated "quoted" text\nsecond line';
  const templated = messageSendTemplate(SEND, CONVERSATION, text);
  assert.equal(templated.method, SEND.method);
  assert.equal(templated.url, SEND.url);
  assert.equal(templated.capturedAt, SEND.capturedAt);
  // Compact JSON round-trips key order, so the only byte that moves is the text itself.
  assert.equal(templated.body, SEND.body.replace('"Hello there"', JSON.stringify(text)));

  const before = JSON.parse(SEND.body);
  before.variables.message.body.text = text;
  assert.deepEqual(JSON.parse(templated.body), before);
});

test('a template refuses a body it cannot explain', () => {
  const otherConversation = 'urn:li:msg_conversation:(urn:li:fsd_profile:OTHER,2-ZZZ)';
  const noUrn: RecordedWrite = {
    ...SEND,
    body: JSON.stringify({ variables: { conversationUrn: otherConversation, message: { body: { text: 'hi' } } } }),
  };
  assert.throws(() => messageSendTemplate(noUrn, CONVERSATION, 'hey'), /does not carry the conversation urn/);

  const noText: RecordedWrite = { ...SEND, body: JSON.stringify({ variables: { conversationUrn: CONVERSATION, message: { body: {} } } }) };
  assert.throws(() => messageSendTemplate(noText, CONVERSATION, 'hey'), /no text field to replace/);

  const twoTexts: RecordedWrite = {
    ...SEND,
    body: JSON.stringify({
      variables: { conversationUrn: CONVERSATION, message: { body: { text: 'a' } } },
      preview: { text: 'b' },
    }),
  };
  assert.throws(() => messageSendTemplate(twoTexts, CONVERSATION, 'hey'), /2 text fields \(variables\.message\.body\.text, preview\.text\)/);

  assert.throws(() => messageSendTemplate(SEND, 'not-a-conversation', 'hey'), /conversation urn/);
  assert.throws(() => messageSendTemplate({ ...SEND, body: 'nope' }, CONVERSATION, 'hey'), /needs the JSON body/);
});

test('isMessageSend tells a send from an invitation answer or a read mark', () => {
  assert.equal(isMessageSend(SEND, CONVERSATION), true);
  assert.equal(isMessageSend(messageSendTemplate(SEND, CONVERSATION, 'new text'), CONVERSATION), true);
  assert.equal(isMessageSend(SEND, 'urn:li:msg_conversation:(urn:li:fsd_profile:OTHER,2-ZZZ)'), false);

  const accept: RecordedWrite = {
    method: 'POST',
    url: '/voyager/api/relationships/invitationViews?action=accept',
    body: JSON.stringify({ invitationUrn: 'urn:li:fsd_invitation:123' }),
    capturedAt: 2,
  };
  assert.equal(isMessageSend(accept, CONVERSATION), false);

  const markRead: RecordedWrite = {
    method: 'POST',
    url: '/voyager/api/voyagerMessagingGraphQL/graphql?queryId=x',
    body: JSON.stringify({ variables: { conversationUrn: CONVERSATION, seen: true } }),
    capturedAt: 3,
  };
  assert.equal(isMessageSend(markRead, CONVERSATION), false);
});

test('nothing keeps a cookie, a csrf token, or a set-cookie value', async () => {
  const page = fakePage('JSESSIONID="session-token"');
  await page.evaluate(writeRecorderExpression());
  await page.window.fetch('/voyager/api/graphql', {
    method: 'POST',
    body: '{"a":1}',
    credentials: 'include',
    headers: { 'csrf-token': 'session-token', cookie: 'JSESSIONID=session-token', 'set-cookie': 'x=session-token' },
  });
  const recorded = await dumpOf(page) as RecordedWrite[];
  assert.deepEqual(Object.keys(recorded[0]).sort(), ['body', 'capturedAt', 'method', 'url']);
  assert.doesNotMatch(JSON.stringify(recorded), /session-token|csrf-token|set-cookie|JSESSIONID|cookie/i);
  // The recorder reads the request line only; it never touches the cookie store or the headers.
  assert.doesNotMatch(writeRecorderExpression() + recordedWritesExpression(), /document\.cookie|headers|set-cookie|csrf-token/i);
});

test('the recorded text comes back only from a single text field that names this conversation', () => {
  const write = (body: unknown) => ({ method: 'POST', url: '/voyager/api/voyagerMessagingGraphQL/graphql?queryId=messengerMessages', body: JSON.stringify(body), capturedAt: 1 });
  assert.equal(recordedSendText(write({ variables: { conversationUrn: 'urn:li:msg_conversation:2-abc', message: { text: 'See you soon' } } }), 'urn:li:msg_conversation:2-abc'), 'See you soon');
  // A different conversation, no text field, or two of them: no repeat, so the caller must supply one.
  assert.equal(recordedSendText(write({ variables: { conversationUrn: 'urn:li:msg_conversation:2-abc', message: { text: 'x' } } }), 'urn:li:msg_conversation:2-zzz'), null);
  assert.equal(recordedSendText(write({ variables: { conversationUrn: 'urn:li:msg_conversation:2-abc' } }), 'urn:li:msg_conversation:2-abc'), null);
  assert.equal(recordedSendText(write({ variables: { conversationUrn: 'urn:li:msg_conversation:2-abc', a: { text: 'x' }, b: { text: 'y' } } }), 'urn:li:msg_conversation:2-abc'), null);
});

test('a dump answers under `writes`, because a bare array reads back as nothing recorded', async () => {
  // The recorder stored writes and the dump reported none for exactly this reason: the page returned
  // an array, the caller read `.writes` off it, and the buffer that was full looked empty.
  const expression = recordedWritesExpression();
  assert.match(expression, /return \{ writes: list\.slice\(\)/);
  const stored = [{ method: 'POST', url: '/voyager/api/x', body: '{"a":1}', capturedAt: 7 }];
  const page = { __unifiedInboxWrites: stored } as unknown;
  const read = new Function('window', `return (${expression});`)(page) as { writes: unknown[] };
  assert.equal(Array.isArray(read), false, 'the dump must answer with an object');
  assert.deepEqual(read.writes, stored);
});

test('a recorded mark-read is recognised by its exact shape, and by nothing looser', () => {
  const urn = 'urn:li:msg_conversation:(urn:li:fsd_profile:ACoAAAbc123,2-YWFhYWFhYWEtYmJiYi00Y2Nj)';
  const encoded = encodeURIComponent(urn);
  const write = {
    method: 'POST',
    url: `/voyager/api/voyagerMessagingDashMessengerConversations?ids=List(${encoded})`,
    body: JSON.stringify({ entities: { [urn]: { patch: { $set: { read: true } } } } }),
    capturedAt: 1,
  };
  assert.equal(markReadTarget(write), urn);
  assert.ok(sameConversationUrn(markReadTarget(write), urn));

  // Every one of these is a different request, and each must be refused rather than replayed.
  const refused = [
    { ...write, method: 'GET' },
    { ...write, url: write.url.replace('voyagerMessagingDashMessengerConversations', 'voyagerMessagingGraphQL') },
    { ...write, body: JSON.stringify({ entities: { [urn]: { patch: { $set: { read: false } } } } }) },
    { ...write, body: JSON.stringify({ entities: { [urn]: { patch: { $set: { read: true, archived: true } } } } }) },
    { ...write, body: JSON.stringify({ entities: { [urn]: { patch: { $set: { read: true } } }, 'urn:li:msg_conversation:(urn:li:fsd_profile:other,2-x)': { patch: { $set: { read: true } } } } }) },
    { ...write, body: JSON.stringify({ entities: { [urn]: { patch: { $unset: { read: true } } } } }) },
    { ...write, body: JSON.stringify({ entities: { [urn]: { patch: { $set: { read: true } } } } }) .replace(urn, 'urn:li:msg_conversation:(urn:li:fsd_profile:other,2-x)') },
    { ...write, body: 'not json' },
  ];
  for (const wrong of refused) assert.equal(markReadTarget(wrong), null, `${wrong.method} ${wrong.body.slice(0, 40)} must be refused`);
});

test('the built mark-read request is the observed one, byte for byte', () => {
  // Captured 2026-11-02 from the page's own "Mark as read" click. The builder must reproduce it
  // exactly, or the adapter is no longer replaying what was observed.
  const observed = {
    method: 'POST',
    url: '/voyager/api/voyagerMessagingDashMessengerConversations?ids=List(urn%3Ali%3Amsg_conversation%3A%28urn%3Ali%3Afsd_profile%3AACoAAAexampleProfileId0000000000000001%2C2-YWFhYWFhYWEtYmJiYi00Y2NjLTlkZGQtZWVlZWVlZWVlZWVlXzEwMA%3D%3D%29)',
    body: '{"entities":{"urn:li:msg_conversation:(urn:li:fsd_profile:ACoAAAexampleProfileId0000000000000001,2-YWFhYWFhYWEtYmJiYi00Y2NjLTlkZGQtZWVlZWVlZWVlZWVlXzEwMA==)":{"patch":{"$set":{"read":true}}}}}',
  };
  const urn = 'urn:li:msg_conversation:(urn:li:fsd_profile:ACoAAAexampleProfileId0000000000000001,2-YWFhYWFhYWEtYmJiYi00Y2NjLTlkZGQtZWVlZWVlZWVlZWVlXzEwMA==)';
  const write = markReadWrite(urn, true);
  assert.ok(write);
  assert.deepEqual({ method: write.method, url: write.url, body: write.body }, observed);

  // The unread direction is the same patch with the flag down, and anything that is not a
  // conversation urn is refused rather than built.
  assert.ok(markReadWrite(urn, false)!.body.includes('"read":false'));
  assert.equal(markReadWrite('https://linkedin.com/', true), null);
  assert.equal(markReadWrite('urn:li:msg_conversation:', true), null);
  assert.equal(markReadWrite(null, true), null);

  // What the builder emits is exactly what the recogniser accepts, so a replay can never diverge
  // from the shape the page was observed to send.
  assert.equal(markReadTarget(write), urn);
  // The recogniser gates *recorded* mark-read replays, and the observed action set read true; the
  // unread direction is the adapter's own action, so it is correctly not a recorded mark-read.
  assert.equal(markReadTarget(markReadWrite(urn, false)!), null);
});


test('the built send request is the observed one, byte for byte', () => {
  // Captured 2026-11-02 from a real reply through the visible UI. With the recorded originToken
  // pinned, the builder must reproduce the request exactly, or the adapter is no longer sending
  // what was observed.
  const OBSERVED_URL = "/voyager/api/voyagerMessagingDashMessengerMessages?action=createMessage";
  const OBSERVED_BODY = String.raw`{"message":{"body":{"attributes":[],"text":"test message"},"renderContentUnions":[],"conversationUrn":"urn:li:msg_conversation:(urn:li:fsd_profile:ACoAAAexampleProfileId0000000000000001,2-ZmZmZmZmZmYtMDAwMC00MTExLTgyMjItMzMzMzMzMzMzMzMzXzAxMg==)","originToken":"03ca88de-3101-4b76-b8e2-cb132bb30408"},"mailboxUrn":"urn:li:fsd_profile:ACoAAAexampleProfileId0000000000000001","trackingId":"\u0003ÊÞ1\u0001Kv¸âË\u0013+³\u0004\b","dedupeByClientGeneratedToken":false}`;
  const write = linkedinSendWrite("urn:li:msg_conversation:(urn:li:fsd_profile:ACoAAAexampleProfileId0000000000000001,2-ZmZmZmZmZmYtMDAwMC00MTExLTgyMjItMzMzMzMzMzMzMzMzXzAxMg==)", 'test message', '03ca88de-3101-4b76-b8e2-cb132bb30408');
  assert.ok(write, 'a conversation urn and text are enough to build the observed send');
  assert.equal(write.method, 'POST');
  assert.equal(write.url, OBSERVED_URL);
  assert.equal(write.body, OBSERVED_BODY);

  // A fresh send gets a fresh originToken, the conversation is read from the urn, and anything
  // that is not a conversation with text is refused rather than built.
  const fresh = linkedinSendWrite("urn:li:msg_conversation:(urn:li:fsd_profile:ACoAAAexampleProfileId0000000000000001,2-ZmZmZmZmZmYtMDAwMC00MTExLTgyMjItMzMzMzMzMzMzMzMzXzAxMg==)", 'hello');
  assert.ok(fresh);
  assert.notEqual(JSON.parse(fresh!.body).message.originToken, '03ca88de-3101-4b76-b8e2-cb132bb30408');
  assert.equal(JSON.parse(fresh!.body).mailboxUrn, 'urn:li:fsd_profile:ACoAAAexampleProfileId0000000000000001');
  assert.equal(JSON.parse(fresh!.body).message.body.text, 'hello');
  assert.equal(linkedinSendWrite('urn:li:msg_conversation:broken', 'hello'), null);
  assert.equal(linkedinSendWrite("urn:li:msg_conversation:(urn:li:fsd_profile:ACoAAAexampleProfileId0000000000000001,2-ZmZmZmZmZmYtMDAwMC00MTExLTgyMjItMzMzMzMzMzMzMzMzXzAxMg==)", ''), null);

  // The recogniser accepts the built send as a message send to its own conversation, so the
  // replay surface and the adapter agree about what a send is.
  assert.equal(isMessageSend(write!, "urn:li:msg_conversation:(urn:li:fsd_profile:ACoAAAexampleProfileId0000000000000001,2-ZmZmZmZmZmYtMDAwMC00MTExLTgyMjItMzMzMzMzMzMzMzMzXzAxMg==)"), true);
  assert.equal(isMessageSend(write!, 'urn:li:msg_conversation:(urn:li:fsd_profile:somebody-else,2-x)'), false);
});
test('the built reaction is the observed one, byte for byte, in both directions', () => {
  // Captured 2026-11-10 from one message in the visible UI: a thumbs-up, then its removal.
  // The live urn is replaced here with the same shape. With that urn and 👍 pinned, the builder
  // must reproduce each request exactly.
  const MESSAGE = 'urn:li:msg_message:(urn:li:fsd_profile:ACoAAAexampleProfileId0000000000000001,2-MTc5MzUwMDI5ODg3MmIyMjAzNi0xMDAmZDViYmEwOTQtNDlhNC00M2M0LTkyNTEtNjZlODQ0YTdmZDU4XzAxMg==)';
  const BODY = `{"messageUrn":"${MESSAGE}","emoji":"👍"}`;
  const set = linkedinReactWrite(MESSAGE, '👍');
  const removed = linkedinReactWrite(MESSAGE, '👍', true);
  assert.ok(set && removed);
  assert.equal(set.method, 'POST');
  assert.equal(set.url, '/voyager/api/voyagerMessagingDashMessengerMessages?action=reactWithEmoji');
  assert.equal(set.body, BODY);
  assert.equal(removed.url, '/voyager/api/voyagerMessagingDashMessengerMessages?action=unreactWithEmoji');
  assert.equal(removed.body, BODY);

  // The emoji field is the reaction. Another of the four changes that field and adds no second one.
  const heart = linkedinReactWrite(MESSAGE, '❤️');
  assert.ok(heart);
  const heartBody = JSON.parse(heart.body) as { messageUrn: string; emoji: string };
  assert.deepEqual(Object.keys(heartBody), ['messageUrn', 'emoji']);
  assert.equal(heartBody.emoji, '❤️');
  assert.equal(heartBody.messageUrn, MESSAGE);
  assert.equal(heart.url, set.url);

  // A conversation urn is not a message urn, and an emoji outside the four is not a reaction.
  assert.equal(linkedinReactWrite('urn:li:msg_conversation:(urn:li:fsd_profile:ACoAAAexampleProfileId0000000000000001,2-abc)', '👍'), null);
  assert.equal(linkedinReactWrite('urn:li:msg_message:(urn:li:msg_conversation:(urn:li:fsd_profile:ACoAAme,2-YWJj),2-dGV4dA==)', '👍'), null);
  assert.equal(linkedinReactWrite(MESSAGE, '‼️'), null);
  assert.equal(linkedinReactWrite(MESSAGE, ''), null);
});

test('the built reply to one message is the observed one, byte for byte', () => {
  // Captured 2026-11-10 by choosing Reply on one message and sending. The live urns are replaced
  // with the same shape. The tracking blob and the quoted type names stay the captured bytes.
  const CONVERSATION = 'urn:li:msg_conversation:(urn:li:fsd_profile:ACoAAAexampleProfileId0000000000000001,2-ZmZmZmZmZmYtMDAwMC00MTExLTgyMjItMzMzMzMzMzMzMzMzXzAxMg==)';
  const MESSAGE = 'urn:li:msg_message:(urn:li:fsd_profile:ACoAAAexampleProfileId0000000000000001,2-MTc5MzUwMDI5ODg3MmIyMjAzNi0xMDAmZDViYmEwOTQtNDlhNC00M2M0LTkyNTEtNjZlODQ0YTdmZDU4XzAxMg==)';
  const SENDER = 'urn:li:fsd_profile:ACoAAAexampleProfileId0000000000000001';
  const write = linkedinReplyWrite({
    conversationUrn: CONVERSATION,
    text: 'reply test',
    messageUrn: MESSAGE,
    sentAt: 1793500298872,
    senderUrn: SENDER,
    quotedText: 'test message',
    originToken: '0c587269-d011-45ed-be99-dca33c0f544f',
  });
  assert.ok(write);
  assert.equal(write.url, '/voyager/api/voyagerMessagingDashMessengerMessages?action=createMessage');
  assert.equal(write.body, `{"message":{"body":{"attributes":[],"text":"reply test"},"renderContentUnions":[{"repliedMessageContent":{"originalSenderUrn":"urn:li:msg_messagingParticipant:${SENDER}","originalSendAt":1793500298872,"originalMessageUrn":"${MESSAGE}","messageBody":{"_type":"com.linkedin.pemberly.text.AttributedText","attributes":[],"text":"test message","_recipeType":"com.linkedin.1ea7e24db829a1347b841f2dd496da36"}}}],"conversationUrn":"${CONVERSATION}","originToken":"0c587269-d011-45ed-be99-dca33c0f544f"},"mailboxUrn":"${SENDER}","trackingId":"\\fXriÐ\\u0011Eí¾\u0099Ü£<\\u000fTO","dedupeByClientGeneratedToken":false}`);
  assert.equal(linkedinReplyWrite({ conversationUrn: CONVERSATION, text: '', messageUrn: MESSAGE, sentAt: 1, senderUrn: SENDER, quotedText: 'hi' }), null);
  assert.equal(linkedinReplyWrite({ conversationUrn: 'not-a-conversation', text: 'hi', messageUrn: MESSAGE, sentAt: 1, senderUrn: SENDER, quotedText: 'hi' }), null);
  assert.equal(linkedinReplyWrite({ conversationUrn: CONVERSATION, text: 'hi', messageUrn: 'urn:li:msg_message:nope', sentAt: 1, senderUrn: SENDER, quotedText: 'hi' }), null);
});

test('the built invitation answer is the observed one, byte for byte, in both directions', () => {
  // Captured 2026-11-02 through the page's own buttons: one real accept (Ada), one real ignore
  // (Grace). With the recorded per-request randomness pinned, the builder must reproduce each
  // request exactly, or the adapter is no longer answering the way the page was observed to.
  const ACCEPT_URL = "/flagship-web/rsc-action/actions/server-request?sduiid=com.linkedin.sdui.requests.mynetwork.addaInvitationAction&parentSpanId=spanaccept1%3D";
  const ACCEPT_BODY = String.raw`{"requestId":"com.linkedin.sdui.requests.mynetwork.addaInvitationAction","serverRequest":{"requestId":"com.linkedin.sdui.requests.mynetwork.addaInvitationAction","requestedArguments":{"$type":"proto.sdui.actions.requests.RequestedArguments","requestedStateKeys":[],"payload":{"inviteeActionType":"InviteeActionType_ACCEPT","invitationType":"GenericInvitationType_CONNECTION","invitationUrn":{"invitationId":"7000000000000000001"},"validationToken":"tokenaaa1","origin":"InvitationOrigin_INVITATION_PREVIEW","restoreOnServerFailure":false,"postActionSentConfigs":[],"profileUrn":{"profileId":"ACoAAAexampleProfileId0000000000000002"}},"requestMetadata":{"$type":"proto.sdui.common.RequestMetadata"}},"onClientRequestFailureAction":{"actions":[{"$type":"proto.sdui.actions.core.SetState","value":{"state":{"key":{"key":{"value":{"$case":"id","id":"invitation_action_state_7000000000000000001"}}},"value":{"$case":"stringValue","stringValue":"Pending"}}}},{"$type":"proto.sdui.actions.core.ShowToast","value":{"duration":"ToastDuration_UNKNOWN","key":"11111111-1111-4111-8111-111111111111","presetToast":{"category":"ToastPresetCategory_ERROR","text":{"_payload":{"status":"resolved_model","value":"[\"Sorry, invitation from Ada not accepted. Please try again.\"]","reason":{"_moduleLoading":null,"_chunks":{},"_stringDecoder":{},"_closed":true,"_closedReason":{},"_allowPartialStream":false}}}}}}]},"isApfcEnabled":false,"isStreaming":false,"rumPageKey":""},"states":[],"requestedArguments":{"$type":"proto.sdui.actions.requests.RequestedArguments","requestedStateKeys":[],"payload":{"inviteeActionType":"InviteeActionType_ACCEPT","invitationType":"GenericInvitationType_CONNECTION","invitationUrn":{"invitationId":"7000000000000000001"},"validationToken":"tokenaaa1","origin":"InvitationOrigin_INVITATION_PREVIEW","restoreOnServerFailure":false,"postActionSentConfigs":[],"profileUrn":{"profileId":"ACoAAAexampleProfileId0000000000000002"}},"requestMetadata":{"$type":"proto.sdui.common.RequestMetadata"},"states":[],"screenId":"com.linkedin.sdui.flagshipnav.mynetwork.Grow","knownTemplateIds":[]}}`;
  const IGNORE_URL = "/flagship-web/rsc-action/actions/server-request?sduiid=com.linkedin.sdui.requests.mynetwork.addaInvitationAction&parentSpanId=%2Fspanignore1%3D";
  const IGNORE_BODY = String.raw`{"requestId":"com.linkedin.sdui.requests.mynetwork.addaInvitationAction","serverRequest":{"requestId":"com.linkedin.sdui.requests.mynetwork.addaInvitationAction","requestedArguments":{"$type":"proto.sdui.actions.requests.RequestedArguments","requestedStateKeys":[],"payload":{"inviteeActionType":"InviteeActionType_IGNORE","invitationType":"GenericInvitationType_CONNECTION","invitationUrn":{"invitationId":"7000000000000000002"},"validationToken":"tokenbbb2","origin":"InvitationOrigin_INVITATION_PREVIEW","restoreOnServerFailure":false,"postActionSentConfigs":[],"profileUrn":{"profileId":"ACoAAAexampleProfileId0000000000000003"}},"requestMetadata":{"$type":"proto.sdui.common.RequestMetadata"}},"onClientRequestFailureAction":{"actions":[{"$type":"proto.sdui.actions.core.SetState","value":{"state":{"key":{"key":{"value":{"$case":"id","id":"invitation_action_state_7000000000000000002"}}},"value":{"$case":"stringValue","stringValue":"Pending"}}}},{"$type":"proto.sdui.actions.core.ShowToast","value":{"duration":"ToastDuration_UNKNOWN","key":"22222222-2222-4222-8222-222222222222","presetToast":{"category":"ToastPresetCategory_ERROR","text":{"_payload":{"status":"resolved_model","value":"[\"Sorry, invitation from Grace not ignored. Please try again.\"]","reason":{"_moduleLoading":null,"_chunks":{},"_stringDecoder":{},"_closed":true,"_closedReason":{},"_allowPartialStream":false}}}}}}]},"isApfcEnabled":false,"isStreaming":false,"rumPageKey":""},"states":[],"requestedArguments":{"$type":"proto.sdui.actions.requests.RequestedArguments","requestedStateKeys":[],"payload":{"inviteeActionType":"InviteeActionType_IGNORE","invitationType":"GenericInvitationType_CONNECTION","invitationUrn":{"invitationId":"7000000000000000002"},"validationToken":"tokenbbb2","origin":"InvitationOrigin_INVITATION_PREVIEW","restoreOnServerFailure":false,"postActionSentConfigs":[],"profileUrn":{"profileId":"ACoAAAexampleProfileId0000000000000003"}},"requestMetadata":{"$type":"proto.sdui.common.RequestMetadata"},"states":[],"screenId":"com.linkedin.sdui.flagshipnav.mynetwork.Grow","knownTemplateIds":[]}}`;
  const accepted = linkedinInvitationWrite({ invitationId: "7000000000000000001", token: "tokenaaa1", inviterProfileId: "ACoAAAexampleProfileId0000000000000002", firstName: 'Ada', action: 'accept', toastKey: "11111111-1111-4111-8111-111111111111", spanId: "spanaccept1" });
  const ignored = linkedinInvitationWrite({ invitationId: "7000000000000000002", token: "tokenbbb2", inviterProfileId: "ACoAAAexampleProfileId0000000000000003", firstName: 'Grace', action: 'ignore', toastKey: "22222222-2222-4222-8222-222222222222", spanId: "/spanignore1" });
  assert.ok(accepted && ignored);
  assert.equal(accepted.method, 'POST');
  assert.equal(accepted.url, ACCEPT_URL);
  assert.equal(accepted.body, ACCEPT_BODY);
  assert.equal(ignored.url, IGNORE_URL);
  assert.equal(ignored.body, IGNORE_BODY);

  // A fresh answer gets fresh randomness, and anything malformed is refused rather than built.
  const fresh = linkedinInvitationWrite({ invitationId: '123', token: 'tok', inviterProfileId: 'ACo1', firstName: 'Ada', action: 'ignore' });
  assert.ok(fresh && !fresh.url.includes(accepted.url.slice(-30)));
  const malformed: { invitationId: string; token: string; inviterProfileId: string; firstName: string; action: string }[] = [
    { invitationId: 'abc', token: 'tok', inviterProfileId: 'ACo1', firstName: 'Ada', action: 'accept' },
    { invitationId: '123', token: '', inviterProfileId: 'ACo1', firstName: 'Ada', action: 'accept' },
    { invitationId: '123', token: 'tok', inviterProfileId: '', firstName: 'Ada', action: 'ignore' },
    { invitationId: '123', token: 'tok', inviterProfileId: 'ACo1', firstName: '', action: 'accept' },
    { invitationId: '123', token: 'tok', inviterProfileId: 'ACo1', firstName: 'Ada', action: 'maybe' },
  ];
  for (const bad of malformed) {
    assert.equal(linkedinInvitationWrite(bad as unknown as Parameters<typeof linkedinInvitationWrite>[0]), null, JSON.stringify(bad));
  }
});