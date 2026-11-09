// The gateway: every RPC handler in one map, built from a plain bag of functions and
// modules. The host API is the caller's business (server.ts) and the page driver is
// the adapter production wires in (linkedin-chrome.ts); a test wires fakes and calls
// a handler directly. Nothing here touches a browser, a provider client or a host API,
// and nothing runs at import time.
import type { PluginRpcHandlers } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import type { AttentionVerdict } from './attention.ts';
import type { InboxCache } from './adapters/deps.ts';
import { registryCapabilities, registrySources } from './adapters/index.ts';
import { approvalFor, type SendGate } from './adapters/policy.ts';
import type { Account, Adapter, Conversation } from './adapters/types.ts';
import { conversationKeyOf, describeControlExpression, pageTextExpression, sendClickRecord } from './linkedin-ui.ts';
import type { PageControl, SendApproval, SendTarget } from './linkedin-ui.ts';
import { isMessageSend } from './linkedin-write.ts';
import { createInboxRefresh } from './inbox-refresh.ts';
import { isReactionEmoji } from './reaction-set.ts';
import { message, rpcContract } from './rpc-contract.ts';
import type { WhatsAppPairingRequest, WhatsAppPairingSnapshot } from './rpc-contract.ts';
import type { createSearchIndex } from './search-index.ts';
import type { createSendAudit } from './send-audit.ts';
import type { GmailCredentialState } from './gmail-oauth.ts';
import type { GmailLoginResult } from './gmail-login.ts';

/**
 * Failure text a source already phrased for a person, or one the provider-error factory scrubbed.
 * The account token is `\S+`, not `\w+`: a Gmail account key is `gmail-personal`, and a hyphen is
 * not a word character — matching on `\w+` silently replaced every Gmail failure with the
 * fallback below, which named the source but never the failure.
 */
