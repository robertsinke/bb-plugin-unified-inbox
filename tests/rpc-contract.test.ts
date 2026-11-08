// The RPC contract is a module, not a side effect of the plugin entry point, so a
// schema edit can be proved by a test instead of only by a live call. Every check
// here is a claim a caller can rely on.
import assert from 'node:assert/strict';
import test from 'node:test';
import { message, rpcContract } from '../src/rpc-contract.ts';
import { REACTION_SET } from '../src/reaction-set.ts';

test('a minimal Gmail send reaches the policy, not a schema refusal', () => {
  const parsed = rpcContract.send_gmail.input.safeParse({
    account: 'gmail-personal',
    to: 'ada@example.com',
    subject: 'Dinner',
    text: 'See you at six',
  });
  assert.equal(parsed.success, true, 'to, subject and text are enough; cc is optional');
});

test('a Gmail send can carry the send statement, so enabling it is a policy flip', () => {
  const parsed = rpcContract.send_gmail.input.safeParse({
    account: 'gmail-personal',
    to: 'ada@example.com',
    cc: 'grace@example.com',
    subject: 'Dinner',
    text: 'See you at six',
    allow: 'send',
  });
  assert.equal(parsed.success, true, 'the same word the chat send path uses');
  const refused = rpcContract.send_gmail.input.safeParse({
    account: 'gmail-personal',
    to: 'ada@example.com',
    subject: 'Dinner',
    text: 'See you at six',
    allow: 'please',
  });
  assert.equal(refused.success, false, 'and only that exact word');
});

test('a chat send says allow: send, and an unknown field is still refused', () => {
  const ok = rpcContract.action.input.safeParse({ account: 'whatsapp', id: 'c', action: 'reply', text: 'hi', allow: 'send' });
  assert.equal(ok.success, true);
  const typo = rpcContract.action.input.safeParse({ account: 'whatsapp', id: 'c', action: 'reply', text: 'hi', allows: 'send' });
  assert.equal(typo.success, false, 'a mistyped approval field is refused rather than ignored');
});

test('a reaction names a message and one of the four, and a reply may name a message', () => {
  const like = REACTION_SET.find(item => item.label === 'like')!.emoji;
  const react = rpcContract.action.input.safeParse({ account: 'whatsapp', id: 'c', action: 'react', messageId: 'm1', emoji: like, allow: 'send' });
  assert.equal(react.success, true, 'react with a message id and one of the four passes');
  const reply = rpcContract.action.input.safeParse({ account: 'whatsapp', id: 'c', action: 'reply', text: 'hi', messageId: 'm1', allow: 'send' });
  assert.equal(reply.success, true, 'a reply may name the message it answers');
  const conversation = rpcContract.action.input.safeParse({ account: 'whatsapp', id: 'c', action: 'reply', text: 'hi', allow: 'send' });
  assert.equal(conversation.success, true, 'a reply with no message id is still a conversation reply');
  const removal = rpcContract.action.input.safeParse({ account: 'whatsapp', id: 'c', action: 'react', messageId: 'm1', emoji: like, remove: true, allow: 'send' });
  assert.equal(removal.success, true, 'remove with a listed emoji passes the schema');
  const quoted = message.parse({ sender: 'Ada', text: 'ok', date: 1, replyTo: '<mail@id>', replyContext: true, quote: { targetId: 'm1', sender: 'Grace', text: 'earlier' } });
  assert.equal(quoted.replyTo, '<mail@id>', 'replyTo stays the mail header');
  assert.equal(quoted.replyContext, true, 'replyContext stays in place');
  assert.deepEqual(quoted.quote, { targetId: 'm1', sender: 'Grace', text: 'earlier' });
});

test('an emoji outside the four, an empty reaction target, and an unknown field are refused', () => {
  const outside = rpcContract.action.input.safeParse({ account: 'imessage', id: 'c', action: 'react', messageId: 'm1', emoji: '‼️', allow: 'send' });
  assert.equal(outside.success, false, 'emphasis is not one of the four');
  const question = rpcContract.action.input.safeParse({ account: 'imessage', id: 'c', action: 'react', messageId: 'm1', emoji: '❓', allow: 'send' });
  assert.equal(question.success, false, 'question is not one of the four');
  const empty = rpcContract.action.input.safeParse({ account: 'whatsapp', id: 'c', action: 'react', messageId: '', emoji: REACTION_SET[0].emoji, allow: 'send' });
  assert.equal(empty.success, false, 'an empty message id on react is refused');
  const missing = rpcContract.action.input.safeParse({ account: 'whatsapp', id: 'c', action: 'react', emoji: REACTION_SET[0].emoji, allow: 'send' });
  assert.equal(missing.success, false, 'a reaction with no message id is refused');
  const extra = rpcContract.action.input.safeParse({ account: 'whatsapp', id: 'c', action: 'react', messageId: 'm1', emoji: REACTION_SET[0].emoji, emphasis: true });
  assert.equal(extra.success, false, 'an unknown action field is refused');
});

