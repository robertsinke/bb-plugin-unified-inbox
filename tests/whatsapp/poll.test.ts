import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import type { WAMessage } from 'baileys';
import { handleMessagesUpsert, replayStoredPollUpdates } from '../../src/whatsapp/ingest.ts';
import { encryptPollVote } from '../../src/whatsapp/poll.ts';
import { createWhatsAppStore } from '../../src/whatsapp/store.ts';

const secret = Buffer.alloc(32, 9);
const chat = '15550001111@s.whatsapp.net';
const creator = '15550002222@s.whatsapp.net';
const voter = '15550003333@s.whatsapp.net';
const pollId = 'POLL1';

function fixture() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  return { db, store: createWhatsAppStore(db) };
}

function asMessage(value: Record<string, unknown>): WAMessage {
  return value as unknown as WAMessage;
}

function creation(field: 'pollCreationMessage' | 'pollCreationMessageV3' = 'pollCreationMessageV3') {
  return asMessage({
    key: { id: pollId, remoteJid: chat, fromMe: false, participant: creator },
    messageTimestamp: 1,
    message: {
      messageContextInfo: { messageSecret: secret },
      [field]: {
        name: 'Lunch?',
        selectableOptionsCount: 1,
        options: [{ optionName: 'Soup' }, { optionName: 'Salad' }, { optionName: 'Bread' }],
      },
    },
  });
}

function vote(names: string[], id: string, encKey: Uint8Array = secret) {
  const enc = encryptPollVote({
    optionNames: names,
    pollEncKey: encKey,
    pollMsgId: pollId,
    pollCreatorJid: creator,
    voterJid: voter,
  });
  return asMessage({
    key: { id, remoteJid: chat, fromMe: false, participant: voter },
    messageTimestamp: 2,
    message: {
      pollUpdateMessage: {
        pollCreationMessageKey: { id: pollId, remoteJid: chat, fromMe: false, participant: creator },
        vote: { encPayload: enc.encPayload, encIv: enc.encIv },
        senderTimestampMs: 2,
      },
    },
  });
}

test('a poll creation is one message and a vote is a row on it', () => {
  const { db, store } = fixture();
  try {
    handleMessagesUpsert(store, { type: 'notify', messages: [creation(), vote(['Soup'], 'VOTE1')] });
    assert.equal(store.countMessages(), 1);
    assert.equal(store.getMessage(pollId)?.type, 'poll');
    assert.match(store.getMessage(pollId)?.text ?? '', /Lunch\?/);
    assert.deepEqual(store.listPollVotes(chat, pollId).map(row => row.options), [['Soup']]);
    assert.equal(store.getMessage('VOTE1'), undefined);
  } finally {
    db.close();
  }
});

test('a vote that arrives first is applied when the poll arrives', () => {
  const { db, store } = fixture();
  try {
    handleMessagesUpsert(store, { type: 'notify', messages: [vote(['Salad'], 'VOTE1')] });
    assert.equal(store.countMessages(), 0);
    assert.equal(store.listPendingPollVotes(pollId).length, 1);
    handleMessagesUpsert(store, { type: 'notify', messages: [creation()] });
    assert.deepEqual(store.listPollVotes(chat, pollId).map(row => row.options), [['Salad']]);
    assert.equal(store.listPendingPollVotes(pollId).length, 0);
  } finally {
    db.close();
  }
});

test('a poll stored under its proto key still opens, and a saved vote string still counts', () => {
  const { db, store } = fixture();
  try {
    const enc = encryptPollVote({
      optionNames: ['Soup'],
      pollEncKey: secret,
      pollMsgId: pollId,
      pollCreatorJid: creator,
      voterJid: voter,
    });
    store.upsertChat({ jid: chat, kind: '1:1', last_msg_at: 2 });
    store.upsertMessage({
      id: pollId,
      chat_jid: chat,
      from_me: false,
      sender: creator,
      ts: 1,
      type: 'pollCreationMessageV3',
      text: null,
      raw: JSON.stringify({
        key: { id: pollId, remoteJid: chat, fromMe: false, participant: creator },
        message: {
          messageContextInfo: { messageSecret: secret.toString('base64') },
          pollCreationMessageV3: {
            name: 'Lunch?',
            selectableOptionsCount: 1,
            options: [{ optionName: 'Soup' }, { optionName: 'Salad' }],
          },
        },
      }),
    });
    store.upsertMessage({
      id: 'VOTE1',
      chat_jid: chat,
      from_me: false,
      sender: voter,
      ts: 2,
      type: 'pollUpdate',
      text: null,
      raw: JSON.stringify({
        key: { id: 'VOTE1', remoteJid: chat, fromMe: false, participant: voter },
        message: {
          pollUpdateMessage: {
            pollCreationMessageKey: { id: pollId, remoteJid: chat, fromMe: false, participant: creator },
            vote: {
              encPayload: Buffer.from(enc.encPayload).toString('base64'),
              encIv: Buffer.from(enc.encIv).toString('base64'),
            },
            senderTimestampMs: 2,
          },
        },
      }),
    });
    replayStoredPollUpdates(store, chat);
    assert.deepEqual(store.listPollVotes(chat, pollId).map(row => row.options), [['Soup']]);
  } finally {
    db.close();
  }
});

