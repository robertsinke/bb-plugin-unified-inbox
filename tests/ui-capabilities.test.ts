import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canAnswerInvitation, canArchive, canSend, canMarkRead, followsList, hasThread, type CapabilityMap } from '../src/ui-capabilities.ts';
import { accounts } from '../src/adapters/types.ts';
import type { Account, Capabilities } from '../src/adapters/types.ts';

const EVERYTHING: Capabilities = { send: true, markRead: true, archive: true, invitations: true, media: true, attachments: true, threads: true, followsList: true };
const NOTHING: Capabilities = { send: false, markRead: false, archive: false, invitations: false, media: false, attachments: false, threads: false, followsList: false };

const everySource = (declaration: Capabilities): CapabilityMap =>
  Object.fromEntries(accounts.map(account => [account, { ...declaration }])) as CapabilityMap;

const RULES = [
  ['send', canSend],
  ['mark read', canMarkRead],
  ['archive', canArchive],
  ['a thread', hasThread],
  ['following the list', followsList],
] as const;

test('every one of the five sources is offered what it declares', () => {
  const capabilities = everySource(EVERYTHING);
  for (const account of accounts) {
    for (const [rule, decide] of RULES) {
      assert.equal(decide(capabilities, account), true, `${account} is offered ${rule} when it declares it`);
    }
  }
});

test('every one of the five sources is offered nothing when it declares nothing', () => {
  const capabilities = everySource(NOTHING);
  for (const account of accounts) {
    for (const [rule, decide] of RULES) {
      assert.equal(decide(capabilities, account), false, `${account} is offered no ${rule} when it declares none`);
    }
  }
});

test('each source is judged by its own declaration, not the account name', () => {
  for (const account of accounts) {
    const onlyThisSource = everySource(NOTHING);
    onlyThisSource[account] = EVERYTHING;
    const everySourceButThisOne = everySource(EVERYTHING);
    everySourceButThisOne[account] = NOTHING;
    for (const [rule, decide] of RULES) {
      assert.equal(decide(onlyThisSource, account), true, `${account} alone declaring ${rule} is enough for it`);
      assert.equal(decide(everySourceButThisOne, account), false, `${account} withholding ${rule} wins over every other source declaring it`);
    }
    for (const other of accounts.filter(name => name !== account)) {
      assert.equal(canSend(everySourceButThisOne, other), true, `${account} withholding send does not hide ${other}'s composer`);
    }
  }
});

test('one capability declared does not stand in for another', () => {
  const onlySend = everySource({ ...NOTHING, send: true });
  const onlyMarkRead = everySource({ ...NOTHING, markRead: true });
  const onlyArchive = everySource({ ...NOTHING, archive: true });
  for (const account of accounts) {
    assert.deepEqual(
      [canSend(onlySend, account), canMarkRead(onlySend, account), canArchive(onlySend, account)],
      [true, false, false],
      `${account}: only the composer follows send`,
    );
    assert.deepEqual(
      [canSend(onlyMarkRead, account), canMarkRead(onlyMarkRead, account), canArchive(onlyMarkRead, account)],
      [false, true, false],
      `${account}: only the read toggle follows markRead`,
    );
    assert.deepEqual(
      [canSend(onlyArchive, account), canMarkRead(onlyArchive, account), canArchive(onlyArchive, account)],
      [false, false, true],
      `${account}: only archive follows archive`,
    );
  }
});

test('unknown declarations offer no control at all', () => {
  for (const account of accounts) {
    for (const [rule, decide] of RULES) {
      assert.equal(decide(null, account), false, `${account} is offered no ${rule} before its declaration is known`);
    }
  }
});

test('a source that cannot send still keeps a draft locally', () => {
  // Drafting is a toolbox primitive: it never needs the source, so only the send control is withheld.
  const capabilities = everySource(NOTHING);
  for (const account of accounts) assert.equal(canSend(capabilities, account), false);
  assert.equal(canSend({ ...capabilities, linkedin: { ...NOTHING, send: false } }, 'linkedin'), false);
  assert.equal(canSend({ ...capabilities, linkedin: { ...NOTHING, send: true } }, 'linkedin'), true);
});

test('answering invitations is offered only where the source declares it', () => {
  const capabilities = everySource(EVERYTHING);
  assert.equal(canAnswerInvitation(capabilities, 'linkedin'), true);
  assert.equal(canAnswerInvitation(everySource(NOTHING), 'linkedin'), false);
  assert.equal(canAnswerInvitation(null, 'linkedin'), false);
  // No other source answers invitations even with everything else turned on.
  const withoutInvitations = everySource({ ...EVERYTHING, invitations: false });
  for (const account of ['gmail-personal', 'gmail-business', 'whatsapp', 'imessage'] as const) {
    assert.equal(canAnswerInvitation(withoutInvitations, account), false, account);
  }
});

test('the composer follows the thread declaration, not the source name', () => {
  // Gmail opens a document and answers in a mail form, so it declares no thread; the other four do.
  const declared = everySource({ ...NOTHING, threads: true });
  for (const account of accounts) assert.equal(hasThread(declared, account), true, account);
  const mail = { ...declared, 'gmail-personal': { ...NOTHING, threads: false }, 'gmail-business': { ...NOTHING, threads: false } };
  assert.deepEqual(
    [hasThread(mail, 'gmail-personal'), hasThread(mail, 'gmail-business'), hasThread(mail, 'whatsapp')],
    [false, false, true],
    'the two mail accounts keep their own surface while a thread source keeps the composer',
  );
  assert.equal(hasThread(null, 'whatsapp'), false, 'no composer before the declaration is known');
});

test('an expensive source does not re-read its open thread when the list moves', () => {
  const cheap = everySource({ ...NOTHING, followsList: true });
  const expensive = { ...cheap, linkedin: { ...NOTHING, followsList: false } };
  assert.equal(followsList(cheap, 'linkedin'), true);
  assert.equal(followsList(expensive, 'linkedin'), false, 'LinkedIn keeps what it showed until reopened');
  for (const account of accounts.filter(name => name !== 'linkedin')) {
    assert.equal(followsList(expensive, account), true, `${account} still follows the list`);
  }
  assert.equal(followsList(null, 'whatsapp'), false);
});
