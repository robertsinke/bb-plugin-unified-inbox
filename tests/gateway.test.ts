// The gateway is one handler map built from plain deps, so a test can call one handler
// without a host API and without a browser. Every dependency here is a local stub: the
// only record of anything crossing a boundary is `calls`.
import assert from 'node:assert/strict';
import test from 'node:test';
import { NO_CAPABILITIES } from '../src/adapters/capability.ts';
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
}

/** The names the real adapters declare; a fake states them here rather than reading them out of the registry. */
const LABEL: Record<Account, string> = { 'gmail-personal': 'Personal Gmail', 'gmail-business': 'Inhouse Gmail', whatsapp: 'WhatsApp', imessage: 'Messages', linkedin: 'LinkedIn' };

function adapter(name: Account, overrides: Partial<Adapter>): Adapter {
  return {
    source: { label: LABEL[name], icon: 'MessageCircle', pollIntervalMs: 1_000 },
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
  const cache: GatewayDeps['cache'] = {
    freshness: account => freshness.get(account) ?? unknownFreshness(),
    saveFreshness: (account, state) => { freshness.set(account, state); },
    threadUpdatedAt: () => null,
    list: () => cacheRows,
    readThread: () => null,
    clear: () => { cacheRows.length = 0; },
  };
  const search: GatewayDeps['search'] = {
    search: () => [],
    status: () => ({ size: 0, updatedAt: null, ready: true }),
    warm() {},
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
  const registry = Object.fromEntries(accounts.map(name => [name, adapter(name, {
    ...(name === 'gmail-personal' ? personal : {}),
    ...(name === options.fail
      ? { list: async (): Promise<never> => { calls.push(`${name}:list`); throw new Error('provider exploded'); } }
      : {}),
  })])) as Record<Account, Adapter>;
  const gateway = createGateway({
    cache,
    search,
    audit: { list: (limit = 20) => auditRows.slice(-limit).reverse() },
    gate: createSendGate({ now: () => NOW, store }),
    registry,
    now: () => NOW,
    driver,
  });
  return { gateway, calls, auditRows, cacheRows, registry };
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

test('one failing source becomes one line and the rest still list', async () => {
  const f = fixture({ pages: { newest: { items: [FIRST], cursor: 'page-2' }, older: { items: [SECOND] } }, fail: 'whatsapp' });

  const listed = await f.gateway.list(null);
  assert.deepEqual(listed.items.map(row => row.id), [FIRST.id]);
  assert.deepEqual(listed.errors, ['WhatsApp unavailable. Check its connection.']);
  assert.equal(listed.more, true);
});
