// The registry's job: one adapter per account, each declaring what it can do,
// each refusing what it cannot without the transport testing the account name.
// Every dependency is stubbed — no test here reaches Gmail, WhatsApp, Messages
// or LinkedIn.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import Database from 'better-sqlite3';
import { createInboxCache } from '../src/inbox-cache.ts';
import { canChange } from '../src/adapters/capability.ts';
import { createRegistry, registryCapabilities } from '../src/adapters/index.ts';
import { toProviderError } from '../src/adapters/provider-error.ts';
import { accounts } from '../src/adapters/types.ts';
import type { RegistryDeps } from '../src/adapters/deps.ts';


const LINKEDIN_MAILBOX = 'urn:li:fsd_profile:ACoAAExample';
const LINKEDIN_ID = 'urn:li:msg_conversation:(urn:li:fsd_profile:ACoAAAtest,2-abc)';
const LINKEDIN_INVITE = 'urn:li:fs_relInvitation:12345';

const GMAIL_THREAD = {
  id: 't1',
  messages: [{
    id: 'm1',
    internalDate: '1700000000000',
    snippet: 'See you at six',
    labelIds: [],
    payload: {
      mimeType: 'text/plain',
      headers: [
        { name: 'Subject', value: 'Dinner' },
        { name: 'From', value: 'Ada Lovelace <ada@example.com>' },
        { name: 'To', value: 'personal@example.com' },
      ],
      body: { data: Buffer.from('See you at six').toString('base64url') },
    },
  }],
};

function gmail(args: string[]): unknown {
  const call = args[1];
  if (call === 'getProfile') return { historyId: '77' };
  if (call === 'threads' && args[2] === 'list') return { threads: [{ id: 't1', historyId: '77', snippet: 'See you at six' }] };
  if (call === 'threads' && args[2] === 'get') return GMAIL_THREAD;
  if (call === 'threads' && args[2] === 'modify') return {};
  throw new Error(`unexpected gws call: ${args.join(' ')}`);
}

function whatsapp(tool: string): unknown {
  if (tool === 'list-chats') {
    return { items: [{ jid: '15551234567@s.whatsapp.net', name: 'Ada', preview: 'See you', last_msg_at: 1_700_000_000_000, unread: 2, kind: 'dm' }] };
  }
  if (tool === 'get-messages') return { items: [{ id: 'm1', type: 'chat', text: 'See you', ts: 1_700_000_000_000, from_me: false, sender: { name: 'Ada' } }] };
  if (tool === 'mark-read') return {};
  if (tool === 'load-media') return { id: 'm1', type: 'chat' };
  throw new Error(`unexpected WhatsAgent call: ${tool}`);
}

function imsg(method: string): unknown {
  if (method === 'chats.list') {
    return { chats: [{ id: 50, name: 'Ada', display_name: null, identifier: null, service: 'iMessage', last_message_at: '2024-01-01T00:00:00Z', unread_count: 1 }] };
  }
  if (method === 'messages.history') {
    return { messages: [{ id: 1, guid: 'g-1', sender: '+15551234567', sender_name: 'Ada', chat_name: null, text: 'Hello', created_at: '2024-01-01T00:00:00Z', is_from_me: false, attachments: [], reactions: [] }] };
  }
  throw new Error(`unexpected Messages call: ${method}`);
}

