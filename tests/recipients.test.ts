import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mailSenderName, replyRecipients } from '../src/recipients.ts';

test('reply-all removes self and duplicates across headers', () => {
  assert.deepEqual(replyRecipients({from:'Alice <alice@example.com>',replyTo:'Reply <reply@example.com>',to:'Me <me@example.com>, Alice <alice@example.com>',cc:'REPLY@example.com, Bob <bob@example.com>',self:'me@example.com'}), {to:'reply@example.com',cc:'alice@example.com, bob@example.com'});
});
test('reply to sent message targets other recipients', () => {
  assert.deepEqual(replyRecipients({from:'Me <ME@example.com>',replyTo:'',to:'Person <person@example.com>, me@example.com',cc:'person@example.com',self:'me@example.com'}),{to:'person@example.com',cc:''});
});
test('sender name prefers the display name over the address', () => {
  assert.equal(mailSenderName('Ada Lovelace <ada@example.com>'), 'Ada Lovelace');
  assert.equal(mailSenderName('"Ada Lovelace" <ada@example.com>'), 'Ada Lovelace');
  assert.equal(mailSenderName('ada@example.com'), 'ada@example.com');
  assert.equal(mailSenderName(''), 'Unknown sender');
});
test('empty or invalid sender does not invent a recipient', () => {
  assert.deepEqual(replyRecipients({from:'',replyTo:'',to:'',cc:'',self:'me@example.com'}),{to:'',cc:''});
});
