// INBOX-38 — the People API behind `src/google-people.ts`.
//
// Two listings, one per grant, and the shapes `src/gmail-faces.ts` reads: address → photo. A refusal
// arrives as `PeopleApiError` carrying Google's own status, because 403 is the difference between
// "this account has not consented" and "something broke".
import assert from 'node:assert/strict';
import test from 'node:test';
import { createPeopleClient, PeopleApiError } from '../src/google-people.ts';

const TOKEN = 'ya29.a0AfH6SMBx9TcdefGHijklmnopqrstuvwxyz1234567890';
const PHOTO = 'https://lh3.googleusercontent.com/a/ACg8ocPhoto=s96-c';

interface Request {
  url: URL;
  authorization: string;
}

/** One answer per call, in order; the request is recorded as it was sent. */
function stubFetch(answers: { status: number; body: unknown }[]) {
  const requests: Request[] = [];
  const fetch = async (url: string, init: { headers: Record<string, string> }) => {
    requests.push({ url: new URL(url), authorization: init.headers.authorization });
    const answer = answers[Math.min(requests.length - 1, answers.length - 1)];
    return {
      ok: answer.status >= 200 && answer.status < 300,
      status: answer.status,
      text: async () => (typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body)),
    };
  };
  return { fetch, requests };
}

function client(fetch: ReturnType<typeof stubFetch>['fetch'], force: { count: number } = { count: 0 }) {
  return createPeopleClient({
    account: 'gmail-personal',
    credentials: {
      accessToken: async (_account, options) => {
        if (options?.force) force.count += 1;
        return TOKEN;
      },
    },
    fetch,
  });
}

test('saved contacts and other contacts are two listings, each asking for just the two masks a face needs', async () => {
  const { fetch, requests } = stubFetch([
    { status: 200, body: { connections: [{ emailAddresses: [{ value: 'Ada@Example.com' }, { value: 'ada@work.example' }], photos: [{ url: PHOTO }] }] } },
    { status: 200, body: { otherContacts: [{ emailAddresses: [{ value: 'stranger@example.com' }], photos: [{ url: PHOTO }] }, { emailAddresses: [{ value: 'nophoto@example.com' }] }] } },
  ]);
  const people = client(fetch);

  assert.deepEqual(await people.connections(), {
    photos: [{ address: 'ada@example.com', url: PHOTO }, { address: 'ada@work.example', url: PHOTO }],
  }, 'a face belongs to the person, so every address of that person answers it, lowercased');
  assert.deepEqual(await people.otherContacts(), {
    photos: [{ address: 'stranger@example.com', url: PHOTO }],
  }, 'a person with no photo is not a photo');

  assert.equal(requests[0].url.pathname, '/v1/people/me/connections');
  assert.equal(requests[0].url.searchParams.get('personFields'), 'emailAddresses,photos');
  assert.equal(requests[0].url.searchParams.get('pageSize'), '1000');
  assert.equal(requests[1].url.pathname, '/v1/otherContacts');
  assert.equal(requests[1].url.searchParams.get('readMask'), 'emailAddresses,photos');
  assert.equal(requests[0].authorization, `Bearer ${TOKEN}`);
});

test('a page token is carried, and the last page says so by carrying none', async () => {
  const { fetch, requests } = stubFetch([
    { status: 200, body: { connections: [{ emailAddresses: [{ value: 'one@example.com' }], photos: [{ url: PHOTO }] }], nextPageToken: 'page-2' } },
    { status: 200, body: { connections: [{ emailAddresses: [{ value: 'two@example.com' }], photos: [{ url: PHOTO }] }] } },
  ]);
  const people = client(fetch);
  const first = await people.connections();
  assert.equal(first.nextPageToken, 'page-2');
  const second = await people.connections(first.nextPageToken);
  assert.equal(second.nextPageToken, undefined, 'the last page is the one without a token');
  assert.equal(requests[1].url.searchParams.get('pageToken'), 'page-2');
});

test('a refusal keeps Google’s status and never carries the token into its message', async () => {
  const { fetch } = stubFetch([{ status: 403, body: { error: { status: 'forbidden', message: 'Request had insufficient authentication scopes.' } } }]);
  await assert.rejects(client(fetch).connections(), (error: unknown) => {
    assert.ok(error instanceof PeopleApiError);
    assert.equal(error.status, 403, 'the caller tells "not granted" from "broken" by the status');
    assert.equal(error.reason, 'forbidden');
    assert.ok(!error.message.includes(TOKEN), 'the credential never reaches a log line');
    return true;
  });
});

test('a 401 buys one forced refresh and one retry, then the same request stands', async () => {
  const { fetch, requests } = stubFetch([
    { status: 401, body: { error: { status: 'unauthenticated', message: 'Invalid Credentials' } } },
    { status: 200, body: { connections: [] } },
  ]);
  const force = { count: 0 };
  const people = client(fetch, force);
  await people.connections();
  assert.equal(requests.length, 2, 'a token that expired mid-flight is worth exactly one retry');
  assert.equal(force.count, 1, 'and the retry is a forced grant, not the cached token again');
});

test('a body that is not JSON is a failure with the request named, not a silent empty book', async () => {
  const { fetch } = stubFetch([{ status: 502, body: '<html>bad gateway</html>' }]);
  await assert.rejects(client(fetch).otherContacts(), /People API otherContacts failed \(502\)/);
});
