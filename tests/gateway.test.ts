// The gateway is one handler map built from plain deps, so a test can call one handler
// without a host API and without a browser. Every dependency here is a local stub: the
// only record of anything crossing a boundary is `calls`.
import assert from 'node:assert/strict';
import test from 'node:test';
import { NO_CAPABILITIES } from '../src/adapters/capability.ts';
import { REACTION_SET } from '../src/reaction-set.ts';
import { createSendGate, type AuditRow, type SendAuditStore } from '../src/adapters/policy.ts';
import { accounts } from '../src/adapters/types.ts';
import type { Account, Adapter, Conversation, ListResult } from '../src/adapters/types.ts';
import { createGateway, type GatewayDeps, type GatewayDriver } from '../src/gateway.ts';
import { unknownFreshness, type SourceFreshness } from '../src/inbox-refresh.ts';
import { rpcContract } from '../src/rpc-contract.ts';


const NOW = 1_700_000_000_000;
const FIRST: Conversation = { account: 'gmail-personal', id: 't1', title: 'Dinner', preview: 'See you at six', date: NOW, unread: true };
const SECOND: Conversation = { ...FIRST, id: 't0', preview: 'Older mail', date: NOW - 86_400_000, unread: false };

/** The first page a source answers, and the page its cursor walks to. */
type Pages = { newest: { items: Conversation[]; cursor?: string }; older: { items: Conversation[]; cursor?: string } };

interface FixtureOptions {
  pages?: Pages;
  /** What the driver answers for one click. */
  click?: { clicked: boolean; reason?: string; recipients?: string[] };
  /** One source whose `list` rejects, for the isolation case. */
  fail?: Account;
  /** One source whose `sync` rejects with a sentence it already phrased, for the message-fidelity case. */
  syncFailure?: { account: string; message: string };
  extraAccounts?: string[];
  /** What the pairing module answers; the gateway only forwards, so a recorder is enough. */
  pairing?: GatewayDeps['pairing'];
  gmail?: GatewayDeps['gmail'];
  /** What the index ranks for a query, and the rows only it holds. */
  ranked?: { id: string; score: number }[];
  indexRows?: Conversation[];
  attentionOf?: GatewayDeps['attentionOf'];
  /** The classification unmute schedules. The response itself is not a push. */
  classifyUnmuted?: GatewayDeps['classifyUnmuted'];
}

/** The names the real adapters declare; a fake states them here rather than reading them out of the registry. */
const LABEL: Record<Account, string> = { 'gmail-personal': 'Personal Gmail', 'gmail-business': 'Inhouse Gmail', whatsapp: 'WhatsApp', imessage: 'Messages', linkedin: 'LinkedIn' };

function adapter(name: Account, overrides: Partial<Adapter>): Adapter {
  return {
    source: { label: LABEL[name] ?? name, icon: 'MessageCircle', pollIntervalMs: 1_000 },
    capabilities: () => NO_CAPABILITIES,
    list: async () => ({ items: [], errors: [] }),
    sync: async () => ({ items: [], updatedAt: NOW }),
    open: async () => ({ messages: [] }),
    media: async () => ({ dataUrl: '', mime: '' }),
    action: async () => ({ status: 'ok' }),
    ...overrides,
  };
}

