import assert from 'node:assert/strict';
import test from 'node:test';
import { createInboxSession, type InboxItem, type InboxSessionDeps } from '../src/inbox-session.ts';
import { inboxDraftKey, readInboxDraft } from '../src/inbox-drafts.ts';
import type { Account, Capabilities, Conversation, Message, SourceMap } from '../src/adapters/types.ts';
import { accounts } from '../src/adapters/types.ts';
import type { CapabilityMap } from '../src/ui-capabilities.ts';

const EVERYTHING: Capabilities = { send: true, markRead: true, archive: true, invitations: true, media: true, attachments: true, threads: true, followsList: true, react: true, reactRemove: true, quoteReply: true, pollVote: true };

/** Every source declaring the same thing; a case overrides only the rule it is about. */
function declarations(overrides: Partial<Capabilities> = {}): CapabilityMap {
  return Object.fromEntries(accounts.map(account => [account, { ...EVERYTHING, ...overrides }])) as CapabilityMap;
}

/** What each source says it is. The cadences are the ones the adapters declare; a case may override one. */
function sources(overrides: Partial<Record<Account, number | undefined>> = {}): SourceMap {
  const poll: Record<Account, number> = { 'gmail-personal': 45_000, 'gmail-business': 45_000, whatsapp: 8_000, imessage: 8_000, linkedin: 45_000 };
  return Object.fromEntries(accounts.map(account => [account, {
    label: account,
    icon: 'MessageCircle',
    pollIntervalMs: overrides[account] ?? poll[account],
  }])) as SourceMap;
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
  if (name === 'sources') return sources();
  if (name === 'cached') return { items: [] };
  if (name === 'cached_open') return { messages: [] };
  if (name === 'open') return { messages: [] };
  if (name === 'sync') return { items: [], updatedAt: 0 };
  if (name === 'search') return { ids: [], items: [] };
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
    // The contract's call shape, rest and all: a fake is assignable to the typed dep
    // only if it accepts the optional-input tuple the contract declares.
    async call(method: string, ...args: unknown[]): Promise<any> {
      const input = args[0];
      calls.push({ name: method, input });
      const handler = handlers[method];
      return handler ? await handler(input) : defaults(method);
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
    sync: input => ({ items: input.account === 'whatsapp' ? [target] : [] }),
    cached_open: () => ({ messages: [cachedMessage] }),
    open: () => ({ messages: [liveMessage] }),
  });
  const session = createInboxSession({ rpc, now: () => 0 });
  session.start();
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
    sync: input => ({ items: input.account === 'whatsapp' ? listed : [] }),
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

test('clearing a needed label marks the row and the open conversation none', async () => {
  const target = row({ unread: false, needsAttention: 'yes' });
  const rpc = fakeRpc({
    cached: () => ({ items: [target] }),
    sync: input => ({ items: input.account === 'whatsapp' ? [target] : [] }),
    open: () => ({ messages: [liveMessage] }),
    clear_attention: () => ({ needsAttention: 'no' }),
    restore_attention: () => ({ needsAttention: 'yes' }),
  });
  const session = createInboxSession({ rpc, now: () => 0 });
  await session.refresh(['whatsapp']);
  await session.open(target);
  await session.clearAttention(session.snapshot().selected ?? target);
  assert.equal(session.snapshot().selected?.needsAttention, 'no');
  assert.equal(session.snapshot().selected?.attentionDismissed, true);
  await session.restoreAttention(session.snapshot().selected ?? target);
  assert.equal(session.snapshot().selected?.needsAttention, 'yes');
  assert.equal(session.snapshot().selected?.attentionDismissed, false);
  assert.equal(session.snapshot().items.find(item => item.id === 'chat-1')?.needsAttention, 'yes');
  assert.equal(rpc.calls.filter(call => call.name === 'clear_attention').length, 1);
  assert.equal(rpc.calls.filter(call => call.name === 'restore_attention').length, 1);
});

test('a profile URL reaches the open conversation without re-reading it', async () => {
  const target = row({ account: 'linkedin', id: 'urn:li:msg_conversation:1', title: 'Ada', sender: 'Ada', unread: false });
  let listed: InboxItem[] = [target];
  const rpc = fakeRpc({
    capabilities: () => ({ ...declarations(), linkedin: { ...EVERYTHING, followsList: false } }),
    cached: () => ({ items: listed }),
    sync: input => ({ items: input.account === 'linkedin' ? listed : [], updatedAt: 1 }),
    open: () => ({ messages: [liveMessage] }),
  });
  const session = createInboxSession({ rpc, now: () => 0 });
  await settle();
  await session.open(target);
  const opensBefore = rpc.calls.filter(call => call.name === 'open').length;
  listed = [{ ...target, profileUrl: 'https://www.linkedin.com/in/ada-lovelace' }];
  await session.refresh(['linkedin']);
  assert.equal(rpc.calls.filter(call => call.name === 'open').length, opensBefore);
  assert.equal(session.snapshot().selected?.profileUrl, 'https://www.linkedin.com/in/ada-lovelace');
  listed = [{ ...target, date: target.date + 1 }];
  await session.refresh(['linkedin']);
  assert.equal(rpc.calls.filter(call => call.name === 'open').length, opensBefore, 'LinkedIn does not follow the list, so a date change does not reopen');
});

test('a new attention label reaches the open conversation without re-reading it', async () => {
  const target = row({ unread: false, needsAttention: 'yes' });
  let listed: InboxItem[] = [target];
  const rpc = fakeRpc({
    cached: () => ({ items: listed }),
    sync: input => ({ items: input.account === 'whatsapp' ? listed : [] }),
    open: () => ({ messages: [liveMessage] }),
  });
  const session = createInboxSession({ rpc, now: () => 0 });
  await settle();
  await session.open(target);

  const opensBefore = rpc.calls.filter(call => call.name === 'open').length;
  listed = [{ ...target, needsAttention: 'no' }];
  await session.refresh(['whatsapp']);

  assert.equal(rpc.calls.filter(call => call.name === 'open').length, opensBefore, 'the thread is not read a second time');
  assert.equal(session.snapshot().selected?.needsAttention, 'no', 'the header chip follows the new label');
});

test('mute marks the list, the hit, and the open row without clearing the decision', async () => {
  const target = row({ unread: false, needsAttention: 'yes' });
  const hit = row({ id: 'chat-99', title: 'Grace', preview: 'lighthouse', date: 1, unread: false, needsAttention: 'no' });
  const rpc = fakeRpc({
    cached: () => ({ items: [target] }),
    sync: input => ({ items: input.account === 'whatsapp' ? [target] : [] }),
    search: () => ({ ids: [{ account: 'whatsapp', id: 'chat-99', score: 1 }], items: [hit] }),
    open: () => ({ messages: [liveMessage] }),
    mute: () => ({ muted: true }),
    unmute: () => ({ muted: false }),
  });
  const session = createInboxSession({ rpc, now: () => 1_000 });
  session.start();
  await settle();
  await session.open(target);
  session.setQuery('lighthouse');
  session.tick(1_000 + 150);
  await settle();

  await session.mute(session.snapshot().selected ?? target);
  assert.equal(session.snapshot().selected?.muted, true);
  assert.equal(session.snapshot().selected?.needsAttention, 'yes', 'mute does not clear the chip');
  assert.equal(session.snapshot().items.find(item => item.id === 'chat-1')?.muted, true);
  assert.equal(session.snapshot().items.find(item => item.id === 'chat-1')?.needsAttention, 'yes');
  await session.mute(hit);
  assert.equal(session.snapshot().hits?.find(item => item.id === 'chat-99')?.muted, true);
  assert.equal(session.snapshot().hits?.find(item => item.id === 'chat-99')?.needsAttention, 'no');
  assert.equal(rpc.calls.filter(call => call.name === 'mute').length, 2);

  await session.unmute(session.snapshot().selected ?? target);
  assert.equal(session.snapshot().selected?.muted, false);
  assert.equal(session.snapshot().selected?.needsAttention, 'yes');
  assert.equal(rpc.calls.filter(call => call.name === 'unmute').length, 1);
});