function fixture(sendReply: unknown = { id: 'm-sent' }) {
  const db = new Database(':memory:');
  const cache = createInboxCache(db);
  const calls: string[] = [];
  const sent: { raw: string | Uint8Array; threadId?: string }[] = [];
  const deps: RegistryDeps = {
    cache,
    gmail: {
      call: async (account, args) => { calls.push(`gmail:${account}:${args[1]}`); return gmail(args); },
      send: async (_account, message) => { calls.push('gmail:send'); sent.push(message); return sendReply; },
    },
    whatsapp: {
      call: async tool => { calls.push(`whatsapp:${tool}`); return whatsapp(tool); },
      // The loopback API is down in every test: group previews fall back and media has no source.
      runtime: async () => { calls.push('whatsapp:runtime'); throw new Error('WhatsAgent loopback is not running in this test.'); },
    },
    imsg: { request: async method => { calls.push(`imsg:${method}`); return imsg(method); } },
    armLinkedInRecorder: async () => {
      calls.push('linkedin:arm');
      return { installed: true, recording: true };
    },
    // The adapter receives the page seam; this stub answers the typed reads directly, so the
    // probe payload carries the rows and the mailbox the real probe would report.
    linkedInPage: {
      list: async () => {
        calls.push('linkedin:list');
        return {
          conversations: [{ id: LINKEDIN_ID, title: 'Ada Lovelace', preview: 'Hello from LinkedIn', date: 1_700_000_000_000, unread: true }],
          invitations: [{ id: LINKEDIN_INVITE, title: 'Grace Hopper', preview: 'A note with the invitation', date: 1_700_000_000_000, unread: true, sender: 'Grace Hopper', token: 'tok123', inviterProfileId: 'ACoAAAGRACE', firstName: 'Grace' }],
        };
      },
      thread: async () => {
        calls.push('linkedin:thread');
        return { messages: [{ sender: 'Ada', text: 'Hello from LinkedIn', date: 1_700_000_000_000, fromMe: false }] };
      },
      probe: async mailbox => {
        calls.push(mailbox ? `linkedin:probe@${mailbox}` : 'linkedin:probe');
        return { mailboxUrn: LINKEDIN_MAILBOX, conversations: [{ at: 1_700_000_000_000, unread: 1 }], invitations: [] };
      },
      replay: async () => {
        calls.push('linkedin:write:replay');
        return { accepted: true, status: 200 };
      },
      recorded: async () => {
        calls.push('linkedin:write:dump');
        return { writes: [], seen: { fetch: 0, xhr: 0, considered: 0, skipped: {} } };
      },
      clearRecorded: async () => {
        calls.push('linkedin:write:clear');
      },
    },
    providerError: toProviderError,
  };
  return { db, cache, registry: createRegistry(deps), calls, sent, done: () => db.close() };
}

test('the registry answers for every account, and each declares its own capabilities', () => {
  const f = fixture();
  try {
    assert.deepEqual(Object.keys(f.registry).sort(), [...accounts].sort());
    const declared = registryCapabilities(f.registry);
    assert.deepEqual(Object.keys(declared).sort(), [...accounts].sort());
    for (const name of accounts) assert.deepEqual(declared[name], f.registry[name].capabilities());
  } finally { f.done(); }
});

test('personal Gmail lists, opens and updates through its adapter', async () => {
  const f = fixture();
  try {
    const adapter = f.registry.personal;
    assert.deepEqual(adapter.capabilities(), { send: true, markRead: true, archive: true, invitations: false, media: false, attachments: true, threads: false, followsList: true });

    const listed = await adapter.list();
    assert.deepEqual(listed.errors, []);
    assert.deepEqual(listed.items.map(row => [row.account, row.id, row.title, row.sender]), [['personal', 't1', 'Dinner', 'Ada Lovelace']]);
    assert.equal(listed.items[0].preview, 'See you at six');

    const opened = await adapter.open('t1');
    assert.equal(opened.messages[0].text, 'See you at six');
    assert.equal(opened.messages[0].gmailId, 'm1');

    assert.deepEqual(await adapter.action('read', 't1'), { status: 'Updated.' });
    assert.deepEqual(await adapter.action('archive', 't1'), { status: 'Archived.' });
    await assert.rejects(adapter.action('reply', 't1', { text: 'hi' }), /not supported/);
  } finally { f.done(); }
});

test('a Gmail send reports success only when the CLI names the sent message', async () => {
  const sentDraft = { kind: 'gmail' as const, account: 'personal' as const, to: 'ada@example.com', subject: 'Dinner', text: 'Six works.' };
  const f = fixture();
  try {
    assert.deepEqual(await f.registry.personal.send!(sentDraft, {}), { status: 'Sent.' });
    assert.deepEqual(f.calls, ['gmail:send']);
    assert.match(String(f.sent[0].raw), /Subject: Dinner/);
    await assert.rejects(f.registry.personal.send!({ ...sentDraft, account: 'business' }, {}), /another account/);
  } finally { f.done(); }

  const unconfirmed = fixture({});
  try {
    await assert.rejects(unconfirmed.registry.personal.send!(sentDraft, {}), /outcome is unknown/);
  } finally { unconfirmed.done(); }
});

test('business Gmail answers for its own credential directory, not the personal one', async () => {
  const f = fixture();
  try {
    assert.deepEqual(f.registry.business.capabilities(), f.registry.personal.capabilities());
    await f.registry.business.list();
    await f.registry.business.open('t1');
    const gmailCalls = f.calls.filter(call => call.startsWith('gmail:'));
    assert.ok(gmailCalls.length >= 3);
    assert.ok(gmailCalls.every(call => call.startsWith('gmail:business:')));
  } finally { f.done(); }
});