function fixture(options: FixtureOptions = {}) {
  const calls: string[] = [];
  const auditRows: AuditRow[] = [];
  const cacheRows: Conversation[] = [];
  // The real gate over an in-memory store: the ordering the task cares about is the
  // gate's, so a fake that wrote the row itself would prove nothing.
  const store: SendAuditStore = {
    record(row) { calls.push('audit:record'); auditRows.push(row); },
    hasSpent() { return false; },
  };
  const freshness = new Map<Account, SourceFreshness>();
  const muted = new Set<string>();
  const cache: GatewayDeps['cache'] = {
    freshness: account => freshness.get(account) ?? unknownFreshness(),
    saveFreshness: (account, state) => { freshness.set(account, state); },
    threadUpdatedAt: () => null,
    list: () => cacheRows,
    readThread: () => null,
    clear: () => { calls.push('clear'); cacheRows.length = 0; },
    forget: account => { calls.push(`forget:${account}`); const index = cacheRows.findIndex(row => row.account === account); if (index >= 0) cacheRows.splice(index, 1); },
    setSentSnippet: () => {},
    mute: (account, id) => { muted.add(`${account}\0${id}`); },
    unmute: (account, id) => { muted.delete(`${account}\0${id}`); },
    muted: (account, id) => muted.has(`${account}\0${id}`),
  };
  const search: GatewayDeps['search'] = {
    search: async () => options.ranked ?? [],
    status: () => ({ size: 0, updatedAt: null, ready: true }),
    warm: async () => {},
    row: (account, id) => options.indexRows?.find(row => row.account === account && row.id === id),
  };
  const driver: GatewayDriver = {
    openInLinkedInProfile: async () => {},
    inspectLinkedInPage: async () => [],
    evaluateInLinkedInProfile: async () => undefined,
    pressKeyInLinkedInPage: async () => {},
    readSendTarget: async () => {
      calls.push('driver:readSendTarget');
      return { recipients: ['Ada Lovelace'], threadKey: '' };
    },
    clickNamedControl: async () => {
      calls.push('driver:clickNamedControl');
      return options.click ?? { clicked: true, recipients: ['Ada Lovelace'] };
    },
    typeIntoNamedControl: async () => ({ typed: true }),
    openLinkedInSignIn: async () => '/tmp/inbox-profile',
  };
  const personal: Partial<Adapter> = {
    // A cache-only decoration, the shape WhatsApp's group participants use.
    decorate: row => ({ ...row, participants: ['Ada Lovelace'] }),
    async list(cursor): Promise<ListResult> {
      calls.push(`gmail-personal:list:${cursor ?? 'newest'}`);
      if (!options.pages) return { items: [], errors: [] };
      const page = cursor === undefined ? options.pages.newest : options.pages.older;
      return { ...page, errors: [] };
    },
    async sync() {
      calls.push('gmail-personal:sync');
      // A refresh hands over a cursor. It must not move the walk the owner started.
      return { items: options.pages?.older.items ?? [], updatedAt: NOW, cursor: 'page-99' };
    },
    async send() {
      calls.push('gmail-personal:send');
      return { status: 'sent' };
    },
  };
  const registry = Object.fromEntries([...accounts, ...(options.extraAccounts ?? [])].map(name => [name, adapter(name, {
    ...(name === 'gmail-personal' ? personal : {}),
    ...(name === options.fail
      ? { list: async (): Promise<never> => { calls.push(`${name}:list`); throw new Error('provider exploded'); } }
      : {}),
    ...(name === options.syncFailure?.account
      ? { sync: async (): Promise<never> => { calls.push(`${name}:sync`); throw new Error(options.syncFailure!.message); } }
      : {}),
  })])) as Record<Account, Adapter>;
  const notes: string[] = [];
  const gateway = createGateway({
    cache,
    search,
    audit: { list: (limit = 20) => auditRows.slice(-limit).reverse() },
    gate: createSendGate({ now: () => NOW, store }),
    registry,
    now: () => NOW,
    driver,
    // No socket in this file: an unpaired source is the honest default, and the pairing module has
    // its own tests over a real connection.
    pairing: options.pairing ?? (async () => ({ state: 'unpaired' })),
    note: (level, line) => notes.push(`${level} ${line}`),
    gmail: options.gmail,
    attentionOf: options.attentionOf,
    classifyUnmuted: options.classifyUnmuted,
  });
  return { gateway, calls, auditRows, cacheRows, registry, notes, muted };
}

