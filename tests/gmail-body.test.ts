import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { findGmailAttachment, pickGmailAttachments, pickGmailBodies, pickGmailInline } from '../src/gmail-body.ts';

const plain = Buffer.from('Hello plain').toString('base64url');
const html = Buffer.from('<p>Hello <b>there</b></p>').toString('base64url');

test('prefers the html part and keeps plain text', () => {
  const bodies = pickGmailBodies({
    mimeType: 'multipart/alternative',
    parts: [
      { mimeType: 'text/plain', body: { data: plain } },
      { mimeType: 'text/html', body: { data: html } },
    ],
  });
  assert.equal(bodies.text, 'Hello plain');
  assert.equal(bodies.html, '<p>Hello <b>there</b></p>');
});

test('reports an html attachment when the body is not inline', () => {
  const bodies = pickGmailBodies({
    mimeType: 'multipart/mixed',
    parts: [{ mimeType: 'text/html', body: { attachmentId: 'att-1', size: 1200 } }],
  });
  assert.equal(bodies.html, '');
  assert.equal(bodies.htmlAttachmentId, 'att-1');
});

test('attachment filenames are indexed without their file bodies', () => {
  const names = pickGmailAttachments({ parts: [
    { mimeType: 'multipart/alternative', parts: [{ mimeType: 'text/plain', body: { data: plain } }] },
    { mimeType: 'application/pdf', filename: 'Invoice 2026.pdf', body: { attachmentId: 'a', size: 10 } },
    { mimeType: 'image/png', filename: 'photo.png', body: { attachmentId: 'b', size: 20 } },
    { mimeType: 'application/pdf', filename: 'Invoice   2026.pdf', body: { attachmentId: 'c', size: 10 } },
  ] });
  assert.deepEqual(names, ['Invoice 2026.pdf', 'photo.png']);
});

test('finds an attachment part by normalized filename without reading its data', () => {
  const part = findGmailAttachment({ parts: [
    { mimeType: 'text/plain', body: { data: plain } },
    { mimeType: 'application/pdf', filename: 'Invoice   2026.pdf', body: { attachmentId: 'a', size: 10 } },
  ] }, 'Invoice 2026.pdf');
  assert.equal(part?.attachmentId, 'a');
  assert.equal(part?.mimeType, 'application/pdf');
  assert.equal(part?.size, 10);
  assert.equal(part?.data, undefined);
});

test('an inline image is named by its content id and carries no bytes', () => {
  const images = pickGmailInline({ parts: [
    { mimeType: 'text/html', body: { data: html }, headers: [{ name: 'Content-ID', value: '<page>' }] },
    { mimeType: 'image/png', filename: 'logo.png', headers: [{ name: 'Content-ID', value: '<logo@mail>' }], body: { attachmentId: 'img' } },
    { mimeType: 'image/svg+xml', filename: 'mark.svg', headers: [{ name: 'Content-ID', value: '<mark>' }], body: { attachmentId: 'svg' } },
    { mimeType: 'image/jpeg', headers: [{ name: 'Content-ID', value: 'photo' }], body: { attachmentId: 'jpg' } },
  ] });
  assert.deepEqual(images, [
    { contentId: 'logo@mail', filename: 'logo.png' },
    { contentId: 'photo', filename: 'photo' },
  ]);
  const part = findGmailAttachment({ parts: [
    { mimeType: 'image/jpeg', headers: [{ name: 'Content-ID', value: '<photo>' }], body: { attachmentId: 'jpg' } },
  ] }, 'photo');
  assert.equal(part?.attachmentId, 'jpg');
  assert.equal(JSON.stringify(images).includes('data:'), false);
});