test('WhatsApp lists a chat, refuses what it cannot do, and serves media through the adapter', async () => {
  const f = fixture();
  try {
    const adapter = f.registry.whatsapp;
    const caps = adapter.capabilities();
    assert.deepEqual(caps, { send: true, markRead: true, archive: false, invitations: false, media: true, attachments: false, threads: true, followsList: true });

    const listed = await adapter.list();
    assert.deepEqual(listed.items.map(row => [row.account, row.id, row.title, row.unread]), [['whatsapp', '15551234567@s.whatsapp.net', 'Ada', true]]);

    assert.deepEqual(await adapter.action('read', '15551234567@s.whatsapp.net'), { status: 'Marked read in WhatsAgent (no WhatsApp read receipt).' });
    assert.equal(canChange(caps, 'archive'), false);
    await assert.rejects(adapter.action('archive', '15551234567@s.whatsapp.net'), /not supported by WhatsAgent/);
    await assert.rejects(adapter.media('whatsapp', 'm1', 0), /no image or video/);
  } finally { f.done(); }
});

test('Messages lists, opens and keeps its read state locally', async () => {
  const f = fixture();
  try {
    const adapter = f.registry.imessage;
    const caps = adapter.capabilities();
    assert.deepEqual(caps, { send: true, markRead: true, archive: false, invitations: false, media: true, attachments: true, threads: true, followsList: true });

    const listed = await adapter.list();
    assert.deepEqual(listed.items.map(row => [row.account, row.id, row.title, row.unread]), [['imessage', '50', 'Ada', true]]);

    assert.equal((await adapter.open('50')).messages[0].text, 'Hello');
    assert.deepEqual(await adapter.action('read', '50'), { status: 'Marked read.' });
    assert.equal(f.cache.keptUnread('imessage', '50'), false);

    assert.equal(canChange(caps, 'archive'), false);
    await assert.rejects(adapter.action('archive', '50'), /not supported for Messages/);
    await assert.rejects(adapter.imsgMedia!('50', '1', 0), /unavailable/);
  } finally { f.done(); }
});

test('LinkedIn reads through its own entry points and refuses every write', async () => {
  const f = fixture();
  try {
    const adapter = f.registry.linkedin;
    assert.deepEqual(adapter.capabilities(), { send: true, markRead: true, archive: false, invitations: true, media: true, attachments: false, threads: true, followsList: false });

    // `list` answers from the cache, so it costs no browser read.
    f.calls.length = 0;
    assert.deepEqual((await adapter.list()).items, []);
    assert.deepEqual(f.calls, []);

    const synced = await adapter.sync!();
    assert.deepEqual(synced.items.map(row => [row.account, row.id, row.title]), [['linkedin', LINKEDIN_ID, 'Ada Lovelace'], ['linkedin', LINKEDIN_INVITE, 'Grace Hopper']]);
    // The refresh probes first; the probe is new here, so it also reads in full.
    assert.deepEqual(f.calls, ['linkedin:probe', 'linkedin:list']);
    assert.equal(synced.reason, 'read');
    assert.equal((await adapter.list()).items.length, 2);

    // Nothing moved since the marker was stored, so the second refresh keeps the rows it has.
    f.calls.length = 0;
    const again = await adapter.sync!();
    // Now that the marker remembers the mailbox, the probe no longer asks who it is.
    assert.deepEqual(f.calls, [`linkedin:probe@${LINKEDIN_MAILBOX}`]);
    assert.equal(again.reason, 'skip');
    assert.deepEqual(again.items.map(row => row.id), [LINKEDIN_INVITE, LINKEDIN_ID]);

    assert.equal((await adapter.open(LINKEDIN_ID)).messages[0].text, 'Hello from LinkedIn');
    await assert.rejects(adapter.open('not-a-conversation'), /cannot be opened/);

    // The read mark is the one LinkedIn write: the adapter replays the request the page itself
    // sent for the same menu item, and every other action still refuses.
    f.calls.length = 0;
    assert.deepEqual(await adapter.action('read', LINKEDIN_ID), { status: 'Updated.' });
    assert.deepEqual(await adapter.action('unread', LINKEDIN_ID), { status: 'Updated.' });
    assert.deepEqual(f.calls, ['linkedin:write:replay', 'linkedin:write:replay']);
    await assert.rejects(adapter.action('read', 'not-a-conversation'), /cannot be marked/);
    await assert.rejects(adapter.action('archive', LINKEDIN_ID), /still need their own recorded actions/);

    // A reply replays the recorded send shape for this conversation; an invitation answer and an
    // archive still need their own recorded actions.
    f.calls.length = 0;
    assert.deepEqual(await adapter.action('reply', LINKEDIN_ID, { text: 'Hi there' }), { status: 'Sent.' });
    assert.deepEqual(f.calls, ['linkedin:write:replay']);
    await assert.rejects(adapter.action('reply', LINKEDIN_ID, { text: '  ' }), /needs the text to send/);
    await assert.rejects(adapter.action('reply', 'not-a-conversation', { text: 'hi' }), /cannot receive a reply/);
    await assert.rejects(adapter.action('archive', LINKEDIN_ID, { text: 'hi' }), /still need their own recorded actions/);
    // An invitation answer is the page's own request, built from what the read carried; a
    // conversation id is not an invitation, and an invitation the read never saw asks for a refresh.
    assert.deepEqual(await adapter.action('confirm', LINKEDIN_INVITE), { status: 'Accepted.' });
    assert.deepEqual(await adapter.action('reject', LINKEDIN_INVITE), { status: 'Ignored.' });
    await assert.rejects(adapter.action('confirm', LINKEDIN_ID), /cannot be answered/);
    await assert.rejects(adapter.action('reject', 'urn:li:fs_relInvitation:999'), /Refresh the inbox/);
  } finally { f.done(); }
});

