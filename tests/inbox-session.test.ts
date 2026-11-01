import assert from 'node:assert/strict';
import test from 'node:test';
import { createInboxSession, type InboxItem } from '../src/inbox-session.ts';
import { inboxDraftKey, readInboxDraft } from '../src/inbox-drafts.ts';
import type { Account, Capabilities, Conversation, Message } from '../src/adapters/types.ts';
import { accounts } from '../src/adapters/types.ts';
import type { CapabilityMap } from '../src/ui-capabilities.ts';

const EVERYTHING: Capabilities = { send: true, markRead: true, archive: true, invitations: true, media: true, attachments: true, threads: true, followsList: true };

/** Every source declaring the same thing; a case overrides only the rule it is about. */
function declarations(overrides: Partial<Capabilities> = {}): CapabilityMap {
  return Object.fromEntries(accounts.map(account => [account, { ...EVERYTHING, ...overrides }])) as CapabilityMap;
}

const row = (overrides: Partial<Conversation> = {}): InboxItem => ({
  account: 'whatsapp',
  id: 'chat-1',
  title: 'Ada',
  preview: 'See you at six',
  date: 1_700_000_000_000,
  unread: true,
  ...overrides,
});

type Call = { name: string; input: unknown };
type Handler = (input: any) => unknown;

function defaults(name: string): unknown {
  if (name === 'capabilities') return declarations();
  if (name === 'cached') return { items: [] };
  if (name === 'cached_open') return { messages: [] };
  if (name === 'open') return { messages: [] };
  if (name === 'list_source') return { items: [] };
  if (name === 'linkedin_sync') return { items: [], updatedAt: 0 };
  if (name === 'search') return { ids: [] };
  if (name === 'action') return { status: 'Done' };
  if (name === 'send_gmail') return { status: 'Sent' };
  return null;
}

/**
 * Records everything that crossed the RPC boundary, in order. Nothing here
 * schedules a timer: every promise resolves as soon as it is awaited.
 */
function fakeRpc(handlers: Partial<Record<string, Handler>> = {}) {
  const calls: Call[] = [];
  return {
    calls,
    async call(name: string, input: unknown): Promise<any> {
      calls.push({ name, input });
      const handler = handlers[name];
      return handler ? await handler(input) : defaults(name);
    },
  };
}