test('a mute mark on a later list reaches the open conversation without re-reading it', async () => {
  const target = row({ unread: false, needsAttention: 'yes' });
  let listed: InboxItem[] = [target];
  const rpc = fakeRpc({
    cached: () => ({ items: listed }),
    sync: input => ({ items: input.account === 'whatsapp' ? listed : [] }),
    open: () => ({ messages: [liveMessage] }),
  });
  const session = createInboxSession({ rpc, now: () => 0 });
  await settle();
  await session.open(target);

  const opensBefore = rpc.calls.filter(call => call.name === 'open').length;
  listed = [{ ...target, muted: true }];
  await session.refresh(['whatsapp']);

  assert.equal(rpc.calls.filter(call => call.name === 'open').length, opensBefore, 'the thread is not read a second time');
  assert.equal(session.snapshot().selected?.muted, true, 'the header follows the mute mark');
  assert.equal(session.snapshot().selected?.needsAttention, 'yes');
});

test('a failed mute puts the row back and leaves it in the list', async () => {
  const target = row({ unread: false, needsAttention: 'yes' });
  const rpc = fakeRpc({
    cached: () => ({ items: [target] }),
    sync: input => ({ items: input.account === 'whatsapp' ? [target] : [] }),
    mute: () => { throw new Error('offline'); },
  });
  const session = createInboxSession({ rpc, now: () => 0 });
  await session.refresh(['whatsapp']);
  await session.mute(target);
  const item = session.snapshot().items.find(row => row.id === 'chat-1');
  assert.equal(item?.muted, undefined);
  assert.equal(item?.needsAttention, 'yes');
  assert.equal(session.snapshot().items.length, 1);
});

test('two failures that say exactly the same words are cleared by the source that owns them', async () => {
  // Both mailboxes fail with one sentence. Clearing one has to leave the other alone, and the text
  // cannot be what tells them apart: it is identical.
  let failing = true;
  const rpc = fakeRpc({
    sync: input => {
      if (failing && (input.account === 'gmail-personal' || input.account === 'gmail-business')) throw new Error('the token expired');
      return { items: [], updatedAt: 0 };
    },
  });
  const session = createInboxSession({ rpc, now: () => 0 });
  await session.refresh(['gmail-personal', 'gmail-business']);

  const failed = session.snapshot().errors;
  assert.deepEqual(failed.map(error => error.account).sort(), ['gmail-business', 'gmail-personal'], 'one line per failed source');
  assert.equal(failed[0].message, failed[1].message, 'and both say exactly the same thing');

  failing = false;
  await session.refresh(['gmail-business']);
  const remaining = session.snapshot().errors;
  assert.deepEqual(remaining.map(error => error.account), ['gmail-personal'], 'the source that answered is cleared, the other keeps its identical line');
  assert.equal(remaining[0].message, 'could not refresh. the token expired Previously loaded messages may be stale.');
});

test('a search hit the list never loaded is carried as a row, and opens', async () => {
  const listed = row({ unread: false });
  const hit = row({ id: 'chat-99', title: 'Grace Hopper', preview: 'the lighthouse keeper', date: 1 });
  const rpc = fakeRpc({
    cached: () => ({ items: [listed] }),
    search: () => ({
      ids: [{ account: 'whatsapp', id: 'chat-99', score: 3 }],
      // The gateway answers with the row it matched; the index knows conversations the cache never held.
      items: [hit],
    }),
    open: () => ({ messages: [] }),
  });
  const session = createInboxSession({ rpc, now: () => 1_000 });
  session.start();
  await settle();

  session.setQuery('lighthouse');
  session.tick(1_000 + 150);
  await settle();

  const snapshot = session.snapshot();
  assert.deepEqual(snapshot.hits?.map(item => item.id), ['chat-99'], 'a hit absent from items is still a row');
  assert.equal(snapshot.hits?.[0].title, 'Grace Hopper');
  assert.equal(snapshot.items.some(item => item.id === 'chat-99'), false, 'and the list itself never loaded it');

  rpc.calls.length = 0;
  await session.open(snapshot.hits![0]);
  assert.ok(rpc.calls.some(call => call.name === 'open' && (call.input as { id?: string })?.id === 'chat-99'), 'the row opens like any other');
  assert.equal(session.snapshot().selected?.id, 'chat-99');

  // Clearing the query is the end of the search: the list draws its own rows again.
  session.setQuery('');
  assert.equal(session.snapshot().hits, null);
});

test('one tick reads the backend cache once, never syncing providers, even with two subscribers', async () => {
  const rpc = fakeRpc();
  const session = createInboxSession({ rpc, now: () => 1_000 });
  const seen: string[] = [];
  session.subscribe(() => seen.push('first'));
  session.subscribe(() => seen.push('second'));
  session.start();
  await settle();
  rpc.calls.length = 0;

  const at = 1_000 + 45_000;
  // A source's poll interval is its own declaration, so the first tick arms each one and the
  // one after it is the first that can fire.
  session.tick(1_000);
  assert.equal(rpc.calls.filter(call => call.name === 'sync').length, 0, 'arming fires nothing');
  session.tick(at);
  const refreshed = rpc.calls
    .filter(call => call.name === 'sync')
    .map(call => (call.input as { account: Account }).account)
    .sort();
  assert.deepEqual(refreshed, []);
  assert.equal(rpc.calls.filter(call => call.name === 'cached').length, 1);
  assert.ok(seen.length > 0, 'both subscribers were told');

  const notifications = seen.length;
  session.tick(at);
  assert.equal(rpc.calls.filter(call => call.name === 'sync').length, 0, 'a panel never schedules provider sync');
  assert.equal(rpc.calls.filter(call => call.name === 'cached').length, 1, 'a second tick at the same instant fires nothing');
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
    sync: input => ({
      items: input.account === 'whatsapp' ? [{ ...target, preview: 'On my way' }] : [],
    }),
  });
  const storage = memoryStorage();
  const session = createInboxSession({ rpc, storage, now: () => 10 });
  session.start();
  await settle();
  await session.open(target);
  const key = inboxDraftKey({ account: 'whatsapp', id: 'chat-1' });
  session.setDraft('On my way');
  session.tick(10 + 250);
  assert.equal(readInboxDraft(storage, key), 'On my way', 'the draft was on disk before sending');

  const before = rpc.calls.length;
  await session.submit();

  assert.deepEqual(
    rpc.calls.slice(before).map(call => call.name),
    ['action', 'open', 'sync', 'open', 'send_audit'],
    'one reply, the reconciliation, then the decision log the panel shows',
  );
  assert.deepEqual(
    rpc.calls[before].input,
    { account: 'whatsapp', id: 'chat-1', action: 'reply', text: 'On my way', allow: 'send' },
    'the owner pressing Send is the statement the gate needs; no other caller makes it',
  );
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

// A send that worked says nothing. The bubble is in the thread and the draft has left the composer;
// a 'Sent.' badge under either one is the panel reading back what the owner can already see.
// The notice is kept for the only send that has something to add: the one that failed, or whose
// outcome nobody knows.
test('a reply that worked leaves the notice empty, and a send_gmail receipt is not kept either', async () => {
  const target = row({ unread: false });
  const rpc = fakeRpc({
    cached: () => ({ items: [target] }),
    cached_open: () => ({ messages: [cachedMessage] }),
    open: () => ({ messages: [cachedMessage] }),
    action: () => ({ status: 'Sent.' }),
    send_gmail: () => ({ status: 'Sent.' }),
    sync: () => ({ items: [] }),
  });
  const session = createInboxSession({ rpc, now: () => 10 });
  session.start();
  await settle();
  await session.open(target);

  session.setDraft('On my way');
  await session.submit();
  assert.equal(session.snapshot().status, '', 'a reply that worked says nothing');

  session.startMail('new', 'gmail-personal');
  session.setMail({ to: 'a@example.com', text: 'On it.' });
  await session.sendMail();
  assert.equal(session.snapshot().mail, null, 'the draft leaving the composer is the receipt');
  assert.equal(session.snapshot().mailStatus, '', 'so the mail composer has nothing to report');
  assert.equal(session.snapshot().status, '', 'and the chat notice says nothing either: one rule, both surfaces');
});

