// LinkedIn photos: the URL is a trust boundary (it arrives from a browser read
// and then from the cache), and the bytes must fit the inbox's shared image
// bound. Every case here proves a refusal happens before anything is fetched.
import assert from 'node:assert/strict';
import test from 'node:test';
import { linkedinCdnUrl, readLinkedInImage } from '../src/linkedin-media.ts';
import { IMAGE_LIMIT } from '../src/adapters/media.ts';

const PHOTO = 'https://media.licdn.com/dms/image/v2/D4E22AQphoto/900/0/1700000000000?e=1&v=beta&t=signature';
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]);

function answer(body: Uint8Array, headers: Record<string, string>): Response {
  return { ok: true, status: 200, headers: new Headers(headers), arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) } as unknown as Response;
}

/** Records the URL and options of each fetch, and answers with the given response. */
function stub(response: Response | (() => Promise<Response>)) {
  const calls: { url: string; options?: RequestInit }[] = [];
  const fetcher = (async (url: string, options?: RequestInit) => {
    calls.push({ url, options });
    return typeof response === 'function' ? response() : response;
  }) as unknown as typeof fetch;
  return { calls, fetcher };
}

test('only a first-party LinkedIn CDN URL is a photo', () => {
  assert.equal(linkedinCdnUrl(PHOTO), PHOTO);
  assert.equal(linkedinCdnUrl('https://licdn.com/dms/image/photo'), 'https://licdn.com/dms/image/photo');
  assert.equal(linkedinCdnUrl('http://media.licdn.com/dms/image/photo'), '');
  assert.equal(linkedinCdnUrl('https://media.licdn.com.evil.example/photo'), '');
  assert.equal(linkedinCdnUrl('https://evil.example/dms/image/photo'), '');
  assert.equal(linkedinCdnUrl('https://user:secret@media.licdn.com/photo'), '');
  assert.equal(linkedinCdnUrl('https://media.licdn.com:8443/photo'), '');
  assert.equal(linkedinCdnUrl('not a url'), '');
  assert.equal(linkedinCdnUrl(undefined), '');
  assert.equal(linkedinCdnUrl(`https://media.licdn.com/${'a'.repeat(5000)}`), '');
});

test('a photo outside the CDN is refused before any request', async () => {
  const { calls, fetcher } = stub(answer(PNG, { 'content-type': 'image/png' }));
  await assert.rejects(readLinkedInImage('https://evil.example/photo.png', fetcher), /not served by LinkedIn/);
  assert.deepEqual(calls, []);
});

test('a photo is fetched without following a redirect', async () => {
  const { calls, fetcher } = stub(answer(PNG, { 'content-type': 'image/png', 'content-length': String(PNG.byteLength) }));
  const payload = await readLinkedInImage(PHOTO, fetcher);
  assert.equal(payload.mime, 'image/png');
  assert.match(payload.dataUrl, /^data:image\/png;base64,/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, PHOTO);
  assert.equal(calls[0].options?.redirect, 'error');
});

test('the declared size is refused before the body is read', async () => {
  const body = answer(PNG, { 'content-type': 'image/png', 'content-length': String(IMAGE_LIMIT + 1) });
  await assert.rejects(readLinkedInImage(PHOTO, stub(body).fetcher), /too large/);
});

test('an oversized body is refused even when its size was not declared', async () => {
  const body = answer(new Uint8Array(IMAGE_LIMIT + 1), { 'content-type': 'image/png' });
  await assert.rejects(readLinkedInImage(PHOTO, stub(body).fetcher), /too large/);
});

test('only an image is rendered, and never an SVG', async () => {
  await assert.rejects(readLinkedInImage(PHOTO, stub(answer(PNG, { 'content-type': 'text/html' })).fetcher), /not an image/);
  await assert.rejects(readLinkedInImage(PHOTO, stub(answer(PNG, { 'content-type': 'image/svg+xml' })).fetcher), /Unsupported media type/);
});

test('a failed or unreachable fetch is reported as a photo that did not load', async () => {
  await assert.rejects(readLinkedInImage(PHOTO, stub(async () => { throw new Error('offline'); }).fetcher), /could not be loaded/);
  await assert.rejects(readLinkedInImage(PHOTO, stub({ ok: false, status: 403, headers: new Headers() } as unknown as Response).fetcher), /could not be loaded/);
});
