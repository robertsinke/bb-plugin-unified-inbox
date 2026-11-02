import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { buildGmailMime } from '../src/gmail-mime.ts';

test('reply MIME binds recipient, subject and original message', async () => {
  const raw=(await buildGmailMime({from:'me@example.com',to:'other@example.com',cc:'third@example.com',bcc:'',subject:'Re: Hello',text:'Hello there',inReplyTo:'<id@example.com>',references:'<id@example.com>'})).toString();
  assert.match(raw,/To: other@example.com/); assert.match(raw,/Cc: third@example.com/); assert.match(raw,/In-Reply-To: <id@example.com>/); assert.match(raw,/References: <id@example.com>/); assert.match(raw,/Hello there/);
});
test('rejects header injection', async () => {
  await assert.rejects(buildGmailMime({from:'me@example.com',to:'a@example.com\r\nBcc: x@example.com',cc:'',bcc:'',subject:'Hi',text:'Hello'}),/Invalid mail header/);
});

test('a blind copy is a header of its own, and cannot smuggle another one', async () => {
  const raw = (await buildGmailMime({ from: 'me@example.com', to: 'other@example.com', cc: '', bcc: 'hidden@example.com', subject: 'Hi', text: 'Hello' })).toString('utf8');
  assert.match(raw, /^Bcc: hidden@example\.com$/m, 'a bcc recipient never appears in To or Cc');
  await assert.rejects(
    buildGmailMime({ from: 'me@example.com', to: 'a@example.com', cc: '', bcc: 'hidden@example.com\r\nBcc: extra@example.com', subject: 'Hi', text: 'Hello' }),
    'a bcc is a header like any other: a line break in it is refused, not encoded',
  );
});

test('an attachment is a MIME part with its own name and type', async () => {
  const data = Buffer.from('hello').toString('base64');
  const raw = (await buildGmailMime({ from: 'me@example.com', to: 'a@example.com', cc: '', bcc: '', subject: 'Hi', text: 'See attached', attachments: [{ name: 'plan.txt', mimeType: 'text/plain', size: 5, data }] })).toString('utf8');
  assert.match(raw, /Content-Type: multipart\/mixed/, 'a message with a file is a multipart message');
  assert.match(raw, /Content-Disposition: attachment; filename="?plan\.txt"?/);
  assert.match(raw, /aGVsbG8=/, 'the bytes travel as base64');
});