test('a reply whose outcome is unknown keeps the sentence word for word, and the words in the box', async () => {
  const target = row({ unread: false });
  const unknown = 'Send failed or its outcome is unknown. Check Gmail Sent before trying again.';
  const rpc = fakeRpc({
    cached: () => ({ items: [target] }),
    cached_open: () => ({ messages: [cachedMessage] }),
    open: () => ({ messages: [cachedMessage] }),
    action: (input: any) => {
      if (input.action !== 'reply') return { status: 'Done' };
      throw new Error(unknown);
    },
    sync: () => ({ items: [] }),
  });
  const session = createInboxSession({ rpc, now: () => 10 });
  session.start();
  await settle();
  await session.open(target);

  session.setDraft('On my way');
  await session.submit();
  assert.equal(session.snapshot().status, unknown, 'the panel repeats what it was told, and does not soften it');
  assert.equal(session.snapshot().text, 'On my way', 'and the words stay in the box, because nothing is known to have left');
});

test('the snapshot keeps its identity until something changes', () => {
  // The panel reads this through useSyncExternalStore, which compares identity between
  // renders: a fresh object per call would loop forever.
  const session = createInboxSession({ rpc: fakeRpc(), storage: memoryStorage(), now: () => 1_000 });
  const first = session.snapshot();
  assert.equal(session.snapshot(), first, 'two reads with no change are the same object');

  session.setFilter('unread');
  const second = session.snapshot();
  assert.notEqual(second, first, 'a change publishes a new object');
  assert.equal(session.snapshot(), second, 'and exactly one new object per change');
  assert.equal(second.filter, 'unread');
  assert.equal(first.filter, 'all', 'the published snapshot is not mutated in place');
});

test('constructing a session calls nothing; start() runs the first load once', async () => {
  // The panel builds the session while rendering, so the constructor must stay side-effect
  // free; the first load belongs to an effect, and running it twice must change nothing.
  const rpc = fakeRpc({ cached: () => ({ items: [row()] }) });
  const session = createInboxSession({ rpc, now: () => 0 });
  assert.equal(rpc.calls.length, 0, 'building the session issues no call');

  session.start();
  await settle();
  const afterStart = rpc.calls.map((call: { name: string }) => call.name);
  assert.ok(afterStart.includes('capabilities') && afterStart.includes('cached'), 'start loads the declarations and the cache');

  session.start();
  await settle();
  assert.equal(rpc.calls.filter((call: { name: string }) => call.name === 'cached').length, 1, 'a second start is a no-op');
});

test('the last open wins: a slow first thread never replaces the second', async () => {
  const first = row({ id: 'chat-1', unread: false });
  const second = row({ id: 'chat-2', unread: false });
  let releaseFirst: () => void = () => {};
  const firstThread: Message = { sender: 'Ada', text: 'first thread', date: 1 };
  const secondThread: Message = { sender: 'Ada', text: 'second thread', date: 2 };
  const rpc = fakeRpc({
    cached: () => ({ items: [first, second] }),
    sync: input => ({ items: input.account === 'whatsapp' ? [first, second] : [] }),
    cached_open: () => ({ messages: [] }),
    open: input => input.id === 'chat-1'
      ? new Promise(resolve => { releaseFirst = () => resolve({ messages: [firstThread] }); })
      : { messages: [secondThread] },
  });
  const session = createInboxSession({ rpc, now: () => 0 });
  session.start();
  await settle();

  // Both opens start; the first is still in flight when the second lands.
  const slow = session.open(first);
  await settle();
  await session.open(second);
  assert.deepEqual(session.snapshot().messages, [secondThread], 'the second thread is on screen');
  assert.equal(session.snapshot().selected?.id, 'chat-2');

  // The first thread now answers, late. It must not touch the panel.
  releaseFirst();
  await slow;
  await settle();
  assert.deepEqual(session.snapshot().messages, [secondThread], 'the late answer is dropped, not shown');
  assert.equal(session.snapshot().selected?.id, 'chat-2', 'the selection is unchanged');
  assert.equal(session.snapshot().opening, false);
});

test('a refused mark puts the row back exactly as it stood', async () => {
  const target = row({ unread: false });
  const neighbour = row({ id: 'chat-2', unread: true });
  const cachedThread: Message = { sender: 'Ada', text: 'cached', date: 1 };
  const rpc = fakeRpc({
    cached: () => ({ items: [target, neighbour] }),
    sync: input => ({ items: input.account === 'whatsapp' ? [target, neighbour] : [] }),
    cached_open: () => ({ messages: [cachedThread] }),
    open: () => ({ messages: [cachedThread] }),
    action: () => { throw new Error('WhatsApp refused the update.'); },
  });
  const session = createInboxSession({ rpc, now: () => 0 });
  session.start();
  await settle();
  await session.open(target);

  // Optimistic: the row and the open thread change before the source answers.
  const pending = session.mark(target, 'archive');
  assert.equal(
    session.snapshot().items.some(item => item.id === 'chat-1'),
    false,
    'archiving hides the row at once',
  );
  assert.equal(session.snapshot().selected, null, 'and closes the thread it had open');

  await pending;
  const after = session.snapshot();
  assert.deepEqual(
    after.items.map(item => [item.id, item.unread]),
    [['chat-1', false], ['chat-2', true]],
    'every row is back, in order, as it stood',
  );
  assert.equal(after.selected?.id, 'chat-1', 'the open thread is restored');
  assert.equal(after.status, 'WhatsApp refused the update.', 'and the reason is on screen');
});

test('a refused send is visible in the panel, not only in the CLI', async () => {
  const target = row({ unread: false });
  const recorded = [
    { at: 1_700_000_000_000, account: 'whatsapp', conversationId: 'chat-1', decision: 'refused', reason: 'A send needs an approval for the conversation it goes to; nothing was sent.' },
  ];
  const rpc = fakeRpc({
    cached: () => ({ items: [target] }),
    sync: input => ({ items: input.account === 'whatsapp' ? [target] : [] }),
    cached_open: () => ({ messages: [{ sender: 'Ada', text: 'hi', date: 1 }] }),
    open: () => ({ messages: [{ sender: 'Ada', text: 'hi', date: 1 }] }),
    send_audit: () => ({ rows: recorded }),
    action: () => { throw new Error('A send needs an approval for the conversation it goes to; nothing was sent.'); },
  });
  const session = createInboxSession({ rpc, now: () => 0 });
  session.start();
  await settle();
  await session.open(target);
  session.setDraft('see you at six');
  await session.submit();

  assert.equal(
    rpc.calls.filter(call => call.name === 'send_audit').length > 0,
    true,
    'a send attempt re-reads the decision log',
  );
  const audit = session.snapshot().audit;
  assert.deepEqual(
    audit.map(entry => [entry.decision, entry.account]),
    [['refused', 'whatsapp']],
    'and the refused attempt is in the snapshot the panel renders',
  );
});

test('the send log is opened from the inbox menu, not sitting above the list', async () => {
  const rpc = fakeRpc({
    cached: () => ({ items: [row({ unread: false })] }),
    sync: input => ({ items: input.account === 'whatsapp' ? [row({ unread: false })] : [] }),
    send_audit: () => ({
      rows: [{ at: 5, account: 'whatsapp', conversationId: 'chat-1', decision: 'refused', reason: 'nothing was sent' }],
    }),
  });
  const session = createInboxSession({ rpc, now: () => 0 });
  session.start();
  await settle();

  assert.equal(session.snapshot().auditOpen, false, 'the list is what the panel shows until asked');

  await session.showAudit();
  const reads = rpc.calls.filter(call => call.name === 'send_audit');
  assert.equal(session.snapshot().auditOpen, true, 'the menu item opens the log');
  const lastRead = reads.at(-1)!;
  assert.equal((lastRead.input as { limit?: number }).limit, 20, 'a log view reads more than the five the badge needs');
  assert.deepEqual(session.snapshot().audit.map(entry => entry.decision), ['refused']);

  session.hideAudit();
  assert.equal(session.snapshot().auditOpen, false, 'and closes back to the list');
});