test('a vote sealed with the LID still counts when the key also carries a phone', () => {
  const { db, store } = fixture();
  try {
    const cast = vote(['Soup'], 'VOTE1');
    cast.key = { ...cast.key, participantAlt: '15550004444@s.whatsapp.net' };
    handleMessagesUpsert(store, { type: 'notify', messages: [creation(), cast] });
    assert.deepEqual(store.listPollVotes(chat, pollId).map(row => row.options), [['Soup']]);
  } finally {
    db.close();
  }
});

test('a second vote from the same person replaces the first', () => {
  const { db, store } = fixture();
  try {
    handleMessagesUpsert(store, { type: 'notify', messages: [creation(), vote(['Soup'], 'VOTE1'), vote(['Bread'], 'VOTE2')] });
    assert.equal(store.listPollVotes(chat, pollId).length, 1);
    assert.deepEqual(store.listPollVotes(chat, pollId)[0]?.options, ['Bread']);
  } finally {
    db.close();
  }
});

test('a vote with the wrong secret adds no row and does not throw', () => {
  const { db, store } = fixture();
  try {
    handleMessagesUpsert(store, { type: 'notify', messages: [creation()] });
    handleMessagesUpsert(store, { type: 'notify', messages: [vote(['Soup'], 'VOTE1', Buffer.alloc(32, 1))] });
    assert.equal(store.listPollVotes(chat, pollId).length, 0);
    assert.equal(store.countMessages(), 1);
  } finally {
    db.close();
  }
});

test('poll creation versions share one type', () => {
  const { db, store } = fixture();
  try {
    handleMessagesUpsert(store, { type: 'notify', messages: [creation('pollCreationMessage')] });
    assert.equal(store.getMessage(pollId)?.type, 'poll');
  } finally {
    db.close();
  }
});

test('the store keeps one vote per person and a clear removes it', () => {
  const { db, store } = fixture();
  try {
    store.upsertChat({ jid: chat, kind: '1:1' });
    store.upsertPollVote({ chat_jid: chat, poll_msg_id: pollId, actor: voter, options: ['Soup', 'Salad'], updated_at: 1 });
    store.upsertPollVote({ chat_jid: chat, poll_msg_id: 'other', actor: voter, options: ['Tea'], updated_at: 1 });
    store.upsertPollVote({ chat_jid: chat, poll_msg_id: pollId, actor: creator, options: ['Bread'], updated_at: 2 });
    store.upsertPollVote({ chat_jid: chat, poll_msg_id: pollId, actor: voter, options: ['Bread'], updated_at: 3 });
    const names = store.listPollVotes(chat, pollId).map(row => [row.actor, row.options]);
    assert.deepEqual(names, [[creator, ['Bread']], [voter, ['Bread']]]);
    store.upsertPollVote({ chat_jid: chat, poll_msg_id: pollId, actor: voter, options: [], updated_at: 4 });
    assert.deepEqual(store.listPollVotes(chat, pollId).map(row => row.actor), [creator]);
    store.upsertPollVote({
      chat_jid: chat,
      poll_msg_id: pollId,
      actor: 'pending-person',
      pending: { encPayload: 'aa', encIv: 'bb', voterJid: voter, pollCreatorJid: creator },
      updated_at: 5,
    });
    assert.equal(store.listPendingPollVotes(pollId)[0]?.pending?.encPayload, 'aa');
    store.upsertPollVote({ chat_jid: chat, poll_msg_id: pollId, actor: 'pending-person', options: ['Soup'], updated_at: 6 });
    assert.equal(store.listPendingPollVotes(pollId).length, 0);
    store.clear();
    assert.equal(store.listPollVotes(chat, pollId).length, 0);
    assert.equal(store.countMessages(), 0);
  } finally {
    db.close();
  }
});
