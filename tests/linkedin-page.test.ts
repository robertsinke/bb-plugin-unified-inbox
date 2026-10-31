import assert from 'node:assert/strict';
import test from 'node:test';
import { LINKEDIN_PREVIEW_LABELS, linkedinPageExpression } from '../src/linkedin-page.ts';

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (...args: string[]) => Function;

const CONVERSATION = 'urn:li:msg_conversation:(urn:li:fsd_profile:ACoAAme,2-YWJj)';
const SENDER = 'urn:li:fsd_profile:ACoAAada';
const PHOTO =
  'https://media.licdn.com/dms/image/v2/D4E22AQphoto/900/0/1700000000000?e=1&v=beta&t=sig900';

/** One message event, as the messengerMessages payload returns it (every content key present, only one set). */
function message(overrides: Record<string, unknown>) {
  return {
    $type: 'com.linkedin.messenger.Message',
    entityUrn: 'urn:li:msg_message:(urn:li:msg_conversation:(urn:li:fsd_profile:ACoAAme,2-YWJj),2-ZGVm)',
    '*sender': SENDER,
    deliveredAt: 1_800_000_000_000,
    body: { text: '' },
    renderContent: [{}],
    ...overrides,
  };
}

/** LinkedIn's display image: the largest element carries the https identifier, artifacts are the fallback. */
function vectorImage(identifier: string) {
  return {
    $type: 'com.linkedin.voyager.common.ImageAttribute',
    rootUrl: 'https://media.licdn.com/dms/image/v2/D4E22AQphoto/',
    artifacts: [
      { fileIdentifyingUrlPathSegment: '400/0/1700000000000?e=1&v=beta&t=sig400', width: 400, height: 400 },
      { fileIdentifyingUrlPathSegment: '900/0/1700000000000?e=1&v=beta&t=sig900', width: 900, height: 900 },
    ],
    elements: [
      { dimensions: { width: 400, height: 400 }, identifiers: [] },
      { dimensions: { width: 900, height: 900 }, identifiers: [{ identifier }] },
    ],
  };
}

/** Run the real page expression against a stubbed LinkedIn: one thread, no browser. */
async function readThread(messages: unknown[]): Promise<{ messages: Array<Record<string, any>> }> {
  const routes: Record<string, unknown> = {
    '/voyager/api/me': { data: { '*miniProfile': 'urn:li:fs_miniProfile:ACoAAme' }, included: [] },
    'messengerMessages': { included: messages },
    'identity/dash/profiles': { included: [{ firstName: 'Ada', lastName: 'Lovelace' }] },
  };
  const requested: string[] = [];
  const fetcher = async (url: string) => {
    requested.push(url);
    const match = Object.entries(routes).find(([part]) => String(url).includes(part));
    if (!match) throw new Error(`unexpected URL ${url}`);
    return { ok: true, status: 200, text: async () => JSON.stringify(match[1]) };
  };
  const expression = linkedinPageExpression({ mode: 'thread', id: CONVERSATION });
  const run = new AsyncFunction('document', 'fetch', `return (${expression});`);
  const result = await run({ cookie: 'JSESSIONID="AQEDARtoken"' }, fetcher);
  assert.equal(result.ok, true, result.error);
  return result.payload as { messages: Array<Record<string, any>> };
}

test('LinkedIn Browser-page expression compiles and reads only through same-origin fetch', () => {
  const expression = linkedinPageExpression({ mode: 'list' });
  assert.doesNotThrow(() => new AsyncFunction(`return (${expression});`));
  assert.match(expression, /credentials: 'include'/);
  assert.match(expression, /voyagerMessagingGraphQL/);
  assert.doesNotMatch(expression, /\.goto\(|browser\.getPage|document\.cookie\s*=/);
});

test('LinkedIn thread identifier is safely serialized into the page expression', () => {
  const expression = linkedinPageExpression({ mode: 'thread', id: 'urn:li:msg_conversation:123' });
  assert.match(expression, /urn:li:msg_conversation:123/);
  assert.doesNotThrow(() => new AsyncFunction(`return (${expression});`));
});

test('a message without text still previews through its render content', () => {
  // The payload inlines messages; the ones without text carry renderContent instead (a shared post, a file, media).
  assert.equal(LINKEDIN_PREVIEW_LABELS.feed_update, 'Shared a post');
  assert.equal(LINKEDIN_PREVIEW_LABELS.file, 'File');
  const expression = linkedinPageExpression({ mode: 'list' });
  assert.match(expression, /renderContent/);
  assert.match(expression, /FEED_UPDATE/);
  assert.ok(expression.includes(JSON.stringify(LINKEDIN_PREVIEW_LABELS)));
  assert.doesNotThrow(() => new AsyncFunction(`return (${expression});`));
});

test('a photo message reads out the largest element on the LinkedIn CDN', async () => {
  const payload = await readThread([message({ renderContent: [{ vectorImage: vectorImage(PHOTO) }] })]);
  assert.equal(payload.messages.length, 1);
  assert.equal(payload.messages[0].mediaUrl, PHOTO);
  assert.equal(payload.messages[0].activityUrn, '');
  assert.equal(payload.messages[0].text, '');
  assert.equal(payload.messages[0].id, 'urn:li:msg_message:(urn:li:msg_conversation:(urn:li:fsd_profile:ACoAAme,2-YWJj),2-ZGVm)');
});

test('a photo with no identifiers falls back to the root URL and its last artifact', async () => {
  const payload = await readThread([message({ renderContent: [{ vectorImage: vectorImage('') }] })]);
  assert.equal(payload.messages[0].mediaUrl, PHOTO);
});

test('an image hosted off the LinkedIn CDN is not a photo', async () => {
  const payload = await readThread([message({ renderContent: [{ vectorImage: vectorImage('https://evil.example/photo.png') }] })]);
  assert.equal(payload.messages[0].mediaUrl, '');
  // A hostile root URL is refused the same way, on the artifact fallback too.
  const hostile = vectorImage('');
  hostile.rootUrl = 'https://evil.example/dms/image/';
  hostile.elements[1].identifiers = [];
  const fallback = await readThread([message({ renderContent: [{ vectorImage: hostile }] })]);
  assert.equal(fallback.messages[0].mediaUrl, '');
});

test('a shared post reads out its activity urn and invents no image', async () => {
  const payload = await readThread([message({
    renderContent: [{
      hostUrnData: {
        $type: 'com.linkedin.messenger.HostUrnData',
        type: 'FEED_UPDATE',
        hostUrn: 'urn:li:fsd_update:(urn:li:activity:7123456789012345678,aBcD_DeF,EMPTY,UUID,false)',
      },
    }],
  })]);
  assert.equal(payload.messages[0].activityUrn, 'urn:li:activity:7123456789012345678');
  assert.equal(payload.messages[0].mediaUrl, '');
});

test('a text message keeps its text and gains no media', async () => {
  const payload = await readThread([message({ body: { text: 'See you at six' }, renderContent: [{}] })]);
  assert.equal(payload.messages[0].text, 'See you at six');
  assert.equal(payload.messages[0].mediaUrl, '');
  assert.equal(payload.messages[0].activityUrn, '');
});