test('the panel receives each source\'s declaration, and the contract accepts it', async () => {
  const f = fixture();
  const declared = await f.gateway.sources(null);
  assert.deepEqual(Object.keys(declared).sort(), [...accounts].sort(), 'every source answers');
  assert.deepEqual(declared, Object.fromEntries(accounts.map(name => [name, f.registry[name].source])), 'with what its own adapter declared');
  assert.equal(rpcContract.sources.output.safeParse(declared).success, true, 'and the wire carries exactly that');
});

test('a call with nothing to say answers the same for null, empty and missing', async () => {
  const f = fixture();
  // Both call shapes reach the handler now, so both must read the same defaults rather than throw
  // on a null it destructured or on an object it never expected.
  assert.deepEqual(await f.gateway.capabilities(null), await f.gateway.capabilities({}), 'capabilities reads both shapes alike');
  assert.deepEqual(await f.gateway.send_audit(null), { rows: [] }, 'the audit answers its default page for a null call');
  assert.deepEqual(await f.gateway.send_audit({}), { rows: [] }, 'and for an empty one');
});

test('a search answers with the row it matched, whether the cache holds it or only the index does', async () => {
  const listed: Conversation = { account: 'whatsapp', id: 'chat-1', title: 'Ada', preview: 'see you', date: NOW, unread: true };
  const hidden: Conversation = { account: 'whatsapp', id: 'chat-99', title: 'Grace Hopper', preview: 'the lighthouse keeper', date: NOW - 86_400_000, unread: false };
  const f = fixture({
    ranked: [{ id: 'whatsapp\u0000chat-99', score: 4 }, { id: 'whatsapp\u0000chat-1', score: 2 }],
    indexRows: [hidden],
  });
  f.cacheRows.push(listed);

  const answer = await f.gateway.search({ query: 'lighthouse' });
  assert.deepEqual(answer.ids.map(row => [row.account, row.id]), [['whatsapp', 'chat-99'], ['whatsapp', 'chat-1']], 'the ranking keeps its shape');
  assert.deepEqual(answer.items.map(row => [row.id, row.title]), [['chat-99', 'Grace Hopper'], ['chat-1', 'Ada']], 'and every id comes with the row to draw it');
  assert.equal(rpcContract.search.output.safeParse(answer).success, true, 'the wire carries both');
});

test('unmute of a cached conversation asks the watcher and does not push by itself', async () => {
  const watched: string[] = [];
  const row: Conversation = { account: 'whatsapp', id: 'chat', title: 'Ada', preview: 'new line', date: NOW, unread: false, needsAttention: 'yes' };
  const f = fixture({
    attentionOf: () => 'yes',
    classifyUnmuted: (account, id) => watched.push(`${account}:${id}`),
    ranked: [{ id: 'whatsapp\u0000chat', score: 2 }],
  });
  f.cacheRows.push(row);
  f.muted.add('whatsapp\0chat');

  const listed = await f.gateway.cached(null);
  assert.equal(listed.items[0].muted, true, 'the list carries the mute mark');
  assert.equal(listed.items[0].needsAttention, 'yes', 'the stored decision stays on the row');
  const found = await f.gateway.search({ query: 'line' });
  assert.equal(found.items[0].muted, true, 'a search hit carries the same mark');
  assert.equal(found.items[0].needsAttention, 'yes');

  const answer = await f.gateway.unmute({ account: 'whatsapp', id: 'chat' });
  assert.deepEqual(answer, { muted: false }, 'the unmute response itself does not push');
  assert.deepEqual(watched, ['whatsapp:chat'], 'unmute schedules one classification');
  const after = await f.gateway.cached(null);
  assert.equal(after.items[0].id, 'chat', 'the row stays in the list');
  assert.equal(after.items[0].muted, undefined);
  assert.equal(after.items[0].needsAttention, 'yes');

  watched.length = 0;
  const absent = await f.gateway.unmute({ account: 'gmail-personal', id: 'missing' });
  assert.deepEqual(absent, { muted: false });
  assert.deepEqual(watched, [], 'a conversation that is not in the cache is not asked');
});