test('reply all seeds the addresses the thread already knows, and every mail draft starts with no blind copy', async () => {
  const target = row({ account: 'gmail-personal', id: 't1', title: 'Plan' });
  const liveMessage = { sender: 'Ada <ada@example.com>', text: 'The plan', date: 1, subject: 'Plan', messageId: '<m1@example.com>', suggestedTo: 'ada@example.com', suggestedCc: 'bo@example.com' };
  const rpc = fakeRpc({
    cached: () => ({ items: [target] }),
    sync: () => ({ items: [] }),
    open: () => ({ messages: [liveMessage] }),
  });
  const session = createInboxSession({ rpc, now: () => 0 });
  session.start();
  await settle();
  await session.open(target);

  session.startMail('replyAll', 'gmail-personal');
  assert.deepEqual(
    { to: session.snapshot().mail?.to, cc: session.snapshot().mail?.cc, bcc: session.snapshot().mail?.bcc },
    { to: 'ada@example.com', cc: 'bo@example.com', bcc: '' },
    'reply all fills what the thread knows; a blind copy is the owner’s to add',
  );

  session.startMail('reply', 'gmail-personal');
  assert.equal(session.snapshot().mail?.cc, '', 'a plain reply does not copy anyone');
  assert.equal(session.snapshot().mail?.bcc, '', 'and still starts with no blind copy');
});

test('a blind copy the owner types reaches send_gmail with the rest of the draft', async () => {
  const target = row({ account: 'gmail-personal', id: 't1', title: 'Plan' });
  const rpc = fakeRpc({
    cached: () => ({ items: [target] }),
    sync: () => ({ items: [] }),
    open: () => ({ messages: [{ sender: 'Ada <ada@example.com>', text: 'The plan', date: 1, subject: 'Plan', messageId: '<m1@example.com>', suggestedTo: 'ada@example.com' }] }),
    send_gmail: () => ({ status: 'Sent.' }),
  });
  const session = createInboxSession({ rpc, now: () => 0 });
  session.start();
  await settle();
  await session.open(target);
  session.startMail('reply', 'gmail-personal');
  session.setMail({ bcc: 'hidden@example.com', text: 'On it.' });
  await session.sendMail();

  const sent = rpc.calls.filter(call => call.name === 'send_gmail').at(-1)!;
  assert.deepEqual(
    { to: (sent.input as any).to, cc: (sent.input as any).cc, bcc: (sent.input as any).bcc, text: (sent.input as any).text },
    { to: 'ada@example.com', cc: '', bcc: 'hidden@example.com', text: 'On it.' },
    'the draft the owner wrote is the draft that is sent, blind copies included',
  );
  assert.equal(session.snapshot().mail, null, 'a sent draft leaves the composer');
});

test('a Gmail reply shows in the open thread, and the stored copy replaces that line', async () => {
  const target = row({ account: 'gmail-personal', id: 't1', title: 'Plan' });
  const prior = { sender: 'Ada <ada@example.com>', text: 'The plan', date: 1, subject: 'Plan', messageId: '<m1@example.com>', suggestedTo: 'ada@example.com' };
  let opened: Message[] = [prior];
  const rpc = fakeRpc({
    cached: () => ({ items: [target] }),
    sync: () => ({ items: [] }),
    open: () => ({ messages: opened }),
    send_gmail: () => {
      opened = [...opened, { sender: 'Me <me@example.com>', text: 'On it.\n\nOn Mon Ada wrote:\n> The plan', date: 50, gmailId: 'm2' }];
      return { status: 'Sent.' };
    },
  });
  const session = createInboxSession({ rpc, now: () => 10 });
  session.start();
  await settle();
  await session.open(target);
  session.startMail('reply', 'gmail-personal');
  session.setMail({ text: 'On it.' });
  await session.sendMail();

  assert.equal(session.snapshot().mail, null);
  assert.equal(session.snapshot().messages.length, 2, 'the thread gains the reply');
  assert.equal(session.snapshot().messages.some(message => message.fromMe), false, 'the stored copy replaces the temporary line');
  assert.match(session.snapshot().messages[1].text, /^On it\./);
  assert.ok(rpc.calls.filter(call => call.name === 'open').length >= 2, 'the open thread is read again after the send');
});

test('a Gmail reply stays on screen when the reload has not stored it yet', async () => {
  const target = row({ account: 'gmail-personal', id: 't1', title: 'Plan' });
  const prior = { sender: 'Ada <ada@example.com>', text: 'The plan', date: 1, subject: 'Plan', messageId: '<m1@example.com>', suggestedTo: 'ada@example.com' };
  const rpc = fakeRpc({
    cached: () => ({ items: [target] }),
    sync: () => ({ items: [] }),
    open: () => ({ messages: [prior] }),
    send_gmail: () => ({ status: 'Sent.' }),
  });
  const session = createInboxSession({ rpc, now: () => 10 });
  session.start();
  await settle();
  await session.open(target);
  session.startMail('reply', 'gmail-personal');
  session.setMail({ text: 'On it.' });
  await session.sendMail();

  const last = session.snapshot().messages.at(-1);
  assert.equal(last?.fromMe, true);
  assert.equal(last?.text, 'On it.');
  assert.equal(session.snapshot().messages[0].text, 'The plan', 'the earlier message stays');
});

test('a Gmail reply moves its row above a newer received one, and a stale cache read leaves it there', async () => {
  const target = row({ account: 'gmail-personal', id: 't1', title: 'Plan', preview: 'The plan', date: 10, sender: 'Ada' });
  const other = row({ account: 'gmail-personal', id: 't2', title: 'Other', preview: 'Later', date: 20, sender: 'Bea' });
  const prior = { sender: 'Ada <ada@example.com>', text: 'The plan', date: 1, subject: 'Plan', messageId: '<m1@example.com>', suggestedTo: 'ada@example.com' };
  let cached = [other, target];
  const rpc = fakeRpc({
    cached: () => ({ items: cached }),
    sync: () => ({ items: cached }),
    open: () => ({ messages: [prior] }),
    send_gmail: () => ({ status: 'Sent.' }),
  });
  const session = createInboxSession({ rpc, now: () => 100 });
  session.start();
  await settle();
  await session.open(target);
  session.startMail('reply', 'gmail-personal');
  session.setMail({ text: 'On it.' });
  await session.sendMail();

  assert.deepEqual(session.snapshot().items.map(item => item.id), ['t1', 't2'], 'the reply is the newest line, so the row leads');
  assert.equal(session.snapshot().items[0].preview, 'On it.');
  assert.equal(session.snapshot().items[0].date, 100);
  assert.equal(session.snapshot().items[0].sender, 'Ada', 'the row is still the other person');
  assert.equal(session.snapshot().selected?.preview, 'On it.');

  session.tick(0);
  session.tick(5_000);
  await settle();
  assert.equal(session.snapshot().items[0].id, 't1');
  assert.equal(session.snapshot().items[0].preview, 'On it.', 'a cache from before the send does not put the row back');

  cached = [{ ...target, date: 100, preview: 'On it.' }, other];
  session.tick(10_000);
  await settle();
  assert.equal(session.snapshot().items.find(item => item.id === 't1')?.preview, 'On it.');
  assert.equal(session.snapshot().items[0].id, 't1');
});

const bytes = (size: number) => Buffer.alloc(size, 'a').toString('base64');