test('a send decision that was allowed has no reason, and the contract says so', () => {
  const allowed = {
    rows: [{
      at: 1,
      account: 'whatsapp',
      conversationId: 'chat-1',
      decision: 'allowed',
      // the gate writes a reason only when it refuses; an allowance has nothing to explain
      reason: null,
    }],
  };
  assert.equal(rpcContract.send_audit.output.safeParse(allowed).success, true, 'an allowed row with a null reason must parse');

  const refused = { rows: [{ ...allowed.rows[0], decision: 'refused', reason: 'nothing was sent' }] };
  assert.equal(rpcContract.send_audit.output.safeParse(refused).success, true, 'a refusal keeps its reason');
  // A blind copy is who the message reached silently; an old row has no such column at all, so
  // null and missing must both be readable rather than thrown away.
  const copying = { rows: [{ ...allowed.rows[0], bcc: 'quiet@example.com' }] };
  assert.equal(rpcContract.send_audit.output.safeParse(copying).success, true, 'a row remembers the blind copy');
  assert.equal(rpcContract.send_audit.output.safeParse({ rows: [{ ...allowed.rows[0], bcc: null }] }).success, true, 'and a send without one reads as null');
  // `safeParse` success proves nothing on its own: an object schema strips a key it does not know,
  // so a row could parse "fine" and lose the very field this log exists to keep. Pin the values.
  const kept = rpcContract.send_audit.output.parse({ rows: [{ ...allowed.rows[0], bcc: 'quiet@example.com', approvalId: 'a-1' }] });
  assert.equal(kept.rows[0].bcc, 'quiet@example.com', 'the blind copy survives the contract');
  assert.equal(kept.rows[0].approvalId, 'a-1', 'and so does the approval id, which says whether one was spent');
  const observed = rpcContract.send_audit.output.parse({ rows: [{ ...allowed.rows[0], reason: 'page-confirmed replay', approvalId: null }] });
  assert.equal(observed.rows[0].approvalId, null, 'a delivery with no approval reads as null, not as absent');
});

test('a Gmail draft can carry a blind copy', () => {
  const send = { account: 'gmail-business' as const, to: 'a@example.com', bcc: 'hidden@example.com', subject: 'Hi', text: 'Hello' };
  assert.equal(rpcContract.send_gmail.input.safeParse(send).success, true);
  assert.equal(rpcContract.send_gmail.input.safeParse({ ...send, bcc: 'x@example.com\r\nBcc: y@example.com' }).success, false, 'the header guard applies to bcc too');
});

test('list keeps the no-input call every consumer makes and gains an opt-in page request', () => {
  assert.equal(rpcContract.list.input.safeParse(null).success, true, 'the panel, the CLI and the mention provider all pass null');
  assert.equal(rpcContract.list.input.safeParse({}).success, true);
  assert.equal(rpcContract.list.input.safeParse({ older: true }).success, true);
  assert.equal(rpcContract.list.input.safeParse({ older: 'yes' }).success, false, 'only a boolean asks for a page');
  assert.equal(rpcContract.list.input.safeParse({ older: true, cursor: 'page-2' }).success, false, 'a mistyped field is refused, not ignored: the gateway keeps the cursor');
  assert.equal(rpcContract.list.input.safeParse({ older: true, account: 'gmail-personal' }).success, true, 'one source can be asked on its own, which is how the list grows as each answers');
  assert.equal(rpcContract.list.input.safeParse({ older: true, account: 'nobody' }).success, false, 'and only a source that exists');

  // The shape the panel has always been handed still parses, so a caller that never asks for a
  // page reads exactly what it read before; `more` is the addition, not a replacement.
  assert.equal(rpcContract.list.output.safeParse({ items: [], errors: [] }).success, true);
  assert.equal(rpcContract.list.output.safeParse({ items: [], errors: ['WhatsApp unavailable.'], more: true }).success, true);
});

test('a source refresh may say it has an older page, and may say nothing at all', () => {
  assert.equal(rpcContract.sync.output.safeParse({ items: [], updatedAt: 1 }).success, true, 'a source that cannot page answers as it always did');
  assert.equal(rpcContract.sync.output.safeParse({ items: [], updatedAt: 1, more: true }).success, true);
});