test('an older page asks the source for the number of rows that source declares', async () => {
  const f = fixture();
  const asked: (number | undefined)[] = [];
  // The page size is a number the adapter owns; the gateway stops keeping its own table.
  f.registry['gmail-personal'] = {
    ...f.registry['gmail-personal'],
    source: { ...f.registry['gmail-personal'].source, pageSize: 7 },
    list: async (cursor, opts) => {
      asked.push(opts?.limit);
      return cursor ? { items: [], errors: [] } : { items: [], errors: [], cursor: 'page-2' };
    },
  };
  await f.gateway.list({ account: 'gmail-personal' });
  await f.gateway.list({ older: true, account: 'gmail-personal' });
  assert.deepEqual(asked, [undefined, 7], 'the newest page is asked for no limit; the older page for the declared seven');
});

test('list decorates rows and reports more from the cursor; a refresh does not advance it', async () => {
  const f = fixture({ pages: { newest: { items: [FIRST], cursor: 'page-2' }, older: { items: [SECOND] } } });

  const first = await f.gateway.list({ account: 'gmail-personal' });
  assert.deepEqual(first.items.map(row => row.id), [FIRST.id]);
  assert.deepEqual(first.items[0].participants, ['Ada Lovelace'], 'the adapter decoration reaches the caller');
  assert.equal(first.more, true, 'the source says an older page exists');

  // `older: false` and an absent `older` both read the newest page again, and neither
  // replaces the cursor the first read seeded.
  f.calls.length = 0;
  const refreshed = await f.gateway.list({ older: false, account: 'gmail-personal' });
  const absent = await f.gateway.list({ account: 'gmail-personal' });
  assert.deepEqual(f.calls, ['gmail-personal:list:newest', 'gmail-personal:list:newest']);
  assert.equal(refreshed.more, true);
  assert.equal(absent.more, true, 'the walk is still parked on page two');

  f.calls.length = 0;
  const older = await f.gateway.list({ older: true, account: 'gmail-personal' });
  assert.deepEqual(f.calls, ['gmail-personal:list:page-2'], 'an older read asks for the page after the newest one');
  assert.deepEqual(older.items.map(row => row.id), [SECOND.id]);
  assert.equal(older.more, false, 'the source answered with no next cursor');

  f.calls.length = 0;
  assert.equal((await f.gateway.list({ older: true, account: 'gmail-personal' })).more, false);
  assert.deepEqual(f.calls, [], 'a source that said "nothing older" is not asked again');
});

test('only older advances the walk: a refresh that hands over a cursor leaves it alone', async () => {
  const f = fixture({ pages: { newest: { items: [FIRST], cursor: 'page-2' }, older: { items: [SECOND] } } });

  await f.gateway.list({ account: 'gmail-personal' });
  f.calls.length = 0;
  const synced = await f.gateway.sync({ account: 'gmail-personal' });
  assert.deepEqual(f.calls, ['gmail-personal:sync']);
  assert.equal(synced.more, true, 'the 45-second refresh answers for the walk already in progress');

  f.calls.length = 0;
  await f.gateway.list({ older: true, account: 'gmail-personal' });
  assert.deepEqual(f.calls, ['gmail-personal:list:page-2'], "the refresh's cursor did not restart the owner's walk");
});

test('send_gmail without allow: send refuses and the adapter is never reached', async () => {
  const f = fixture();

  await assert.rejects(
    async () => f.gateway.send_gmail({ account: 'gmail-personal', to: 'ada@example.com', subject: 'Dinner', text: 'On my way' }),
    /needs an approval/,
  );
  assert.deepEqual(f.calls, ['audit:record'], 'the gate wrote the refusal, and the adapter was never called');
  assert.equal(f.auditRows.length, 1);
  assert.equal(f.auditRows[0].decision, 'refused');
  assert.equal(f.auditRows[0].conversationId, 'ada@example.com');
});