test('a draft takes attachments, refuses one that would make it too big, and can drop them again', async () => {
  const rpc = fakeRpc({ cached: () => ({ items: [] }), sync: () => ({ items: [] }) });
  const session = createInboxSession({ rpc, now: () => 0 });
  session.start();
  await settle();
  session.startMail('new', 'gmail-personal');

  assert.equal(session.attach({ name: 'plan.pdf', mimeType: 'application/pdf', size: 3, data: bytes(3) }), true, 'a small file is taken');
  assert.deepEqual(session.snapshot().mail?.attachments.map(a => a.name), ['plan.pdf']);

  assert.equal(session.attach({ name: 'huge.zip', mimeType: 'application/zip', size: 20 * 1024 * 1024, data: bytes(20 * 1024 * 1024) }), false, 'a draft that would be too big is refused');
  assert.deepEqual(session.snapshot().mail?.attachments.map(a => a.name), ['plan.pdf'], 'the refused file is not added');
  assert.match(session.snapshot().mailStatus, /too large/i, 'and the composer is told why');

  session.detach(0);
  assert.deepEqual(session.snapshot().mail?.attachments, [], 'an attachment can be taken back off the draft');
});

test('a size is judged by the bytes Gmail encodes, and the refusal names that ceiling', async () => {
  const rpc = fakeRpc({ cached: () => ({ items: [] }), sync: () => ({ items: [] }) });
  const session = createInboxSession({ rpc, now: () => 0 });
  session.start();
  await settle();
  session.startMail('new', 'gmail-personal');

  // base64 spends four bytes on three, so Gmail's 25 MB of message is 18.75 MB of file: that one fits.
  const atCeiling = 25 * 1024 * 1024 / 4 * 3;
  assert.equal(session.attach({ name: 'plan.zip', mimeType: 'application/zip', size: atCeiling, data: bytes(atCeiling) }), true, 'a file that encodes to exactly the ceiling is taken');

  assert.equal(session.attach({ name: 'one-more.txt', mimeType: 'text/plain', size: 1, data: bytes(1) }), false, 'the next file would cross it');
  assert.deepEqual(session.snapshot().mail?.attachments.map(a => a.name), ['plan.zip'], 'the refused file is not added');
  assert.match(session.snapshot().mailStatus, /too large/i, 'and the composer is told why');
  assert.match(session.snapshot().mailStatus, /25 MB/, 'naming the ceiling the draft hit');
});

test('the words count against the same ceiling, because Gmail measures the encoded message', async () => {
  const rpc = fakeRpc({ cached: () => ({ items: [] }), sync: () => ({ items: [] }) });
  const session = createInboxSession({ rpc, now: () => 0 });
  session.start();
  await settle();
  session.startMail('new', 'gmail-personal');

  // What is left for files once the body is encoded into the message Gmail measures.
  const room = 25 * 1024 * 1024 - Math.ceil(1000 / 3) * 4;
  session.setMail({ to: 'a@example.com', text: 'x'.repeat(1000) });
  assert.equal(session.attach({ name: 'plan.zip', mimeType: 'application/zip', size: room / 4 * 3, data: bytes(room / 4 * 3) }), true, 'a file that fits beside the words is taken');
  assert.equal(session.attach({ name: 'one-more.txt', mimeType: 'text/plain', size: 4, data: bytes(4) }), false, 'and the one that does not is refused');
  assert.match(session.snapshot().mailStatus, /25 MB/);
});

test('a draft with an attachment and no body is still worth sending, and the file travels with it', async () => {
  const rpc = fakeRpc({
    cached: () => ({ items: [] }),
    sync: () => ({ items: [] }),
    send_gmail: () => ({ status: 'Sent.' }),
  });
  const session = createInboxSession({ rpc, now: () => 0 });
  session.start();
  await settle();
  session.startMail('new', 'gmail-personal');
  session.setMail({ to: 'a@example.com', subject: 'The plan' });
  session.attach({ name: 'plan.pdf', mimeType: 'application/pdf', size: 3, data: bytes(3) });
  await session.sendMail();

  const sent = rpc.calls.filter(call => call.name === 'send_gmail').at(-1)!;
  assert.deepEqual((sent.input as any).attachments, [{ name: 'plan.pdf', mimeType: 'application/pdf', size: 3, data: bytes(3) }], 'the file is sent exactly as it was attached');
  assert.equal(session.snapshot().mail, null);
});

test('show older appends the next page, drops a row already on screen, and stops offering more', async () => {
  const newest = row({ account: 'gmail-personal', id: 't1', date: 30 });
  const repeated = row({ account: 'gmail-personal', id: 't2', date: 20 });
  const older = row({ account: 'gmail-personal', id: 't3', date: 10 });
  const rpc = fakeRpc({
    cached: () => ({ items: [newest, repeated], more: { 'gmail-personal': true } }),
    sync: input => ({ items: input.account === 'gmail-personal' ? [newest, repeated] : [], more: input.account === 'gmail-personal' }),
    list: () => ({ items: [repeated, older], errors: [], more: false }),
  });
  const session = createInboxSession({ rpc, now: () => 0 });
  session.start();
  await settle();
  assert.equal(session.snapshot().hasOlder, true, 'a source that has older rows offers them');

  await session.more();
  assert.deepEqual(session.snapshot().items.map(item => item.id), ['t1', 't2', 't3'], 'the older row lands after the rows already shown');
  assert.deepEqual(rpc.calls.filter(call => call.name === 'list').map(call => call.input), [{ older: true, account: 'gmail-personal' }], 'one call answers that source; the sources that said nothing older are not asked');
  assert.equal(session.snapshot().hasOlder, false, 'the last page stops offering more');
  assert.equal(session.snapshot().loadingOlder, false);

  // Nothing older is left, so a second press changes nothing and asks nothing.
  await session.more();
  assert.deepEqual(session.snapshot().items.map(item => item.id), ['t1', 't2', 't3']);
  assert.equal(rpc.calls.filter(call => call.name === 'list').length, 1, 'an exhausted list is not asked again');
});

test('an older Gmail snippet sits under the mail already shown, and one visible row is filled at a time', async () => {
  const newest = row({ account: 'gmail-personal', id: 't1', date: 30, sender: 'Ada' });
  const older = row({ account: 'gmail-personal', id: 't2', date: 0, title: '', sender: undefined, preview: 'Older note', listedOnly: true, unread: false });
  const behind = row({ account: 'gmail-personal', id: 't3', date: 0, title: '', sender: undefined, preview: 'Further note', listedOnly: true, unread: false });
  let pending: Array<(value: InboxItem) => void> = [];
  const rpc = fakeRpc({
    cached: () => ({ items: [newest], more: { 'gmail-personal': true } }),
    sync: input => ({ items: input.account === 'gmail-personal' ? [newest] : [], more: input.account === 'gmail-personal' }),
    list: () => ({ items: [older, behind], errors: [], more: false }),
    disclose: input => new Promise(resolve => { pending.push(value => resolve({ ...value, ...(input as { id: string }) })); }),
  });
  const session = createInboxSession({ rpc, now: () => 0 });
  session.start();
  await settle();
  await session.more();
  const listed = session.snapshot().items.filter(item => item.listedOnly);
  assert.deepEqual(listed.map(item => item.id), ['t2', 't3']);
  assert.deepEqual(listed.map(item => item.date), [29, 28], 'the snippets keep the page order under the mail already shown');
  assert.equal(rpc.calls.filter(call => call.name === 'disclose').length, 0, 'a page does not read a thread');

  session.showListed([{ account: 'gmail-personal', id: 't2' }, { account: 'gmail-personal', id: 't3' }]);
  await settle();
  assert.equal(rpc.calls.filter(call => call.name === 'disclose').length, 1, 'one row on screen is one read');
  pending[0]({ ...older, sender: 'Grace', title: 'Older', date: 12, preview: 'Older note', unread: true, listedOnly: undefined });
  await settle();
  const filled = session.snapshot().items.find(item => item.id === 't2');
  assert.equal(filled?.sender, 'Grace');
  assert.equal(filled?.date, 12);
  assert.equal(filled?.listedOnly, undefined);
  assert.equal(rpc.calls.filter(call => call.name === 'disclose').length, 2, 'the next visible row waits for the first read');
});

