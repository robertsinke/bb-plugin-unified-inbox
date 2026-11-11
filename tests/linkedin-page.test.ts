import assert from 'node:assert/strict';
import test from 'node:test';
import { LINKEDIN_PREVIEW_LABELS, linkedinActivityUrn, linkedinPageExpression, linkedinPostExpression } from '../src/linkedin-page.ts';

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
  assert.equal(payload.messages[0].senderUrn, SENDER);
  assert.equal(payload.messages[0].mediaUrl, '');
  assert.equal(payload.messages[0].activityUrn, '');
});

// --- the walk back through the conversation list -------------------------------------------------
// The newest page is one by-sync-token read that ignores every paging variable ever tried against
// it. The rows behind it come from the query the web app scrolls with: a cursor-paged collection
// whose only working variable is the server's own `nextCursor`.
const OLDER_QUERY = 'messengerConversations.9501074288a12f3ae9e3c7ea243bccbf';
const OLDER_ID = 'urn:li:msg_conversation:(urn:li:fsd_profile:ACoAAme,2-bGRlcg==)';
const NEWEST_ID = 'urn:li:msg_conversation:(urn:li:fsd_profile:ACoAAme,2-bmV3ZXN0)';

/** One conversation as an older page inlines it: no participants, so no profile is looked up. */
function olderConversation(urn: string, extra: Record<string, unknown> = {}) {
  return {
    $type: 'com.linkedin.messenger.Conversation',
    entityUrn: urn,
    title: 'Grace Hopper',
    descriptionText: 'Older note',
    lastActivityAt: 1_600_000_000_000,
    unreadCount: 0,
    '*conversationParticipants': [],
    ...extra,
  };
}

/** One page of the older read: the row urns in order, the entities inlined, and the cursor it hands back. */
function olderPage(urns: string[], nextCursor: string): unknown {
  return {
    data: { data: { messengerConversationsByCategoryQuery: { metadata: nextCursor ? { nextCursor } : {}, '*elements': urns } } },
    included: urns.map(urn => olderConversation(urn)),
  };
}

/** Run the page expression against a stubbed LinkedIn, recording every URL it asked for. */
async function readOlder(expression: string, answer: (url: string) => unknown): Promise<{ payload: any; requested: string[] }> {
  const requested: string[] = [];
  const fetcher = async (url: string) => {
    requested.push(url);
    return { ok: true, status: 200, text: async () => JSON.stringify(answer(url)) };
  };
  const run = new AsyncFunction('document', 'fetch', `return (${expression});`);
  const result = await run({ cookie: 'JSESSIONID="AQEDARtoken"' }, fetcher);
  assert.equal(result.ok, true, result.error);
  return { payload: result.payload, requested };
}

const ME = { data: { '*miniProfile': 'urn:li:fs_miniProfile:ACoAAme' }, included: [] };

test('the newest conversation page is read exactly as it was: one by-sync-token call, no cursor', async () => {
  const { requested } = await readOlder(linkedinPageExpression({ mode: 'list' }), url => {
    if (url.includes('/voyager/api/me')) return ME;
    if (url.includes('messengerConversations.0d5e6781bbee71c3e51c8843c6519f48')) return { data: {}, included: [] };
    if (url.includes('invitationViews')) return { included: [] };
    throw new Error(`unexpected URL ${url}`);
  });
  assert.deepEqual(requested.map(url => url.split('?')[0].split('/').at(-1)), ['me', 'graphql', 'invitationViews']);
  assert.ok(requested[1].endsWith(`variables=(mailboxUrn:${encodeURIComponent('urn:li:fsd_profile:ACoAAme')})`), requested[1]);
  assert.equal(requested.filter(url => url.includes(OLDER_QUERY)).length, 0, 'the newest page is not the paged read');
  assert.equal(requested.filter(url => url.includes('nextCursor')).length, 0, 'and it names no cursor');
});