test('a sending click writes its audit row before the driver clicks', async () => {
  const f = fixture();

  const answered = await f.gateway.linkedin_ui({ op: 'click', control: 'Send', allow: 'send', recipient: 'Ada Lovelace' });
  assert.deepEqual(answered, { clicked: true, recipients: ['Ada Lovelace'] });
  assert.deepEqual(f.calls, ['driver:readSendTarget', 'audit:record', 'driver:clickNamedControl']);
  assert.equal(f.auditRows.length, 1);
  assert.equal(f.auditRows[0].decision, 'allowed');
  assert.equal(f.auditRows[0].conversationId, 'Ada Lovelace', 'the row names the target the page confirmed');
  assert.equal(f.auditRows[0].approvalId, undefined, 'delivered, never approved');
});

test('a driver that refuses the click writes no row', async () => {
  const f = fixture({ click: { clicked: false, reason: 'LinkedIn shows no control named "Send".' } });

  // No `allow: 'send'`: the click delivers nothing, so the gateway has no row to write and
  // the driver refuses the click itself.
  const answered = await f.gateway.linkedin_ui({ op: 'click', control: 'Send' });
  assert.deepEqual(answered, { clicked: false, reason: 'LinkedIn shows no control named "Send".' });
  assert.deepEqual(f.calls, ['driver:clickNamedControl'], 'no page read and no audit row');
  assert.deepEqual(f.auditRows, []);
});

test('a LinkedIn browser miss keeps the older cursor so the next press retries that page', async () => {
  const f = fixture();
  const asked: (string | undefined)[] = [];
  const row: Conversation = { account: 'linkedin', id: 'c1', title: 'Ada', preview: '', date: NOW, unread: false };
  const older: Conversation = { ...row, id: 'c0', date: NOW - 1000 };
  let olderCalls = 0;
  f.registry.linkedin.list = async cursor => {
    asked.push(cursor);
    if (cursor === undefined) return { items: [row], errors: [], cursor: 'start' };
    olderCalls += 1;
    if (olderCalls === 1) return { items: [older], errors: [], cursor: 'page-3' };
    if (olderCalls === 2) throw new Error('The LinkedIn browser did not answer Runtime.evaluate.');
    return { items: [{ ...older, id: 'c-1' }], errors: [], cursor: 'page-4' };
  };

  await f.gateway.list({ account: 'linkedin' });
  await f.gateway.list({ older: true, account: 'linkedin' });
  const missed = await f.gateway.list({ older: true, account: 'linkedin' });
  assert.equal(missed.more, true, 'the walk still has a page to read');
  assert.match(missed.errors[0], /unavailable/);
  await f.gateway.sync({ account: 'linkedin' });
  const retried = await f.gateway.list({ older: true, account: 'linkedin' });
  assert.deepEqual(asked, [undefined, 'start', 'page-3', 'page-3'], 'the refresh does not send the walk back to the start');
  assert.equal(retried.items[0].id, 'c-1');
});

test('a LinkedIn older page the source rejects forgets its cursor', async () => {
  const f = fixture();
  const asked: (string | undefined)[] = [];
  const row: Conversation = { account: 'linkedin', id: 'c1', title: 'Ada', preview: '', date: NOW, unread: false };
  let olderCalls = 0;
  f.registry.linkedin.list = async cursor => {
    asked.push(cursor);
    if (cursor === undefined) return { items: [row], errors: [], cursor: 'start' };
    olderCalls += 1;
    if (olderCalls === 1) return { items: [{ ...row, id: 'c0' }], errors: [], cursor: 'page-3' };
    throw new Error('LinkedIn did not return a usable response.');
  };

  await f.gateway.list({ account: 'linkedin' });
  await f.gateway.list({ older: true, account: 'linkedin' });
  const rejected = await f.gateway.list({ older: true, account: 'linkedin' });
  assert.equal(rejected.more, false);
  const again = await f.gateway.list({ older: true, account: 'linkedin' });
  assert.equal(again.more, false);
  assert.deepEqual(asked, [undefined, 'start', 'page-3'], 'a rejected page is not asked again');
});