test('a Gmail quota error while filling one row leaves the snippet on screen', async () => {
  const newest = row({ account: 'gmail-personal', id: 't1', date: 30, sender: 'Ada' });
  const older = row({ account: 'gmail-personal', id: 't2', date: 0, title: '', sender: undefined, preview: 'Older note', listedOnly: true, unread: false });
  const rpc = fakeRpc({
    cached: () => ({ items: [newest], more: { 'gmail-personal': true } }),
    sync: input => ({ items: input.account === 'gmail-personal' ? [newest] : [], more: input.account === 'gmail-personal' }),
    list: () => ({ items: [older], errors: [], more: false }),
    disclose: () => { throw new Error("gmail gmail-personal request failed (403 rateLimitExceeded): Quota exceeded for quota metric 'Total Query Cost' and limit 'Units per minute per user'"); },
  });
  const session = createInboxSession({ rpc, now: () => 0 });
  session.start();
  await settle();
  await session.more();
  session.showListed([{ account: 'gmail-personal', id: 't2' }]);
  await settle();
  const shown = session.snapshot().items.find(item => item.id === 't2');
  assert.equal(shown?.listedOnly, true);
  assert.equal(shown?.preview, 'Older note');
  assert.equal(session.snapshot().errors.length, 0, 'the page already shown stays, with no older-page error');
  assert.equal(rpc.calls.filter(call => call.name === 'disclose').length, 1, 'the same visible row is not read again while it stays on screen');
});

test('show older grows the list as each source answers, not when the slowest does', async () => {
  const mine = row({ account: 'gmail-personal', id: 't1', date: 30 });
  const chat = row({ account: 'whatsapp', id: 'c1', date: 20 });
  const olderChat = row({ account: 'whatsapp', id: 'c2', date: 5 });
  const olderMail = row({ account: 'gmail-personal', id: 't2', date: 10 });
  let release: () => void = () => {};
  const rpc = fakeRpc({
    cached: () => ({ items: [mine, chat], more: { 'gmail-personal': true, whatsapp: true } }),
    sync: input => ({
      items: input.account === 'gmail-personal' ? [mine] : input.account === 'whatsapp' ? [chat] : [],
      more: input.account === 'gmail-personal' || input.account === 'whatsapp',
    }),
    list: input => input.account === 'gmail-personal'
      ? new Promise(resolve => { release = () => resolve({ items: [olderMail], errors: [], more: false }); })
      : { items: [olderChat], errors: [], more: false },
  });
  const session = createInboxSession({ rpc, now: () => 0 });
  session.start();
  await settle();

  const round = session.more();
  await settle();
  assert.deepEqual(session.snapshot().items.map(item => item.id), ['t1', 'c1', 'c2'], 'the fast source lands while the slow one is still reading');
  assert.equal(session.snapshot().loadingOlder, true, 'the round is still open');

  release();
  await round;
  assert.deepEqual(session.snapshot().items.map(item => item.id), ['t1', 'c1', 't2', 'c2'], 'the slow source lands into the same list');
  assert.equal(session.snapshot().loadingOlder, false);
  assert.equal(session.snapshot().hasOlder, false, 'both sources said there is nothing older');
});

test('an older page that misses its ceiling is given up with a line, and the rows on screen stay', async () => {
  const newest = row({ account: 'gmail-personal', id: 't1', date: 30 });
  const late = row({ account: 'gmail-personal', id: 't2', date: 10 });
  let answer: (value: unknown) => void = () => {};
  const rpc = fakeRpc({
    cached: () => ({ items: [newest], more: { 'gmail-personal': true } }),
    sync: input => ({ items: input.account === 'gmail-personal' ? [newest] : [], more: input.account === 'gmail-personal' }),
    list: () => new Promise(resolve => { answer = resolve; }),
  });
  const session = createInboxSession({ rpc, now: () => 0 });
  session.start();
  await settle();
  const round = session.more();
  await settle();
  assert.equal(session.snapshot().loadingOlder, true);

  // The session's own heartbeat is the clock: a page open past its ceiling is given up there.
  session.tick(15_000);
  const timedOut = session.snapshot();
  assert.equal(timedOut.loadingOlder, false, 'the control is usable again instead of wedged');
  assert.deepEqual(timedOut.items.map(item => item.id), ['t1'], 'the rows already shown are untouched');
  assert.ok(timedOut.errors.some(line => line.kind === 'older' && line.account === undefined && line.message.startsWith('Older conversations could not load in time')), 'and it says so in words a person can read');

  // The answer arrives late; the owner was told the wait was given up, so it is dropped.
  answer({ items: [late], errors: [], more: false });
  await round;
  assert.deepEqual(session.snapshot().items.map(item => item.id), ['t1'], 'a page given up on does not appear afterwards');
  assert.equal(session.snapshot().hasOlder, true, 'and the source can still be asked again');
});

test('a first older page that is already on screen is followed once, and the page behind it lands', async () => {
  const newest = row({ account: 'linkedin', id: 't1', date: 30 });
  const shown = row({ account: 'linkedin', id: 't2', date: 20 });
  const behind = row({ account: 'linkedin', id: 't3', date: 10 });
  let calls = 0;
  const rpc = fakeRpc({
    cached: () => ({ items: [newest, shown], more: { linkedin: true } }),
    sync: input => ({ items: input.account === 'linkedin' ? [newest, shown] : [], more: input.account === 'linkedin' }),
    list: () => {
      calls += 1;
      return calls === 1
        ? { items: [newest, shown], errors: [], more: true }
        : { items: [behind], errors: [], more: true };
    },
  });
  const session = createInboxSession({ rpc, now: () => 0 });
  session.start();
  await settle();

  await session.more();
  const snapshot = session.snapshot();
  assert.equal(calls, 2, 'the repeated page is asked once more');
  assert.deepEqual(snapshot.items.map(item => item.id), ['t1', 't2', 't3']);
  assert.equal(snapshot.errors.length, 0, 'the page behind the repeated one is the answer');
  assert.equal(snapshot.hasOlder, true);
});

test('an older read the browser did not answer keeps the button and names the failure', async () => {
  const newest = row({ account: 'linkedin', id: 't1', date: 30 });
  const rpc = fakeRpc({
    cached: () => ({ items: [newest], more: { linkedin: true } }),
    sync: input => ({ items: input.account === 'linkedin' ? [newest] : [], more: input.account === 'linkedin' }),
    list: () => ({ items: [], errors: ['The LinkedIn browser did not answer Runtime.evaluate.'], more: true }),
  });
  const session = createInboxSession({ rpc, now: () => 0 });
  session.start();
  await settle();

  await session.more();
  const snapshot = session.snapshot();
  assert.deepEqual(snapshot.items.map(item => item.id), ['t1'], 'a missed answer adds nothing');
  assert.ok(
    snapshot.errors.some(error => error.account === 'linkedin' && error.message.includes('did not answer') && !error.message.includes('already on screen')),
    'the line names the missed answer',
  );
  assert.equal(snapshot.hasOlder, true, 'the same page can be asked again');
});

test('a page that adds nothing while the source says more is a line, not a silent click', async () => {
  const newest = row({ account: 'gmail-personal', id: 't1', date: 30 });
  const shown = row({ account: 'gmail-personal', id: 't2', date: 20 });
  const rpc = fakeRpc({
    cached: () => ({ items: [newest, shown], more: { 'gmail-personal': true } }),
    sync: input => ({ items: input.account === 'gmail-personal' ? [newest, shown] : [], more: input.account === 'gmail-personal' }),
    // The source re-serves rows the list already holds and still claims there is more.
    list: () => ({ items: [shown], errors: [], more: true }),
  });
  const session = createInboxSession({ rpc, now: () => 0 });
  session.start();
  await settle();

  await session.more();
  const snapshot = session.snapshot();
  assert.deepEqual(snapshot.items.map(item => item.id), ['t1', 't2'], 'nothing is duplicated and nothing is lost');
  assert.ok(
    snapshot.errors.some(error => error.account === 'gmail-personal' && error.message.startsWith('could not load older conversations: it answered with rows already on screen')),
    'a press that adds nothing says so',
  );
  assert.equal(snapshot.hasOlder, true, 'the source is still offered, because it says it has more');
});