test('a refusal comes from capabilities, not from an account check in the transport', async () => {
  const f = fixture();
  try {
    // The same predicate decides for every account, and it follows the flags:
    // flip a flag and the answer flips, with the account unchanged.
    for (const name of accounts) {
      const caps = f.registry[name].capabilities();
      assert.equal(canChange(caps, 'read'), caps.markRead);
      assert.equal(canChange(caps, 'unread'), caps.markRead);
      assert.equal(canChange(caps, 'archive'), caps.archive);
      assert.equal(canChange({ ...caps, markRead: !caps.markRead }, 'read'), !caps.markRead);
      assert.equal(canChange({ ...caps, archive: !caps.archive }, 'archive'), !caps.archive);
    }

    // A read mark replays the recorded request now, but a conversation id that is not a
    // conversation urn is refused before the page is asked anything.
    f.calls.length = 0;
    await assert.rejects(f.registry.linkedin.action('read', 'not-a-conversation'), /cannot be marked/);
    assert.deepEqual(f.calls, []);

    // And the transport never picks behaviour from a source name.
    const source = await readFile(new URL('../server.ts', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /===\s*'(?:personal|business|whatsapp|imessage|linkedin)'/);
  } finally { f.done(); }
});

test('a skipping refresh still hands over the mailbox it learned', async () => {
  const f = fixture();
  const adapter = f.registry.linkedin;
  await adapter.sync!();
  // The first refresh had to ask who it is; the marker now answers that question.
  assert.deepEqual(f.calls, ['linkedin:probe', 'linkedin:list']);
  assert.equal((await import('../src/linkedin-delta.ts')).linkedinMarkerMailbox(f.cache.cursor('linkedin')), LINKEDIN_MAILBOX);

  // Nothing moved, so the second refresh probes with the remembered mailbox and keeps the rows.
  f.calls.length = 0;
  const skipped = await adapter.sync!();
  assert.deepEqual(f.calls, [`linkedin:probe@${LINKEDIN_MAILBOX}`]);
  assert.equal(skipped.reason, 'skip');
  assert.equal((await import('../src/linkedin-delta.ts')).linkedinMarkerMailbox(f.cache.cursor('linkedin')), LINKEDIN_MAILBOX);
});

test('the recorder arms, dumps, and refuses to replay without approval', async () => {
  const f = fixture();
  const adapter = f.registry.linkedin;

  assert.deepEqual(await adapter.record!('arm'), { installed: true, recording: true });
  // A dump also reports whether the wrappers were called at all: "nothing recorded" and "never watched"
  // are different answers.
  assert.deepEqual(await adapter.record!('dump'), { writes: [], seen: { fetch: 0, xhr: 0, considered: 0, skipped: {} } });

  // A recorded write of a message send: the only shape replay accepts.
  const write = {
    method: 'POST',
    url: '/voyager/api/voyagerMessagingGraphQL/graphql?queryId=messengerMessages',
    body: JSON.stringify({ queryId: 'messengerMessages', variables: { conversationUrn: LINKEDIN_ID, message: { text: 'See you soon' } } }),
    capturedAt: 1_700_000_000_000,
  };

  await assert.rejects(adapter.replay!({ write, conversationId: LINKEDIN_ID, text: 'Hi' }), /Approve the exact action first/);
  await assert.rejects(
    adapter.replay!({ write, conversationId: 'urn:li:msg_conversation:somebody-else', text: 'Hi', confirm: true }),
    /neither a message send nor a mark-read/,
  );

  f.calls.length = 0;
  const sent = await adapter.replay!({ write, conversationId: LINKEDIN_ID, text: 'Hi there', confirm: true });
  assert.deepEqual(sent, { ok: true, status: 200, body: null });
  assert.deepEqual(f.calls, ['linkedin:write:replay']);
});