test('one failing source becomes one line and the rest still list', async () => {
  const f = fixture({ pages: { newest: { items: [FIRST], cursor: 'page-2' }, older: { items: [SECOND] } }, fail: 'whatsapp' });

  const listed = await f.gateway.list(null);
  assert.deepEqual(listed.items.map(row => row.id), [FIRST.id]);
  assert.deepEqual(listed.errors, ['WhatsApp unavailable. Check its connection.']);
  assert.equal(listed.more, true);
  // The row says what the owner can do; the log says what happened. Without the second, "LinkedIn
  // unavailable" once cost an afternoon while an orphaned browser held the profile.
  assert.deepEqual(f.notes, ['warn WhatsApp failed: provider exploded']);
});

test('a source failure that already names itself keeps its own words', async () => {
  // The provider-error factory writes `<source> <account> request failed (<code>)`, and a Gmail
  // account key is `gmail-personal` / `gmail-business`. A token that could not span the hyphen made
  // every Gmail failure read "Inhouse Gmail unavailable. Check its connection." instead.
  const message = 'gmail gmail-business request failed (ETIMEDOUT; timeout): Command failed: /usr/local/bin/gws gmail users threads list';
  const f = fixture({ syncFailure: { account: 'gmail-business', message } });

  await assert.rejects(
    async () => { await f.gateway.sync({ account: 'gmail-business', limit: 10 }); },
    (error: unknown) => error instanceof Error && error.message === message,
  );
  const fresh = await f.gateway.freshness(null);
  assert.equal(fresh['gmail-business'].lastError, message, 'the stored line is the reason, not a generic sentence');
  assert.equal(fresh['gmail-business'].lastSuccessAt, null, 'a failure never advances success');
});

test('an email-shaped provider failure keeps its own words', async () => {
  const message = 'gmail ada@example.com request failed (401; invalid, token)';
  const f = fixture({ extraAccounts: ['ada@example.com'], syncFailure: { account: 'ada@example.com', message } });
  await assert.rejects(
    async () => { await f.gateway.sync({ account: 'ada@example.com', limit: 10 }); },
    (error: unknown) => error instanceof Error && error.message === message,
  );
  const fresh = await f.gateway.freshness(null);
  assert.equal(fresh['ada@example.com'].lastError, message);
  await assert.rejects(async () => { await f.gateway.send_gmail({ account: 'nobody@example.com', to: 'a@example.com', subject: 'Hi', text: 'Hello' }); }, /not connected/);
});

test('the pairing handler forwards one call and nothing about the socket', async () => {
  const asked: unknown[] = [];
  const f = fixture({
    pairing: async (request) => {
      asked.push(request);
      return request.op === 'pair' ? { state: 'connecting' } : { state: 'unpaired' };
    },
  });

  // A read is the same call with nothing in it: the panel polls the card while a code is on screen.
  assert.deepEqual(await f.gateway.whatsapp_pairing(null), { state: 'unpaired' });
  assert.deepEqual(asked, [{}], 'a null call is the read, and the module is told so');
  assert.deepEqual(await f.gateway.whatsapp_pairing({ op: 'pair' }), { state: 'connecting' });
  assert.deepEqual(asked.at(-1), { op: 'pair' }, 'an act crosses the boundary unchanged');
  assert.equal(rpcContract.whatsapp_pairing.output.safeParse(await f.gateway.whatsapp_pairing(null)).success, true);
});

const LIKE = REACTION_SET.find(item => item.label === 'like')!.emoji;

/** The adapter's action is the deliver function. A before-gate refusal must not call it. */
function watchDeliver(f: ReturnType<typeof fixture>, account: Account) {
  let delivered = 0;
  f.registry[account].action = async () => {
    delivered += 1;
    f.calls.push('deliver');
    return { status: 'Sent.' };
  };
  return () => delivered;
}

