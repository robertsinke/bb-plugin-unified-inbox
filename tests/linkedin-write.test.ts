import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LINKEDIN_WRITE_LIMIT,
  clearRecordedWritesExpression,
  isMessageSend,
  messageSendTemplate,
  recordedWritesExpression,
  replayWriteExpression,
  recordedSendText, writeRecorderExpression,
  type RecordedWrite,
} from '../src/linkedin-write.ts';

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
  const recorded = await page.evaluate(recordedWritesExpression());
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
  assert.deepEqual(await page.evaluate(recordedWritesExpression()), []);
});

test('only same-origin writes to /voyager/api/ are recorded', async () => {
  const page = fakePage();
  await page.evaluate(writeRecorderExpression());
  await page.window.fetch('/voyager/api/graphql', { method: 'POST', body: '{"a":1}' });
  await page.window.fetch(`${ORIGIN}/voyager/api/voyagerMessagingGraphQL/graphql?queryId=x`, { method: 'POST', body: '{"b":2}' });
  await page.window.fetch('/voyager/api/graphql', { method: 'GET' });
  await page.window.fetch('/voyager/api/graphql', { method: 'HEAD' });
  await page.window.fetch('https://elsewhere.test/voyager/api/graphql', { method: 'POST', body: '{"c":3}' });
  await page.window.fetch('//elsewhere.test/voyager/api/graphql', { method: 'POST', body: '{"d":4}' });
  await page.window.fetch('/feed/update', { method: 'POST', body: '{"e":5}' });

  const recorded = await page.evaluate(recordedWritesExpression());
  // Newest first, and the recorder strips its own origin so a template names no host.
  assert.deepEqual(recorded.map((write: RecordedWrite) => write.url), [
    '/voyager/api/voyagerMessagingGraphQL/graphql?queryId=x',
    '/voyager/api/graphql',
  ]);
  assert.ok((recorded as RecordedWrite[]).every(write => write.method === 'POST'));
});

test('the recorder keeps five writes, newest last, and drops an oversized body', async () => {
  const page = fakePage();
  await page.evaluate(writeRecorderExpression());
  for (let index = 0; index < 6; index += 1) {
    await page.window.fetch('/voyager/api/graphql', { method: 'POST', body: JSON.stringify({ index }) });
  }
  const recorded = await page.evaluate(recordedWritesExpression());
  assert.deepEqual(recorded.map((write: RecordedWrite) => JSON.parse(write.body).index), [5, 4, 3, 2, 1]);
  assert.deepEqual(page.window.__unifiedInboxWrites.map((write: RecordedWrite) => JSON.parse(write.body).index), [1, 2, 3, 4, 5]);

  assert.deepEqual(await page.evaluate(clearRecordedWritesExpression()), { cleared: 5 });
  assert.deepEqual(await page.evaluate(recordedWritesExpression()), []);

  await page.window.fetch('/voyager/api/graphql', { method: 'POST', body: JSON.stringify({ padding: 'x'.repeat(LINKEDIN_WRITE_LIMIT) }) });
  assert.deepEqual(await page.evaluate(recordedWritesExpression()), []);
  // The bound is bytes, so a shorter multi-byte body over the same limit is dropped too.
  await page.window.fetch('/voyager/api/graphql', { method: 'POST', body: JSON.stringify({ padding: '😀'.repeat(LINKEDIN_WRITE_LIMIT / 4) }) });
  assert.deepEqual(await page.evaluate(recordedWritesExpression()), []);

  // Clearing empties the array in place, so the armed wrapper keeps recording into it.
  await page.window.fetch('/voyager/api/graphql', { method: 'POST', body: '{"fresh":true}' });
  assert.equal((await page.evaluate(recordedWritesExpression())).length, 1);
});

test('replay refuses anything that is not a same-origin voyager path or a real JSON write', () => {
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
    '/feed/update',
    '',
  ];
  for (const url of hostileUrls) {
    assert.throws(() => replayWriteExpression({ ...base, url }), /same-origin \/voyager\/api\/ path/, url);
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
  const recorded = await page.evaluate(recordedWritesExpression()) as RecordedWrite[];
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