/** Let every promise the session has already started run to completion. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 32; turn++) await Promise.resolve();
}

function memoryStorage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> {
  const values = new Map<string, string>();
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: key => { values.delete(key); },
  };
}

const cachedMessage: Message = { sender: 'Ada', text: 'See you at six', date: 1 };
const liveMessage: Message = { sender: 'Ada', text: 'See you at six, then', date: 2 };

test('open shows the cached thread, then the source thread, then marks it read', async () => {
  const target = row({ unread: true });
  const rpc = fakeRpc({
    cached: () => ({ items: [target] }),
    list_source: input => ({ items: input.account === 'whatsapp' ? [target] : [] }),
    cached_open: () => ({ messages: [cachedMessage] }),
    open: () => ({ messages: [liveMessage] }),
  });
  const session = createInboxSession({ rpc, now: () => 0 });
  await settle();

  await session.open(target);

  const threadCalls = rpc.calls.filter(call => ['cached_open', 'open', 'action'].includes(call.name));
  assert.deepEqual(threadCalls.map(call => call.name), ['cached_open', 'open', 'action']);
  assert.deepEqual(threadCalls[2].input, { account: 'whatsapp', id: 'chat-1', action: 'read' });

  const snapshot = session.snapshot();
  assert.deepEqual(snapshot.messages, [liveMessage]);
  assert.equal(snapshot.selected?.unread, false, 'the open row is no longer unread');
  assert.equal(snapshot.items.find(item => item.account === 'whatsapp' && item.id === 'chat-1')?.unread, false, 'the list row clears too');
});

test('a source that does not follow the list moves the row without re-reading the thread', async () => {
  const target = row({ unread: false, preview: 'See you at six' });
  let listed: InboxItem[] = [target];
  const rpc = fakeRpc({
    capabilities: () => declarations({ followsList: false }),
    cached: () => ({ items: [target] }),
    list_source: input => ({ items: input.account === 'whatsapp' ? listed : [] }),
    cached_open: () => ({ messages: [cachedMessage] }),
    open: () => ({ messages: [liveMessage] }),
  });
  const session = createInboxSession({ rpc, now: () => 0 });
  await settle();
  await session.open(target);

  const opensBefore = rpc.calls.filter(call => call.name === 'open').length;
  listed = [{ ...target, preview: 'See you at six, then' }];
  await session.refresh(['whatsapp']);

  assert.equal(rpc.calls.filter(call => call.name === 'open').length, opensBefore, 'the thread is not read a second time');
  assert.equal(session.snapshot().selected?.preview, 'See you at six, then', 'but the selected row follows the list');
});

test('one tick fires each due list call once, even with two subscribers', async () => {
  const rpc = fakeRpc();
  const session = createInboxSession({ rpc, now: () => 1_000 });
  const seen: string[] = [];
  session.subscribe(() => seen.push('first'));
  session.subscribe(() => seen.push('second'));
  await settle();
  rpc.calls.length = 0;

  const at = 1_000 + 45_000;
  session.tick(at);
  const refreshed = rpc.calls
    .filter(call => call.name === 'list_source')
    .map(call => (call.input as { account: Account }).account)
    .sort();
  assert.deepEqual(refreshed, ['business', 'imessage', 'personal', 'whatsapp']);
  assert.ok(seen.length > 0, 'both subscribers were told');

  const notifications = seen.length;
  session.tick(at);
  assert.equal(rpc.calls.filter(call => call.name === 'list_source').length, 4, 'a second tick at the same instant fires nothing');
  assert.equal(seen.length, notifications, 'and notifies nobody');
});

test('a draft is written after its debounce and restored from the same storage', async () => {
  const storage = memoryStorage();
  const target = row({ unread: false });
  const session = createInboxSession({
    rpc: fakeRpc({ cached: () => ({ items: [target] }), cached_open: () => ({ messages: [] }), open: () => ({ messages: [] }) }),
    storage,
    now: () => 5_000,
  });
  await settle();
  await session.open(target);
  const key = inboxDraftKey({ account: 'whatsapp', id: 'chat-1' });

  session.setDraft('See you at six');
  assert.equal(storage.getItem(key), null, 'nothing is written before the debounce elapses');
  session.tick(5_000 + 249);
  assert.equal(storage.getItem(key), null, 'still nothing one millisecond short');
  session.tick(5_000 + 250);
  assert.equal(storage.getItem(key), 'See you at six');

  const restored = createInboxSession({
    rpc: fakeRpc({ cached: () => ({ items: [target] }), cached_open: () => ({ messages: [] }), open: () => ({ messages: [] }) }),
    storage,
    now: () => 6_000,
  });
  await settle();
  await restored.open(target);
  assert.equal(restored.snapshot().text, 'See you at six');
});

test('submit clears the draft, shows the bubble, then reconciles; a source that cannot send calls nothing', async () => {
  const target = row({ unread: false });
  const rpc = fakeRpc({
    cached: () => ({ items: [target] }),
    cached_open: () => ({ messages: [cachedMessage] }),
    open: () => ({ messages: [cachedMessage] }),
    action: () => ({ status: 'Sent' }),
    list_source: input => ({
      items: input.account === 'whatsapp' ? [{ ...target, preview: 'On my way' }] : [],
    }),
  });
  const storage = memoryStorage();
  const session = createInboxSession({ rpc, storage, now: () => 10 });
  await settle();
  await session.open(target);
  const key = inboxDraftKey({ account: 'whatsapp', id: 'chat-1' });
  session.setDraft('On my way');
  session.tick(10 + 250);
  assert.equal(readInboxDraft(storage, key), 'On my way', 'the draft was on disk before sending');

  const before = rpc.calls.length;
  await session.submit();

  assert.deepEqual(rpc.calls.slice(before).map(call => call.name), ['action', 'open', 'list_source'], 'one reply, then the reconciliation');
  assert.deepEqual(rpc.calls[before].input, { account: 'whatsapp', id: 'chat-1', action: 'reply', text: 'On my way' });
  assert.equal(session.snapshot().text, '', 'the composer is empty');
  assert.equal(readInboxDraft(storage, key), undefined, 'and the draft is gone from storage');
  assert.ok(
    session.snapshot().messages.some(message => message.fromMe && message.text === 'On my way'),
    'the sent bubble stays on screen',
  );

  const refusing = fakeRpc({
    capabilities: () => declarations({ send: false }),
    cached: () => ({ items: [target] }),
    cached_open: () => ({ messages: [] }),
    open: () => ({ messages: [] }),
  });
  const quiet = createInboxSession({ rpc: refusing, now: () => 0 });
  await settle();
  await quiet.open(target);
  quiet.setDraft('a draft only');
  const boundary = refusing.calls.length;
  await quiet.submit();
  assert.equal(refusing.calls.length, boundary, 'nothing crosses the RPC boundary');
  assert.equal(quiet.snapshot().text, 'a draft only', 'the text stays a draft');
});