test('a newest line you sent is marked on the list row', async () => {
  const expression = linkedinPageExpression({ mode: 'list' });
  const text = 'I will read it today.';
  const conversation = olderConversation(NEWEST_ID, { descriptionText: text });
  const own = {
    $type: 'com.linkedin.messenger.Message',
    '*conversation': NEWEST_ID,
    '*sender': 'urn:li:fsd_profile:ACoAAme',
    deliveredAt: 1_700_000_000_000,
    body: { text },
    renderContent: [{}],
  };
  const { payload } = await readOlder(expression, url => {
    if (url.includes('/voyager/api/me')) return ME;
    if (url.includes('messengerConversations')) return { data: {}, included: [conversation, own] };
    if (url.includes('invitationViews')) return { included: [] };
    throw new Error(`unexpected URL ${url}`);
  });
  assert.equal(payload.conversations[0].fromMe, true);
  assert.equal(payload.conversations[0].preview, text);
});

test('an older page asks the pinned paged query for the cursor it was handed', async () => {
  const expression = linkedinPageExpression({ mode: 'older', cursor: 'REVTQ0VORElORyYxNzkxJjItYWJj+/=', count: 20 });
  const { payload, requested } = await readOlder(expression, url => {
    if (url.includes('/voyager/api/me')) return ME;
    if (url.includes(OLDER_QUERY)) return olderPage([OLDER_ID], 'NEXT_CURSOR+/=');
    throw new Error(`unexpected URL ${url}`);
  });
  // One identity read and one page: an older page opens no conversation, reads no invitations and
  // looks no profile up.
  assert.equal(requested.length, 2);
  const page = requested[1];
  assert.match(page, new RegExp(OLDER_QUERY.replace(/\./g, '\\.')));
  assert.match(page, /count:20/);
  assert.match(page, /PRIMARY_INBOX/);
  assert.ok(page.includes(`nextCursor:${encodeURIComponent('REVTQ0VORElORyYxNzkxJjItYWJj+/=')}`), page);
  assert.equal(payload.nextCursor, 'NEXT_CURSOR+/=');
  assert.deepEqual(payload.conversations, [{
    id: OLDER_ID, title: 'Grace Hopper', preview: 'Older note', date: 1_600_000_000_000, unread: false, sender: '',
  }]);
});

test('the first older press returns the first primary page and the cursor it handed back', async () => {
  const expression = linkedinPageExpression({ mode: 'older', cursor: 'start', count: 20 });
  const { payload, requested } = await readOlder(expression, url => {
    if (url.includes('/voyager/api/me')) return ME;
    if (url.includes('nextCursor:')) throw new Error('the first press must not skip this page');
    if (url.includes(OLDER_QUERY)) return olderPage([NEWEST_ID], 'CUR+/=');
    throw new Error(`unexpected URL ${url}`);
  });
  // The sync-token page is a different window. This page can hold primary conversations that
  // window never showed, so its rows are the answer. The panel drops the ones it already has.
  assert.equal(requested.length, 2);
  assert.doesNotMatch(requested[1].split('?')[1], /nextCursor/, 'the first read carries no cursor');
  assert.deepEqual(payload.conversations.map((row: { id: string }) => row.id), [NEWEST_ID]);
  assert.equal(payload.nextCursor, 'CUR+/=');
});

test('a first page with no further cursor returns its rows and ends the walk', async () => {
  const expression = linkedinPageExpression({ mode: 'older', cursor: 'start', count: 20 });
  const { payload, requested } = await readOlder(expression, url => {
    if (url.includes('/voyager/api/me')) return ME;
    if (url.includes(OLDER_QUERY)) return olderPage([NEWEST_ID], '');
    throw new Error(`unexpected URL ${url}`);
  });
  assert.equal(requested.length, 2, 'one page, and nothing after it');
  assert.deepEqual(payload.conversations.map((row: { id: string }) => row.id), [NEWEST_ID]);
  assert.equal(payload.nextCursor, '');
});

const UPDATE_IMAGE = 'https://media.licdn.com/dms/image/v2/D4E22AQpost/900/0/1700000000000?e=1&v=beta&t=sig900';

