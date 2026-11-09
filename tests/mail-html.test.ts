import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { JSDOM } from 'jsdom';
import { assignCidSources, drawnMailImage, mailDocument, sanitizeMailMarkup } from '../src/mail-html.ts';

test('drops scripts, event handlers, and javascript urls', () => {
  const clean = sanitizeMailMarkup(`<p onclick="steal()">Hi</p><script>alert(1)</script><a href="javascript:alert(1)">x</a><img src="data:image/png;base64,qq">`);
  assert.equal(clean.includes('script'), false);
  assert.equal(clean.includes('onclick'), false);
  assert.equal(clean.includes('javascript:'), false);
  assert.equal(clean.includes('data:image/png'), true);
  assert.equal(clean.includes('<p>Hi</p>'), true);
});

test('wraps the message on a white page that opens links in a new tab', () => {
  const page = mailDocument('<p>Hello</p>');
  assert.equal(page.includes('<base target="_blank">'), true);
  assert.equal(page.includes('background:#fff'), true);
  assert.equal(page.includes('height:auto!important'), true);
  assert.equal(page.includes('overflow:visible!important'), true);
  assert.equal(page.includes('<p>Hello</p>'), true);
});

test('a matching cid image becomes a data URL in the frame and other sources stay', () => {
  const dom = new JSDOM('<p>Hello</p><img src="cid:logo"><img src="https://cdn.example/a.png"><img src="cid:missing"><img src="cid:mark">');
  const stored = dom.window.document.body.innerHTML;
  assignCidSources(dom.window.document, {
    logo: 'data:image/png;base64,qq',
    mark: 'data:image/svg+xml;base64,qq',
  });
  const images = [...dom.window.document.querySelectorAll('img')];
  assert.equal(images[0].getAttribute('src'), 'data:image/png;base64,qq');
  assert.equal(images[1].getAttribute('src'), 'https://cdn.example/a.png');
  assert.equal(images[2].getAttribute('src'), 'cid:missing');
  assert.equal(images[3].getAttribute('src'), 'cid:mark');
  assert.equal(stored.includes('data:image'), false);
  assert.equal(drawnMailImage('data:image/svg+xml;base64,qq'), null);
  assert.equal(drawnMailImage('data:application/pdf;base64,qq'), null);
});