test('a conversation reply with no message id still reaches the adapter after the gate', async () => {
  const f = fixture();
  const delivered = watchDeliver(f, 'whatsapp');
  const answered = await f.gateway.action({ account: 'whatsapp', id: 'c', action: 'reply', text: 'hi', allow: 'send' });
  assert.deepEqual(answered, { status: 'Sent.' });
  assert.equal(delivered(), 1);
  assert.deepEqual(f.calls, ['audit:record', 'deliver'], 'the allowed row is written before delivery');
  assert.equal(f.auditRows[0].decision, 'allowed');
});

test('a Gmail react does not call the adapter and writes no allowed row', async () => {
  const f = fixture();
  const delivered = watchDeliver(f, 'gmail-personal');
  await assert.rejects(
    async () => f.gateway.action({ account: 'gmail-personal', id: 't1', action: 'react', messageId: 'm1', emoji: LIKE, allow: 'send' }),
    /cannot react to one message/,
  );
  assert.equal(delivered(), 0);
  assert.deepEqual(f.auditRows, []);
});

test('a WhatsApp react is refused while the flag is false, and deliver is not called', async () => {
  const f = fixture();
  const delivered = watchDeliver(f, 'whatsapp');
  await assert.rejects(
    async () => f.gateway.action({ account: 'whatsapp', id: 'c', action: 'react', messageId: 'm1', emoji: LIKE, allow: 'send' }),
    /cannot react to one message/,
  );
  assert.equal(delivered(), 0, 'the fake deliver function is not called');
  assert.deepEqual(f.auditRows.filter(row => row.decision === 'allowed'), []);
});

test('a targeted reply, a bad emoji, a missing message id, and a removal are refused before the gate', async () => {
  const f = fixture();
  const delivered = watchDeliver(f, 'whatsapp');
  await assert.rejects(
    async () => f.gateway.action({ account: 'whatsapp', id: 'c', action: 'reply', text: 'hi', messageId: 'm1', allow: 'send' }),
    /cannot reply to one message/,
  );
  f.registry.whatsapp.capabilities = () => ({ ...NO_CAPABILITIES, react: true });
  await assert.rejects(
    async () => f.gateway.action({ account: 'whatsapp', id: 'c', action: 'react', messageId: 'm1', emoji: '‼️', allow: 'send' }),
    /not one of the four/,
  );
  await assert.rejects(
    async () => f.gateway.action({ account: 'whatsapp', id: 'c', action: 'react', messageId: 'm1', emoji: '❓', allow: 'send' }),
    /not one of the four/,
  );
  await assert.rejects(
    async () => f.gateway.action({ account: 'whatsapp', id: 'c', action: 'react', emoji: LIKE, allow: 'send' }),
    /needs the message/,
  );
  await assert.rejects(
    async () => f.gateway.action({ account: 'whatsapp', id: 'c', action: 'react', messageId: 'm1', emoji: LIKE, remove: true, allow: 'send' }),
    /cannot remove a reaction/,
  );
  assert.equal(delivered(), 0);
  assert.deepEqual(f.auditRows.filter(row => row.decision === 'allowed'), []);
});