/** One captured UpdateV2, reduced to the fields the card reads. Cookies are not part of this fixture. */
function updateFixture(overrides: { title?: string; author?: string; image?: boolean } = {}) {
  const image = overrides.image === false ? undefined : {
    images: [{
      attributes: [{
        vectorImage: {
          rootUrl: 'https://media.licdn.com/dms/image/v2/D4E22AQpost/',
          artifacts: [{ fileIdentifyingUrlPathSegment: '900/0/1700000000000?e=1&v=beta&t=sig900', width: 900 }],
        },
      }],
    }],
  };
  return {
    included: [{
      $type: 'com.linkedin.voyager.feed.render.UpdateV2',
      commentary: { text: { text: overrides.title ?? 'A note about the work' } },
      actor: { name: { text: overrides.author ?? 'Ada Lovelace' } },
      ...(image ? { content: image } : {}),
    }],
  };
}

async function readPost(activityUrn: string, body: unknown) {
  const requested: string[] = [];
  const fetcher = async (url: string) => {
    requested.push(url);
    if (!String(url).includes('/voyager/api/feed/updates/')) throw new Error(`unexpected URL ${url}`);
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  const expression = linkedinPostExpression(activityUrn);
  const run = new AsyncFunction('document', 'fetch', `return (${expression});`);
  const result = await run({ cookie: 'JSESSIONID="AQEDARtoken"' }, fetcher);
  return { result, requested };
}

test('a shared post read returns the words, the author, and the CDN image', async () => {
  const { result, requested } = await readPost('urn:li:activity:7123456789012345678', updateFixture());
  assert.equal(result.ok, true, result.error);
  assert.equal(result.payload.title, 'A note about the work');
  assert.equal(result.payload.author, 'Ada Lovelace');
  assert.equal(result.payload.imageUrl, UPDATE_IMAGE);
  assert.match(requested[0], /\/voyager\/api\/feed\/updates\/urn%3Ali%3Aactivity%3A7123456789012345678/);
});

test('a shared post with no picture keeps the words and an empty image', async () => {
  const { result } = await readPost('urn:li:activity:1', updateFixture({ image: false }));
  assert.equal(result.ok, true, result.error);
  assert.equal(result.payload.title, 'A note about the work');
  assert.equal(result.payload.imageUrl, '');
});

test('a shared post image off the LinkedIn CDN is dropped', async () => {
  const body = updateFixture();
  const update = body.included[0];
  assert.ok(update?.content);
  update.content.images[0].attributes[0].vectorImage.rootUrl = 'https://evil.example/dms/';
  const { result } = await readPost('urn:li:activity:1', body);
  assert.equal(result.ok, true, result.error);
  assert.equal(result.payload.imageUrl, '');
  assert.equal(result.payload.title, 'A note about the work');
});

test('a feed payload that is not an update is a failure', async () => {
  const { result } = await readPost('urn:li:activity:1', { included: [] });
  assert.equal(result.ok, false);
  assert.match(result.error, /did not return that post/);
});

test('an id that is not an activity urn is refused before the page runs', () => {
  assert.throws(() => linkedinPostExpression('urn:li:fsd_update:(urn:li:activity:1)'), /not a LinkedIn post/);
  assert.throws(() => linkedinActivityUrn('https://evil.example'), /not a LinkedIn post/);
  assert.doesNotThrow(() => linkedinPostExpression('urn:li:activity:7123456789012345678'));
});

const ADA = 'urn:li:fsd_profile:ACoAAada';
const OTHER = 'urn:li:fsd_profile:ACoAAother';
const COMPANY = 'urn:li:fsd_company:1441';

function memberConversation(participants: string[]) {
  return olderConversation(NEWEST_ID, {
    title: '',
    descriptionText: 'Hello',
    '*conversationParticipants': ['urn:li:fsd_profile:ACoAAme', ...participants],
  });
}

function profileEntity(urn: string, slug: string, firstName = 'Ada') {
  return { entityUrn: urn, firstName, lastName: 'Lovelace', publicIdentifier: slug };
}

/** One newest-page read. A profile route throws when `failProfile` is set. */
async function readList(participants: string[], profiles: unknown[], failProfile = false, data?: unknown) {
  const expression = linkedinPageExpression({ mode: 'list' });
  return readOlder(expression, url => {
    if (url.includes('/voyager/api/me')) return ME;
    if (url.includes('identity/dash/profiles')) {
      if (failProfile) throw new Error('profile down');
      return { ...(data ? { data } : {}), included: profiles };
    }
    if (url.includes('organization/companies')) return { data: { localizedName: 'Acme' } };
    if (url.includes('messengerConversations')) return { data: {}, included: [memberConversation(participants)] };
    if (url.includes('invitationViews')) return { included: [] };
    throw new Error(`unexpected URL ${url}`);
  });
}

test('one other member copies publicIdentifier from the profile that was requested', async () => {
  const { payload } = await readList([ADA], [
    profileEntity(OTHER, 'not-ada', 'Other'),
    profileEntity(ADA, 'ada-lovelace'),
  ]);
  assert.equal(payload.conversations[0].publicIdentifier, 'ada-lovelace');
  assert.equal(payload.conversations[0].sender, 'Ada Lovelace');
  assert.equal(payload.conversations[0].profileMiss, undefined);
});

test('a publicIdentifier on the matching profile data is the counterpart when included is empty', async () => {
  const { payload } = await readList([ADA], [profileEntity(OTHER, 'not-ada', 'Other')], false, {
    entityUrn: ADA,
    firstName: 'Ada',
    lastName: 'Lovelace',
    publicIdentifier: 'ada-lovelace',
  });
  assert.equal(payload.conversations[0].publicIdentifier, 'ada-lovelace');
  assert.equal(payload.conversations[0].sender, 'Ada Lovelace');
  assert.equal(payload.conversations[0].profileMiss, undefined);
});

test('a publicIdentifier on a different named entity is not the counterpart', async () => {
  const { payload } = await readList([ADA], [profileEntity(OTHER, 'not-ada', 'Other')]);
  assert.equal(payload.conversations[0].publicIdentifier, undefined);
  assert.equal(payload.conversations[0].profileMiss, undefined);
});

test('a failed profile request is a miss and still returns the row', async () => {
  const { payload } = await readList([ADA], [], true);
  assert.equal(payload.conversations.length, 1);
  assert.equal(payload.conversations[0].publicIdentifier, undefined);
  assert.equal(payload.conversations[0].profileMiss, true);
});

test('a group, a company page, and a conversation with no counterpart carry no identifier', async () => {
  const group = await readList([ADA, OTHER], [profileEntity(ADA, 'ada-lovelace'), profileEntity(OTHER, 'other-person', 'Grace')]);
  assert.equal(group.payload.conversations[0].publicIdentifier, undefined);
  const company = await readList([COMPANY], []);
  assert.equal(company.payload.conversations[0].publicIdentifier, undefined);
  assert.equal(company.payload.conversations[0].profileMiss, undefined);
  const empty = await readList([], []);
  assert.equal(empty.payload.conversations[0].publicIdentifier, undefined);
});

test('a cursor or a page size LinkedIn could not quote is refused before the page runs', () => {
  // The cursor is serialized as JSON, so this is a refusal of nonsense rather than an escape.
  assert.throws(() => linkedinPageExpression({ mode: 'older', cursor: "x')||fetch('//evil", count: 20 }), /not a page of LinkedIn conversations/);
  assert.throws(() => linkedinPageExpression({ mode: 'older', cursor: '', count: 20 }), /not a page of LinkedIn conversations/);
  // Above the measured ceiling the source answers an empty collection with status 200, so a page
  // that size is refused here instead of reading as "there is nothing older".
  assert.throws(() => linkedinPageExpression({ mode: 'older', cursor: 'start', count: 26 }), /1 to 25/);
  assert.throws(() => linkedinPageExpression({ mode: 'older', cursor: 'start', count: 0 }), /1 to 25/);
});
