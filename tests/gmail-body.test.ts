import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { pickGmailBodies } from '../src/gmail-body.ts';

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
