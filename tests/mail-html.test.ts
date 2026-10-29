import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mailDocument, sanitizeMailMarkup } from '../src/mail-html.ts';

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