test('show older is one request at a time', async () => {
  const newest = row({ account: 'gmail-personal', id: 't1', date: 30 });
  let release: () => void = () => {};
  const rpc = fakeRpc({
    cached: () => ({ items: [newest], more: { 'gmail-personal': true } }),
    sync: input => ({ items: input.account === 'gmail-personal' ? [newest] : [], more: input.account === 'gmail-personal' }),
    list: () => new Promise(resolve => { release = () => resolve({ items: [row({ account: 'gmail-personal', id: 't3', date: 10 })], errors: [], more: false }); }),
  });
  const session = createInboxSession({ rpc, now: () => 0 });
  session.start();
  await settle();

  const first = session.more();
  await settle();
  assert.equal(session.snapshot().loadingOlder, true, 'the control says it is working');
  await session.more();
  assert.equal(rpc.calls.filter(call => call.name === 'list').length, 1, 'a second press while one page is in flight asks nothing');

  release();
  await first;
  assert.deepEqual(session.snapshot().items.map(item => item.id), ['t1', 't3']);
  assert.equal(session.snapshot().loadingOlder, false);
});

test('a failed show older lands in errors and the rows already shown survive', async () => {
  const newest = row({ account: 'gmail-personal', id: 't1', date: 30 });
  const rpc = fakeRpc({
    cached: () => ({ items: [newest], more: { 'gmail-personal': true } }),
    sync: input => ({ items: input.account === 'gmail-personal' ? [newest] : [], more: input.account === 'gmail-personal' }),
    list: () => { throw new Error('Gmail thread list request failed (403).'); },
  });
  const session = createInboxSession({ rpc, now: () => 0 });
  session.start();
  await settle();

  await session.more();
  const snapshot = session.snapshot();
  assert.deepEqual(snapshot.items.map(item => item.id), ['t1'], 'the list on screen is untouched');
  assert.equal(snapshot.loadingOlder, false);
  assert.ok(snapshot.errors.some(error => error.account === 'gmail-personal' && error.message.startsWith('could not load older conversations')), 'the failure is a line in the panel, owned by the source, not a throw');
});

test('a refresh keeps the rows show older loaded, and an archived one does not return', async () => {
  const newest = row({ account: 'gmail-personal', id: 't1', date: 30, unread: false });
  const older = row({ account: 'gmail-personal', id: 't3', date: 10, unread: false });
  const rpc = fakeRpc({
    cached: () => ({ items: [newest], more: { 'gmail-personal': true } }),
    sync: input => ({ items: input.account === 'gmail-personal' ? [newest] : [], more: input.account === 'gmail-personal' }),
    list: () => ({ items: [older], errors: [], more: true }),
  });
  const session = createInboxSession({ rpc, now: () => 0 });
  session.start();
  await settle();
  await session.more();
  assert.deepEqual(session.snapshot().items.map(item => item.id), ['t1', 't3']);

  await session.refresh(['gmail-personal']);
  assert.deepEqual(session.snapshot().items.map(item => item.id), ['t1', 't3'], 'a refresh cannot silently shorten what the owner asked to see');

  await session.mark(older, 'archive');
  assert.deepEqual(session.snapshot().items.map(item => item.id), ['t1']);
  await session.refresh(['gmail-personal']);
  assert.deepEqual(session.snapshot().items.map(item => item.id), ['t1'], 'an archived row does not come back with the older pages');
});

test('backend freshness drives the panel, including failures, without any sync call', async () => {
  let failed = false;
  const target = row({ account: 'linkedin' });
  const rpc = fakeRpc({
    cached: () => ({ items: [target], freshness: Object.fromEntries(accounts.map(account => [account, {
      lastAttemptAt: failed ? 200 : 100, lastSuccessAt: 100,
      lastError: failed && account === 'linkedin' ? 'LinkedIn unavailable.' : null,
      cacheFallback: failed,
    }])) }),
  });
  const session = createInboxSession({ rpc, now: () => 999 });
  session.start();
  await settle();
  assert.equal(session.snapshot().refreshedAt.linkedin, 100);
  failed = true;
  session.tick(0);
  session.tick(5_000);
  await settle();
  assert.equal(session.snapshot().refreshedAt.linkedin, 100, 'cache observation cannot advance live success');
  assert.equal(session.snapshot().items[0].id, target.id);
  assert.ok(session.snapshot().errors.some(error => error.account === 'linkedin' && error.message.includes('stale')));
  assert.equal(rpc.calls.filter(call => call.name === 'sync').length, 0);
  await session.refresh();
  assert.deepEqual(rpc.calls.filter(call => call.name === 'sync').map(call => (call.input as { account: Account }).account).sort(), [...accounts].sort(), 'manual refresh includes LinkedIn');
});

test('cached body fallback is visible in the thread', async () => {
  const rpc = fakeRpc({ open: () => ({ messages: [cachedMessage], cacheFallback: true, updatedAt: 123 }) });
  const session = createInboxSession({ rpc });
  await session.open(row({ unread: false }));
  assert.deepEqual(session.snapshot().messages, [cachedMessage]);
  assert.match(session.snapshot().status, /cached messages.*stale/);
});

// Type-level: the seam to the gateway is `rpcContract`, so these lines are the
// tripwire the hand-written method-name list used to be. `tsc --noEmit` fails if
// `sync` is renamed or dropped, and each `@ts-expect-error` goes unused (TS2578)
// the moment the call below it starts compiling — the guard cannot rot silently.
test('the rpc dep is the contract: a dead method name or a wrong input does not compile', async () => {
  const rpc: InboxSessionDeps['rpc'] = fakeRpc();
  // @ts-expect-error `list_source` was deleted: `sync` is the one refresh primitive.
  await rpc.call('list_source', { account: 'whatsapp' });
  // @ts-expect-error `linkedin_sync` went with it.
  await rpc.call('linkedin_sync', { account: 'linkedin' });
  // @ts-expect-error an account id is a string: a chat id, a legacy id, or a mailbox address.
  await rpc.call('sync', { account: 1 });
  // @ts-expect-error `sync` names its account; the input is not optional.
  await rpc.call('sync');
  // The same call the session makes still compiles, at the same seam.
  assert.deepEqual(await rpc.call('sync', { account: 'whatsapp' }), { items: [], updatedAt: 0 });
});

// U4 — the inbox no longer owns pairing. An unpaired source is still a state: a refresh that
// returns no rows adds no failure line, and neither start nor tick asks whatsapp_pairing.

test('an unpaired WhatsApp is a state the panel can draw, and not a failure it has to explain', async () => {
  const rpc = fakeRpc({
    whatsapp_pairing: () => ({ state: 'unpaired' }),
    sync: () => ({ items: [], updatedAt: 1 }),
  });
  const session = createInboxSession({ rpc, now: () => 0 });
  session.start();
  await settle();
  await session.refresh(['whatsapp']);

  assert.equal(rpc.calls.some(call => call.name === 'whatsapp_pairing'), false, 'the inbox does not ask where pairing stands');
  assert.equal('pairWhatsApp' in session, false, 'the inbox cannot open a socket to pair');
  assert.equal('rePairWhatsApp' in session, false, 'the inbox cannot close a linked socket');
  assert.deepEqual(session.snapshot().errors, [], 'an unpaired source is not a refresh failure, so no line is added');
  assert.equal(session.snapshot().status, '', 'and nothing is announced in the notice area either');
});

