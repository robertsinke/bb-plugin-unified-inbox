// Candidate 3: one media primitive. A file is addressed one of three ways — a
// message slot, a Messages attachment slot, a Gmail attachment name — and the
// request says which. The adapter that owns the source answers; no source is
// addressed by RPC name, and no adapter carries a second media method.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mediaRequestSchema } from '../src/adapters/media.ts';
import type { Adapter } from '../src/adapters/types.ts';

test('a media request names how the file is addressed, and fills the default slot', () => {
  assert.deepEqual(
    mediaRequestSchema.parse({ kind: 'message', id: '3EB0FF' }),
    { kind: 'message', id: '3EB0FF', index: 0 },
    'a message slot defaults to the first attachment',
  );
  assert.deepEqual(
    mediaRequestSchema.parse({ kind: 'message', id: 'urn:li:msg_conversation:(a,2-b)', index: 1 }),
    { kind: 'message', id: 'urn:li:msg_conversation:(a,2-b)', index: 1 },
  );
  assert.deepEqual(
    mediaRequestSchema.parse({ kind: 'imsg', chatId: 'iMessage;-;+15551234567', messageId: '1234', index: 0 }),
    { kind: 'imsg', chatId: 'iMessage;-;+15551234567', messageId: '1234', index: 0 },
  );
  assert.deepEqual(
    mediaRequestSchema.parse({ kind: 'attachment', id: '19b7c1d2', filename: 'invoice.pdf' }),
    { kind: 'attachment', id: '19b7c1d2', filename: 'invoice.pdf' },
  );
});

test('a request it cannot read is refused, naming what is missing', () => {
  assert.throws(() => mediaRequestSchema.parse({ kind: 'photo', id: 'x' }), /kind/i);
  assert.throws(() => mediaRequestSchema.parse({ kind: 'attachment', id: '19b7c1d2' }), /filename/i);
  assert.throws(() => mediaRequestSchema.parse({ kind: 'imsg', chatId: 'iMessage;-;+1', index: 0 }), /messageId/i);
  assert.throws(() => mediaRequestSchema.parse({ kind: 'message' }), /id/i);
});

// Type-level: one method, one argument. While `media` still takes
// (account, id, index), this file fails `npx tsc --noEmit`.
test('the adapter answers one request, not an account triple', () => {
  type FirstParameter = Parameters<Adapter['media']>[0];
  type IsRequest = FirstParameter extends { kind: 'message' | 'imsg' | 'attachment' } ? true : never;
  const ok: IsRequest = true;
  assert.equal(ok, true);
  type TakesOneArgument = Parameters<Adapter['media']> extends [infer Only, ...never[]] ? true : never;
  const one: TakesOneArgument = true;
  assert.equal(one, true);
});

// Type-level: the two per-source media entry points are gone, so a source can no
// longer be reached for media by the source's RPC name.
test('no adapter keeps a second media method', () => {
  type ExtraMethods = Extract<'gmailAttachment' | 'imsgMedia', keyof Adapter>;
  const none: ExtraMethods extends never ? true : never = true;
  assert.equal(none, true);
});