const DESCRIBED_FAILURE = /^(?:LinkedIn |(?:gmail|whatsapp|imsg|linkedin) \S+ request failed \()/;

/**
 * One failed source never hides the others: it becomes one line in `list`'s `errors`. The fallback
 * names the source the way the source declares itself, so there is no second spelling to drift.
 */
/**
 * The browser did not answer. That is not a cursor LinkedIn rejected. Forgetting the cursor lets
 * the next refresh start the walk again, and the panel then hears that the page it already shows
 * had nothing new.
 */
function linkedInBrowserMissed(cause: unknown): boolean {
  const message = cause instanceof Error ? cause.message : '';
  return /LinkedIn browser did not answer|Could not connect to the LinkedIn browser|LinkedIn did not answer in time|LinkedIn could not reach the network|LinkedIn is unavailable in its browser/.test(message);
}

function listError(registry: Record<Account, Adapter>, account: Account, cause: unknown, note?: Note): string {
  const message = cause instanceof Error ? cause.message : '';
  if (DESCRIBED_FAILURE.test(message)) return message;
  // The row says "check its connection", because that is the one act an owner can take. The cause is
  // still worth one line: "LinkedIn unavailable" once hid an orphaned browser holding the profile,
  // and no amount of re-checking a connection would have said so.
  note?.('warn', `${registry[account].source.label} failed: ${message || String(cause)}`);
  return `${registry[account].source.label} unavailable. Check its connection.`;
}

/**
 * The page driver, as the gateway uses it. These are the chrome module's own functions in
 * production; a test wires stubs. Declared here rather than imported from `linkedin-chrome` so
 * this module never reaches the browser module at runtime or type time.
 */
export interface GatewayDriver {
  openInLinkedInProfile(path: string): Promise<void>;
  inspectLinkedInPage(): Promise<PageControl[]>;
  evaluateInLinkedInProfile(expression: string): Promise<unknown>;
  pressKeyInLinkedInPage(key: string): Promise<void>;
  readSendTarget(): Promise<SendTarget>;
  clickNamedControl(name: string, role?: string, approval?: SendApproval, target?: SendTarget): Promise<{ clicked: boolean; name?: string; reason?: string; recipients?: string[] }>;
  typeIntoNamedControl(name: string, text: string, role?: string, replace?: boolean): Promise<{ typed: boolean; reason?: string }>;
  openLinkedInSignIn(): Promise<string>;
}

/**
 * Everything the handlers need, and nothing about how it was built. The modules are the ones
 * `plugin` already creates per instance; `now` is the clock the approval window reads, and
 * `driver` is the page. A test passes fakes for all of it.
 */
/** One line into the plugin log, the way the WhatsApp lifecycle already reports its sockets. */
export type Note = (level: 'info' | 'warn', line: string) => void;

export interface GatewayDeps {
  cache: Pick<InboxCache, 'list' | 'readThread' | 'clear' | 'forget' | 'freshness' | 'saveFreshness' | 'threadUpdatedAt' | 'setSentSnippet'>;
  search: Pick<ReturnType<typeof createSearchIndex>, 'search' | 'status' | 'warm' | 'row'>;
  audit: Pick<ReturnType<typeof createSendAudit>, 'list'>;
  gate: SendGate;
  registry: Record<Account, Adapter>;
  now: () => number;
  driver: GatewayDriver;
  /**
   * Where the WhatsApp pairing stands, and the acts that change it. A function rather than the module
   * so the socket — 7.9 MB of client and a lazy import — is only loaded when someone pairs.
   */
  pairing: (request: WhatsAppPairingRequest) => Promise<WhatsAppPairingSnapshot>;
  /** The stored yes/no for a conversation, written when a new message arrives. */
  attentionOf?: (account: Account, id: string) => AttentionVerdict | null;
  /** True when the owner cleared Needed and that clear can still be undone. */
  attentionDismissed?: (account: Account, id: string) => boolean;
  /** The owner marked a Needed conversation None. */
  clearAttention?: (account: Account, id: string) => void;
  /** Put back the Needed label from the clear just made. */
  restoreAttention?: (account: Account, id: string) => boolean;
  note?: Note;
  /** The mailbox list and the legacy-id map a panel reads after startup. */
  mailboxes?: { accounts: string[]; legacy: Record<string, string>; conflicts: { account: string; address: string }[] };
  /**
   * Desktop sign-in and the credential files. Absent in a test that never connects.
   * `remove` deletes the credential file only. The gateway drops that account's cache rows.
   */
  gmail?: {
    clientConfigured: () => boolean | Promise<boolean>;
    mailboxes: () => GmailCredentialState[] | Promise<GmailCredentialState[]>;
    connect: (input: { replace: boolean }) => Promise<GmailLoginResult>;
    /** Closes the sign-in listener. A file already written stays. */
    cancel: () => void;
    remove: (account: string) => Promise<void>;
  };
}

/**
 * The handler map, as `bb.rpc.register(rpcContract, ...)` calls it. The transport validates one
 * RPC call, asks the registry which adapter answers for the account, and owns caching, search,
 * unread preservation and error isolation. Every send goes through one gate
 * (src/adapters/policy.ts), so the refusal and the audit record are owned in one place. How a
 * source lists, opens, serves media and acts lives in src/adapters/ — never here.
 */
const MESSAGES_HINT = 'Check that imsg is installed and BB has Full Disk Access.';

export function createGateway({ cache, search, audit, gate, registry, now, driver, pairing, attentionOf, attentionDismissed, clearAttention, restoreAttention, note, mailboxes, gmail }: GatewayDeps): PluginRpcHandlers<typeof rpcContract> {
  const refresh = createInboxRefresh({
    sync: (account, limit) => registry[account].sync({ limit: limit ?? registry[account].source.pageSize }),
    read: account => cache.freshness(account),
    hasCachedRows: account => cache.list().some(row => row.account === account),
    save: (account, state) => cache.saveFreshness(account, state),
    error: (account, cause) => listError(registry, account, cause, note),
    now,
  });
  const registered = () => Object.keys(registry);
  const freshness = () => Object.fromEntries(registered().map(account => [account, cache.freshness(account)])) as Record<Account, ReturnType<InboxCache['freshness']>>;
  /** Rows the cache holds for a source this process still registers. */
  const cachedRows = () => cache.list().filter(row => registry[row.account]) as Conversation[];

  /** A source's cache-only decoration (WhatsApp group participants) is applied wherever rows leave the gateway. */
  const decorated = (rows: Conversation[]) => rows.map(row => {
    const decoratedRow = registry[row.account].decorate?.(row) ?? row;
    const needsAttention = attentionOf?.(decoratedRow.account, decoratedRow.id);
    const dismissed = attentionDismissed?.(decoratedRow.account, decoratedRow.id) === true;
    return needsAttention ? { ...decoratedRow, needsAttention, ...(dismissed ? { attentionDismissed: true } : {}) } : decoratedRow;
  });

  /**
   * Where each source's next older page begins: Gmail's own page token, the WhatsApp store's row offset,
   * and `null` once a source says nothing older exists (a source that cannot page is `null` too).
   * The newest-page read seeds it and only `older` advances it, so the 45-second refresh cannot
   * restart a walk the owner started. It lives in memory, not in the cache: a restart shows the
   * newest page again, exactly as this inbox did before it could page.
   */
  const olderCursor: Partial<Record<Account, string | null>> = {};
  /** Whether any source still holds rows older than the newest page it showed. */
  const hasOlder = () => registered().some(name => typeof olderCursor[name] === 'string');

  /**
   * A search answers with the row it matched, not only its id: a hit can be a conversation the list
   * never loaded, and the panel has nothing else to draw it from. The cache's row wins where there
   * is one — it is what the list is showing, decorations and all — and the index's corpus row
   * answers for everything past it.
   */
  async function searchAnswered(query: string) {
    const ranked = await search.search(query);
    const ids = ranked.slice(0, 50).flatMap(row => {
      const split = row.id.indexOf('\u0000');
      const name = row.id.slice(0, split);
      if (!registry[name]) return [];
      return [{ account: name, id: row.id.slice(split + 1), score: row.score }];
    });
    const cached = new Map(cachedRows().map(row => [`${row.account}\u0000${row.id}`, row]));
    const items = decorated(ids.flatMap(hit => {
      const row = cached.get(`${hit.account}\u0000${hit.id}`) ?? search.row(hit.account, hit.id);
      return row ? [row] : [];
    }));
    return { ids, items, truncated: ranked.length > 50 };
  }

  return {
    capabilities() {
      return registryCapabilities(registry);
    },
    sources() {
      return registrySources(registry);
    },
    mailbox_status() {
      return mailboxes ?? { accounts: registered().filter(account => account !== 'whatsapp' && account !== 'imessage' && account !== 'linkedin'), legacy: {}, conflicts: [] };
    },
    async gmail_connect(input) {
      if (!gmail) throw new Error('Gmail sign-in is not available.');
      return gmail.connect({ replace: input?.replace === true });
    },
    async gmail_connect_cancel() {
      gmail?.cancel();
      return { cancelled: true as const };
    },
    async gmail_remove({ account }) {
      if (!gmail) throw new Error('Gmail removal is not available.');
      await gmail.remove(account);
      // shortcut: panel drafts live in localStorage, drop them when the settings page handles remove.
      cache.forget(account);
      return { removed: true as const };
    },
    async connection_status() {
      const rows = gmail ? await gmail.mailboxes() : [];
      // A read of the pairing state. This does not call ensure() and does not open a socket.
      const whatsapp = await pairing({});
      const linkedin = cache.freshness('linkedin');
      const messagesError = cache.freshness('imessage').lastError;
      return {
        clientConfigured: gmail ? await gmail.clientConfigured() : false,
        mailboxes: rows.map(row => ({
          account: row.account,
          present: row.present,
          hasRefreshToken: row.hasRefreshToken,
          ...(row.expiresAt !== undefined ? { expiresAt: row.expiresAt } : {}),
          ...(row.source ? { source: row.source } : {}),
          ...(row.lastError ? { lastError: { at: row.lastError.at, message: row.lastError.message } } : {}),
        })),
        whatsapp,
        linkedin,
        messages: messagesError ? `${messagesError} ${MESSAGES_HINT}` : MESSAGES_HINT,
      };
    },
    cached() {
      return { items: decorated(cachedRows()), freshness: freshness(), more: Object.fromEntries(registered().map(account => [account, typeof olderCursor[account] === 'string'])) as Record<Account, boolean> };
    },
    freshness() { return freshness(); },
    search({ query }) {
      return searchAnswered(query);
    },
    search_status() { return search.status(); },
    async cached_open({ account, id }) {
      const parsed = z.array(message).safeParse(cache.readThread(account, id) ?? []);
      if (!parsed.success) return { messages: [] };
      const repair = registry[account].repairThread;
      return { messages: repair ? await repair(id, parsed.data) : parsed.data, cacheFallback: true, updatedAt: cache.threadUpdatedAt(account, id) };
    },
    clear_cache() { cache.clear(); return { cleared: true }; },
    clear_attention({ account, id }) {
      clearAttention?.(account, id);
      return { needsAttention: 'no' as const };
    },
    restore_attention({ account, id }) {
      if (!restoreAttention?.(account, id)) throw new Error('This label can no longer be restored.');
      return { needsAttention: 'yes' as const };
    },
    async sync({ account, limit }) {
      if (!registry[account]) throw new Error('That mailbox is not connected.');
      const { cursor, ...result } = await refresh.refresh(account, limit);
      // The newest page is what seeds the walk; once `older` has advanced it, a refresh leaves it
      // alone, or every poll would drop the owner back to page two.
      if (olderCursor[account] === undefined) olderCursor[account] = cursor ?? null;
      void search.warm();
      return { ...result, items: decorated(result.items), more: typeof olderCursor[account] === 'string' };
    },
    async open({ account, id }) {
      const result = await registry[account].open(id);
      void search.warm();
      return { ...result, cacheFallback: result.cacheFallback ?? false, updatedAt: cache.threadUpdatedAt(account, id) };
    },
    // Slice D, observation first: arming watches the page's own fetch, and `writes` reports only
    // what a real action produced. Nothing here sends anything.
    async linkedin_ui(step) {
      if (step.op === 'goto') {
        if (!step.path) throw new Error('LinkedIn navigation needs a path.');
        await driver.openInLinkedInProfile(step.path);
        return { url: step.path };
      }
      if (step.op === 'snapshot') return { controls: await driver.inspectLinkedInPage() };
      if (step.op === 'text') return { text: String(await driver.evaluateInLinkedInProfile(pageTextExpression()) ?? '') };
      if (step.op === 'describe') {
        if (!step.control) throw new Error('A description needs the control to describe.');
        return { description: await driver.evaluateInLinkedInProfile(describeControlExpression(step.control, step.role)) };
      }
      if (step.op === 'press') {
        if (!step.key) throw new Error('A key press needs a key.');
        await driver.pressKeyInLinkedInPage(step.key);
        return { clicked: true };
      }
      // A control is named, not numbered: an index resolved one call ago can be a different control by
      // the next, because this page re-renders continuously.
      const target = step.control;
      if (!target) throw new Error('A LinkedIn page click or typing step needs the control to act on.');
      if (step.op === 'click') {
        const allowed = step.allow ? { allow: step.allow, ...(step.recipient ? { recipient: step.recipient } : {}), ...(step.conversation ? { conversation: step.conversation } : {}), ...(step.invitation ? { invitation: step.invitation } : {}) } : undefined;
        const click = (page?: SendTarget) => driver.clickNamedControl(target, step.role, allowed, page);
        // One click can deliver a message and every other step cannot: that one goes through the
        // gate so the send log sees it, with no approval minted — the page-confirmed target and the
        // caller's own `allow: 'send'` are what authorise it. So the page is read once, before the
        // row is written: the row is named for what that read confirmed, and the driver decides on
        // the same answer. A delivery that throws still leaves its row, because the row is first.
        const page = sendClickRecord(step) ? await driver.readSendTarget() : undefined;
        const record = sendClickRecord(step, page);
        const answered = record
          ? await gate.observe({ account: 'linkedin', ...record }, () => click(page))
          : await click(page);
        return { clicked: answered.clicked, ...(answered.reason ? { reason: answered.reason } : {}), ...(answered.recipients ? { recipients: answered.recipients } : {}) };
      }
      if (typeof step.text !== 'string') throw new Error('A LinkedIn page typing step needs the text to type.');
      return driver.typeIntoNamedControl(target, step.text, step.role, step.replace === true);
    },
    async linkedin_record({ op }) { return registry.linkedin.record!(op); },
    async linkedin_writes() { return { writes: (await registry.linkedin.record!('dump')).writes ?? [] }; },
    // The one RPC that can change the account: the adapter refuses unless the action is a
    // message send to that conversation and the caller approved this exact replay. A send is
    // recorded through the gate — page-confirmed target, `confirm: true`, no approval minted —
    // before it is delivered; a read mark delivers no message and records nothing.
    async linkedin_replay(input) {
      const deliver = () => registry.linkedin.replay!(input);
      if (!isMessageSend(input.write, input.conversationId)) return deliver();
      return gate.observe({
        account: 'linkedin',
        // The validation needs the full urn; the log names the short key a click row names, so one
        // conversation is one id however the caller addressed it.
        conversationId: conversationKeyOf(input.conversationId),
        reason: 'Delivered by a LinkedIn replay with no approval minted for it: the page confirmed the conversation, and the caller confirmed this exact action with confirm: true.',
      }, deliver);
    },
    async linkedin_signin() {
      const profile = await driver.openLinkedInSignIn();
      return { profile, message: 'Sign in to LinkedIn in the window that just opened, then close it and refresh the inbox.' };
    },
    // One call for a read and for the three acts: the pairing module owns the state machine, and an
    // unpaired source answers as a state, so nothing here can turn it into a failure line.
    async whatsapp_pairing(input) {
      return pairing(input ?? {});
    },
    // One media path for every source: the request says how the file is addressed, and the
    // adapter that owns the source answers. A shared post answers with a link because its
    // payload carries no thumbnail.
    async media({ account: source, ...request }) {
      return registry[source].media(request);
    },
    async action({ account: source, id, action, text, allow, messageId, emoji, remove }) {
      const caps = registry[source].capabilities();
      // These refusals sit before the gate, so they write no audit row and never call the adapter.
      if (action === 'react') {
        if (!caps.react) throw new Error('This source cannot react to one message. Nothing was sent.');
        if (!messageId) throw new Error('A reaction needs the message it reacts to. Nothing was sent.');
        if (!isReactionEmoji(emoji)) throw new Error('That emoji is not one of the four reactions. Nothing was sent.');
        if (remove === true && !caps.reactRemove) throw new Error('This source cannot remove a reaction. Nothing was sent.');
        return gate(
          { account: source, conversationId: id, text: text ?? '' },
          approvalFor(allow, id, now()),
          () => registry[source].action(action, id, { text, messageId, emoji, remove }),
        );
      }
      if (action === 'reply' && messageId && !caps.quoteReply) {
        throw new Error('This source cannot reply to one message. Nothing was sent.');
      }
      if (action !== 'reply') return registry[source].action(action, id, { text });
      // A send is the gate's call: it refuses before the adapter, records either way, and
      // hands delivery back so the adapter still validates the send it was given. The approval
      // exists only when the caller said `allow: 'send'`; otherwise the gate gets none.
      return gate(
        { account: source, conversationId: id, text: text ?? '' },
        approvalFor(allow, id, now()),
        () => registry[source].action(action, id, messageId ? { text, messageId } : { text }),
      );
    },
    // No argument reads the default page: the panel and the CLI both ask with nothing.
    async send_audit(input) {
      return { rows: audit.list(input?.limit ?? 5) };
    },
    async mail_approval_policy() { return gate.mailPolicy(); },
    async mail_approval_status(input) { return gate.mailStatus(input); },
    async send_gmail(input) {
      const deliver = registry[input.account]?.send;
      if (!deliver) throw new Error('That mailbox is not connected.');
      const result = await gate.mail(input, mail => deliver({ kind: 'gmail', ...mail }, {}));
      if (input.threadId) cache.setSentSnippet(input.account, input.threadId, input.text);
      return result;
    },
    async disclose(input) {
      const source = registry[input.account];
      if (!source) throw new Error('That mailbox is not connected.');
      if (!source.disclose) throw new Error('This conversation is already complete.');
      const [row] = decorated([await source.disclose(input.id)]);
      if (!row) throw new Error('This conversation is already complete.');
      return row;
    },
    async list(options) {
      const older = options?.older === true;
      if (options?.account && !registry[options.account]) throw new Error('That mailbox is not connected.');
      const scope = options?.account ? [options.account] : registered();
      // A source that already answered "nothing older" is not asked again.
      const names = older ? scope.filter(name => typeof olderCursor[name] === 'string') : scope;
      // How many rows one older page is worth is the source's own declaration: it is the one that
      // knows what a row costs to read.
      const results = await Promise.allSettled(names.map(name => registry[name].list(older ? olderCursor[name]! : undefined, older ? { limit: registry[name].source.pageSize } : undefined)));
      const errors: string[] = [];
      const items: Conversation[] = [];
      results.forEach((result, index) => {
        const name = names[index];
        if (result.status === 'fulfilled') {
          items.push(...result.value.items);
          // A first page seeds the walk and an older page advances it.
          if (older || olderCursor[name] === undefined) olderCursor[name] = result.value.cursor ?? null;
          return;
        }
        // A page that failed may be a token the source has since dropped: forget it so the next
        // refresh reseeds the walk from the newest page instead of retrying a dead one forever.
        // A browser that did not answer is not that token. Keep it, and the next press retries
        // the page the list has not shown.
        if (older && !linkedInBrowserMissed(result.reason)) olderCursor[name] = undefined;
        errors.push(listError(registry, name, result.reason, note));
      });
      void search.warm();
      // A call that named one source answers for that source; the whole-inbox call answers for all.
      const more = options?.account ? typeof olderCursor[options.account] === 'string' : hasOlder();
      return { items: decorated(items.sort((a, b) => b.date - a.date)), errors, more };
    },
  };
}
