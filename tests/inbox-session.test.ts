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
  if (name === 'sync') return { items: [], updatedAt: 0 };
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
    .filter(call => call.name === 'sync')
    .map(call => (call.input as { account: Account }).account)
    .sort();
  assert.deepEqual(refreshed, ['business', 'imessage', 'personal', 'whatsapp']);
  assert.ok(seen.length > 0, 'both subscribers were told');

  const notifications = seen.length;
  session.tick(at);
  assert.equal(rpc.calls.filter(call => call.name === 'sync').length, 4, 'a second tick at the same instant fires nothing');
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
    ['action', 'open', 'sync', 'send_audit'],
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
  const target = row({ account: 'personal', id: 't1', title: 'Plan' });
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

  session.startMail('replyAll', 'personal');
  assert.deepEqual(
    { to: session.snapshot().mail?.to, cc: session.snapshot().mail?.cc, bcc: session.snapshot().mail?.bcc },
    { to: 'ada@example.com', cc: 'bo@example.com', bcc: '' },
    'reply all fills what the thread knows; a blind copy is the owner’s to add',
  );

  session.startMail('reply', 'personal');
  assert.equal(session.snapshot().mail?.cc, '', 'a plain reply does not copy anyone');
  assert.equal(session.snapshot().mail?.bcc, '', 'and still starts with no blind copy');
});

test('a blind copy the owner types reaches send_gmail with the rest of the draft', async () => {
  const target = row({ account: 'personal', id: 't1', title: 'Plan' });
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
  session.startMail('reply', 'personal');
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

const bytes = (size: number) => Buffer.alloc(size, 'a').toString('base64');

test('a draft takes attachments, refuses one that would make it too big, and can drop them again', async () => {
  const rpc = fakeRpc({ cached: () => ({ items: [] }), sync: () => ({ items: [] }) });
  const session = createInboxSession({ rpc, now: () => 0 });
  session.start();
  await settle();
  session.startMail('new', 'personal');

  assert.equal(session.attach({ name: 'plan.pdf', mimeType: 'application/pdf', size: 3, data: bytes(3) }), true, 'a small file is taken');
  assert.deepEqual(session.snapshot().mail?.attachments.map(a => a.name), ['plan.pdf']);

  assert.equal(session.attach({ name: 'huge.zip', mimeType: 'application/zip', size: 11 * 1024 * 1024, data: bytes(11 * 1024 * 1024) }), false, 'a draft that would be too big is refused');
  assert.deepEqual(session.snapshot().mail?.attachments.map(a => a.name), ['plan.pdf'], 'the refused file is not added');
  assert.match(session.snapshot().mailStatus, /too large/i, 'and the composer is told why');

  session.detach(0);
  assert.deepEqual(session.snapshot().mail?.attachments, [], 'an attachment can be taken back off the draft');
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
  session.startMail('new', 'personal');
  session.setMail({ to: 'a@example.com', subject: 'The plan' });
  session.attach({ name: 'plan.pdf', mimeType: 'application/pdf', size: 3, data: bytes(3) });
  await session.sendMail();

  const sent = rpc.calls.filter(call => call.name === 'send_gmail').at(-1)!;
  assert.deepEqual((sent.input as any).attachments, [{ name: 'plan.pdf', mimeType: 'application/pdf', size: 3, data: bytes(3) }], 'the file is sent exactly as it was attached');
  assert.equal(session.snapshot().mail, null);
});