test('session start with a connected WhatsApp transport does not call whatsapp_pairing', async () => {
  const rpc = fakeRpc({
    sync: () => ({ items: [row({ unread: false })], updatedAt: 1 }),
    whatsapp_pairing: () => ({ state: 'connected' }),
  });
  const session = createInboxSession({ rpc, now: () => 0 });
  session.start();
  await settle();
  session.tick(2_000);
  session.tick(4_000);
  session.tick(10_000);
  await settle();
  assert.equal(rpc.calls.filter(call => call.name === 'whatsapp_pairing').length, 0);
});

test('a Gmail refresh failure is one line per mailbox', async () => {
  const mailboxes = {
    'ada@example.com': { label: 'ada@example.com', icon: 'Mail', pollIntervalMs: 45_000 },
    'grace@example.com': { label: 'grace@example.com', icon: 'Mail', pollIntervalMs: 45_000 },
  };
  const rpc = fakeRpc({
    sources: () => mailboxes,
    sync: input => { throw new Error(`gmail ${input.account} request failed (401)`); },
  });
  const session = createInboxSession({ rpc, now: () => 0 });
  session.start();
  await settle();
  await session.refresh();
  const lines = session.snapshot().errors.filter(error => error.kind === 'refresh');
  assert.deepEqual(lines.map(error => error.account).sort(), ['ada@example.com', 'grace@example.com']);
  assert.equal(lines.length, 2);
  assert.ok(lines.every(error => error.message.includes('request failed (401)')));
});

test('a reply aimed at one message sends that id, and the next reply omits it', async () => {
  const target = row({ unread: false });
  const rpc = fakeRpc({
    cached: () => ({ items: [target] }),
    cached_open: () => ({ messages: [cachedMessage] }),
    open: () => ({ messages: [cachedMessage] }),
    action: () => ({ status: 'Sent' }),
    sync: () => ({ items: [] }),
  });
  const session = createInboxSession({ rpc, now: () => 10 });
  session.start();
  await settle();
  await session.open(target);

  session.aimReply('m1');
  assert.equal(session.snapshot().replyMessageId, 'm1');
  session.setDraft('ok');
  const aimed = rpc.calls.length;
  await session.submit();
  assert.deepEqual(rpc.calls[aimed].input, {
    account: 'whatsapp', id: 'chat-1', action: 'reply', text: 'ok', allow: 'send', messageId: 'm1',
  });
  assert.equal(session.snapshot().replyMessageId, '', 'a send that worked drops the aim');
  assert.equal(session.snapshot().text, '');

  session.setDraft('later');
  const again = rpc.calls.length;
  await session.submit();
  assert.deepEqual(rpc.calls[again].input, {
    account: 'whatsapp', id: 'chat-1', action: 'reply', text: 'later', allow: 'send',
  }, 'the next send is a conversation reply');
});

test('clearing the aim, or a source that cannot quote, sends a conversation reply', async () => {
  const target = row({ unread: false });
  const rpc = fakeRpc({
    cached: () => ({ items: [target] }),
    cached_open: () => ({ messages: [cachedMessage] }),
    open: () => ({ messages: [cachedMessage] }),
    action: () => ({ status: 'Sent' }),
    sync: () => ({ items: [] }),
  });
  const session = createInboxSession({ rpc, now: () => 10 });
  session.start();
  await settle();
  await session.open(target);
  session.aimReply('m1');
  session.clearReply();
  assert.equal(session.snapshot().replyMessageId, '');
  session.setDraft('ok');
  const cleared = rpc.calls.length;
  await session.submit();
  assert.deepEqual(rpc.calls[cleared].input, {
    account: 'whatsapp', id: 'chat-1', action: 'reply', text: 'ok', allow: 'send',
  });

  const quiet = fakeRpc({
    capabilities: () => declarations({ quoteReply: false }),
    cached: () => ({ items: [target] }),
    cached_open: () => ({ messages: [cachedMessage] }),
    open: () => ({ messages: [cachedMessage] }),
    action: () => ({ status: 'Sent' }),
    sync: () => ({ items: [] }),
  });
  const plain = createInboxSession({ rpc: quiet, now: () => 10 });
  plain.start();
  await settle();
  await plain.open(target);
  plain.aimReply('m1');
  assert.equal(plain.snapshot().replyMessageId, '', 'a source that cannot quote does not keep an aim');
  plain.setDraft('ok');
  const boundary = quiet.calls.length;
  await plain.submit();
  assert.deepEqual(quiet.calls[boundary].input, {
    account: 'whatsapp', id: 'chat-1', action: 'reply', text: 'ok', allow: 'send',
  });
});

test('a refused targeted reply keeps the draft and the aim, and is not sent again', async () => {
  const target = row({ unread: false });
  const refused = 'This source cannot reply to one message. Nothing was sent.';
  const rpc = fakeRpc({
    cached: () => ({ items: [target] }),
    cached_open: () => ({ messages: [cachedMessage] }),
    open: () => ({ messages: [cachedMessage] }),
    action: () => { throw new Error(refused); },
    sync: () => ({ items: [] }),
  });
  const session = createInboxSession({ rpc, now: () => 10 });
  session.start();
  await settle();
  await session.open(target);
  session.aimReply('m1');
  session.setDraft('ok');
  await session.submit();
  const replies = rpc.calls.filter(call => call.name === 'action' && (call.input as { action?: string }).action === 'reply');
  assert.equal(replies.length, 1, 'a refusal does not fire a second reply');
  assert.equal(session.snapshot().text, 'ok');
  assert.equal(session.snapshot().replyMessageId, 'm1');
  assert.equal(session.snapshot().status, refused);
});

test('a reaction is one action, and a refusal leaves the draft and is not sent again', async () => {
  const target = row({ unread: false });
  const refused = 'This source cannot react to one message. Nothing was sent.';
  let fail = false;
  const rpc = fakeRpc({
    cached: () => ({ items: [target] }),
    cached_open: () => ({ messages: [cachedMessage] }),
    open: () => ({ messages: [cachedMessage] }),
    action: (input: { action?: string }) => {
      if (input.action === 'react' && fail) throw new Error(refused);
      return { status: 'Sent' };
    },
    sync: () => ({ items: [] }),
  });
  const session = createInboxSession({ rpc, now: () => 10 });
  session.start();
  await settle();
  await session.open(target);
  session.setDraft('still here');

  await session.react('m1', '👍');
  assert.deepEqual(rpc.calls.filter(call => call.name === 'action').at(-1)?.input, {
    account: 'whatsapp', id: 'chat-1', action: 'react', messageId: 'm1', emoji: '👍', allow: 'send',
  });
  await session.react('m1', '❤️', true);
  assert.deepEqual(rpc.calls.filter(call => call.name === 'action').at(-1)?.input, {
    account: 'whatsapp', id: 'chat-1', action: 'react', messageId: 'm1', emoji: '❤️', allow: 'send', remove: true,
  });
  assert.equal(session.snapshot().text, 'still here', 'a reaction does not take the reply draft');

  fail = true;
  const before = rpc.calls.filter(call => call.name === 'action' && (call.input as { action?: string }).action === 'react').length;
  await session.react('m1', '👍');
  const after = rpc.calls.filter(call => call.name === 'action' && (call.input as { action?: string }).action === 'react').length;
  assert.equal(after - before, 1, 'a refused reaction is not sent again');
  assert.equal(session.snapshot().status, refused);
  assert.equal(session.snapshot().text, 'still here');

  const blocked = fakeRpc({
    capabilities: () => declarations({ react: false }),
    cached: () => ({ items: [target] }),
    cached_open: () => ({ messages: [] }),
    open: () => ({ messages: [] }),
  });
  const quiet = createInboxSession({ rpc: blocked, now: () => 0 });
  quiet.start();
  await settle();
  await quiet.open(target);
  const boundary = blocked.calls.length;
  await quiet.react('m1', '👍');
  assert.equal(blocked.calls.length, boundary, 'a source that cannot react is not asked');
});