test('connection status is a read, and remove drops one account cache without clearing every source', async () => {
  const seen: unknown[] = [];
  let ensured = 0;
  let cancelled = 0;
  const f = fixture({
    pairing: async request => {
      seen.push(request);
      if (request.op) ensured += 1;
      return { state: 'unpaired' };
    },
    gmail: {
      clientConfigured: async () => true,
      mailboxes: async () => [{ account: 'ada@example.com', present: true, hasRefreshToken: true, source: 'login', refresh_token: '1//secret-refresh' } as never],
      connect: async input => ({ account: 'ada@example.com', replaced: input.replace, alreadyConnected: false }),
      cancel: () => { cancelled += 1; },
      remove: async () => {},
    },
  });
  const status = await f.gateway.connection_status(null);
  assert.equal(status.clientConfigured, true);
  assert.equal(status.mailboxes[0]?.account, 'ada@example.com');
  assert.equal(status.whatsapp.state, 'unpaired');
  assert.deepEqual(seen, [{}]);
  assert.equal(ensured, 0);
  assert.equal(JSON.stringify(status).includes('1//secret-refresh'), false);
  assert.equal(JSON.stringify(status).includes('secret'), false);
  assert.equal(rpcContract.connection_status.output.safeParse(status).success, true);
  assert.equal(status.messages.includes('Full Disk Access'), true);

  f.cacheRows.push({ account: 'ada@example.com', id: 't1', title: 'Hi', preview: '', date: NOW, unread: false });
  f.cacheRows.push({ account: 'whatsapp', id: 'c1', title: 'Chat', preview: '', date: NOW, unread: false });
  const added = await f.gateway.gmail_connect({});
  assert.deepEqual(added, { account: 'ada@example.com', replaced: false, alreadyConnected: false });
  assert.deepEqual(await f.gateway.gmail_remove({ account: 'ada@example.com' }), { removed: true });
  assert.equal(f.calls.includes('forget:ada@example.com'), true);
  assert.equal(f.calls.includes('clear'), false);
  assert.equal(f.cacheRows.some(row => row.account === 'ada@example.com'), false);
  assert.equal(f.cacheRows.some(row => row.account === 'whatsapp'), true);
  assert.deepEqual(await f.gateway.gmail_connect_cancel(null), { cancelled: true });
  assert.deepEqual(await f.gateway.gmail_connect_cancel({}), { cancelled: true });
  assert.equal(cancelled, 2);
});

test('a vote on a source that cannot vote writes no audit row', async () => {
  const f = fixture();
  const delivered = watchDeliver(f, 'gmail-personal');
  await assert.rejects(
    async () => f.gateway.action({ account: 'gmail-personal', id: 't1', action: 'vote', messageId: 'm1', options: ['Yes'], allow: 'send' }),
    /cannot vote in a poll/,
  );
  assert.equal(delivered(), 0);
  assert.deepEqual(f.auditRows, []);
});

test('a vote for an option that is not on the poll writes no audit row', async () => {
  const f = fixture();
  f.registry.whatsapp.capabilities = () => ({ ...NO_CAPABILITIES, pollVote: true });
  f.registry.whatsapp.pollOf = () => ({ options: ['Yes', 'No'], selectableCount: 1 });
  const delivered = watchDeliver(f, 'whatsapp');
  await assert.rejects(
    async () => f.gateway.action({ account: 'whatsapp', id: 'c', action: 'vote', messageId: 'm1', options: ['Maybe'], allow: 'send' }),
    /not on this poll/,
  );
  assert.equal(delivered(), 0);
  assert.deepEqual(f.auditRows, []);
});

test('a vote records the chosen names and then asks the adapter once', async () => {
  const f = fixture();
  f.registry.whatsapp.capabilities = () => ({ ...NO_CAPABILITIES, pollVote: true });
  f.registry.whatsapp.pollOf = () => ({ options: ['Yes', 'No'], selectableCount: 1 });
  const seen: Array<{ messageId?: string; options?: string[] } | undefined> = [];
  f.registry.whatsapp.action = async (_kind, _id, opts) => {
    seen.push(opts);
    return { status: 'Sent.' };
  };
  const answered = await f.gateway.action({ account: 'whatsapp', id: 'c', action: 'vote', messageId: 'm1', options: ['Yes'], allow: 'send' });
  assert.deepEqual(answered, { status: 'Sent.' });
  assert.deepEqual(seen, [{ messageId: 'm1', options: ['Yes'] }]);
  assert.equal(f.auditRows[0]?.decision, 'allowed');
});
