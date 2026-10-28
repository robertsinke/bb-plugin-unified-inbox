import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { buildGmailMime } from '../src/gmail-mime.ts';

test('reply MIME binds recipient, subject and original message', async () => {
  const raw=(await buildGmailMime({from:'me@example.com',to:'other@example.com',cc:'third@example.com',subject:'Re: Hello',text:'Hello there',inReplyTo:'<id@example.com>',references:'<id@example.com>'})).toString();
  assert.match(raw,/To: other@example.com/); assert.match(raw,/Cc: third@example.com/); assert.match(raw,/In-Reply-To: <id@example.com>/); assert.match(raw,/References: <id@example.com>/); assert.match(raw,/Hello there/);
});
test('rejects header injection', async () => {
  await assert.rejects(buildGmailMime({from:'me@example.com',to:'a@example.com\r\nBcc: x@example.com',cc:'',subject:'Hi',text:'Hello'}),/Invalid mail header/);
});