test('a call that takes nothing parses as null and as an empty object', () => {
  // The same calls arrive both ways in the log: the panel and the CLI pass null, a client that always
  // sends a body passes {}. A refusal on the shape alone is a failure the caller cannot act on.
  const noArg = ['cached', 'freshness', 'search_status', 'clear_cache', 'linkedin_writes', 'linkedin_signin', 'mail_approval_policy', 'capabilities', 'sources', 'mailbox_status', 'connection_status'] as const;
  for (const method of noArg) {
    assert.equal(rpcContract[method].input.safeParse(null).success, true, `${method} answers a null call`);
    assert.equal(rpcContract[method].input.safeParse({}).success, true, `${method} answers an empty-body call`);
    assert.equal(rpcContract[method].input.safeParse({ limit: 5 }).success, false, `${method} still refuses a call that names something`);
  }
});

test('the audit and approval-status reads survive a caller with nothing to ask', () => {
  // Both fields are optional, so both methods are readable with no argument; the gateway must not
  // read through a null it was handed.
  for (const method of ['send_audit', 'mail_approval_status'] as const) {
    assert.equal(rpcContract[method].input.safeParse(null).success, true, `${method} answers a null call`);
    assert.equal(rpcContract[method].input.safeParse({}).success, true, `${method} answers an empty call`);
  }
  assert.equal(rpcContract.send_audit.input.safeParse({ limit: 0 }).success, false, 'and a page size is still a page size');
});

test('a mailbox address is an account id, and the schema is not the two legacy slots', () => {
  const mail = { account: 'ada@example.com', to: 'bob@example.com', subject: 'Hi', text: 'Hello' };
  assert.equal(rpcContract.send_gmail.input.safeParse(mail).success, true, 'send_gmail accepts the mailbox address');
  assert.equal(rpcContract.list.input.safeParse({ account: 'ada@example.com' }).success, true);
  assert.equal(rpcContract.sync.input.safeParse({ account: 'ada@example.com' }).success, true);
  assert.equal(rpcContract.list.input.safeParse({ account: 'nobody' }).success, false, 'a word that is not an account is still refused');
  const described = rpcContract.freshness.output.safeParse({
    'ada@example.com': { lastAttemptAt: 1, lastSuccessAt: null, lastError: 'gmail ada@example.com request failed (401; invalid, token)', cacheFallback: false },
  });
  assert.equal(described.success, true, 'an email-shaped account id survives the freshness record');
});

test('gmail connect accepts only replace, and remove names a mailbox', () => {
  assert.equal(rpcContract.gmail_connect.input.safeParse(null).success, true);
  assert.equal(rpcContract.gmail_connect.input.safeParse({}).success, true);
  assert.equal(rpcContract.gmail_connect.input.safeParse({ replace: true }).success, true);
  for (const field of ['code', 'state', 'verifier', 'redirect', 'tokenUrl', 'account', 'clientId', 'clientSecret', 'scopes']) {
    assert.equal(rpcContract.gmail_connect.input.safeParse({ [field]: 'x' }).success, false, field);
  }
  assert.equal(rpcContract.gmail_remove.input.safeParse({ account: 'ada@example.com' }).success, true);
  assert.equal(rpcContract.gmail_remove.input.safeParse({ account: 'gmail-personal' }).success, true);
  assert.equal(rpcContract.gmail_remove.input.safeParse({ account: 'whatsapp' }).success, false);
  assert.equal(rpcContract.gmail_remove.input.safeParse({ account: 'ada@example.com', token: 'x' }).success, false);
  assert.equal(rpcContract.connection_status.input.safeParse({ ensure: true }).success, false);
});

test('the pairing call reads with nothing and acts with one of four words', () => {
  assert.equal(rpcContract.whatsapp_pairing.input.safeParse(null).success, true, 'the card polls with no input at all');
  assert.equal(rpcContract.whatsapp_pairing.input.safeParse({ op: 'pair' }).success, true);
  assert.equal(rpcContract.whatsapp_pairing.input.safeParse({ op: 'request-code', phone: '31612345678' }).success, true);
  assert.equal(rpcContract.whatsapp_pairing.input.safeParse({ op: 'reconnect' }).success, true, 'a socket that will not open is reopened, not re-paired');
  assert.equal(rpcContract.whatsapp_pairing.input.safeParse({ op: 'retry' }).success, false, 'there is no retry: a lost device is re-paired');
  assert.equal(rpcContract.whatsapp_pairing.input.safeParse({ op: 'pair', phone: '31612345678', replace: true }).success, false, 'and replacing a linked device is not a flag on pairing');
  assert.equal(rpcContract.whatsapp_pairing.output.safeParse({ state: 'qr', qr: 'x', expiresAt: 1 }).success, true);
  assert.equal(rpcContract.whatsapp_pairing.output.safeParse({ state: 'unpaired', message: 'nothing yet' }).success, true);
  assert.equal(rpcContract.whatsapp_pairing.output.safeParse({ state: 'failed', message: 'already open in process 42' }).success, true, 'an account whose socket would not open says so');
  assert.equal(rpcContract.whatsapp_pairing.output.safeParse({ state: 'paired' }).success, false, 'the seven states are the whole vocabulary');
});
