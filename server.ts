import { defineRpcContract, type BbPluginApi } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInboxCache } from './src/inbox-cache';
import { createSearchIndex, createSearchStore } from './src/search-index';
import { createSendAudit } from './src/send-audit';
import { ImsgClient } from './src/imsg-client';
import {
  armLinkedInWriteRecorder, clickNamedControl, evaluateInLinkedInProfile, inspectLinkedInPage, linkedinProfileDir, openInLinkedInProfile,
  openLinkedInSignIn, prewarmLinkedInBrowser, pressKeyInLinkedInPage,
  stopLinkedInBrowser, typeIntoNamedControl,
} from './src/linkedin-chrome';
import { createLinkedInPageSession } from './src/linkedin-page-session';
import { describeControlExpression, pageTextExpression, sendClickRecord } from './src/linkedin-ui';
import { inboxMentionContext, isSourceAccount, MENTION_PROVIDER, mentionId, mentionLabels, parseMentionId, type MentionMessage } from './src/inbox-mention';
import { item, message, rpcContract } from './src/rpc-contract';
import { createGwsRunner } from './src/adapters/gws';
import { accounts, createRegistry, registryCapabilities } from './src/adapters/index';
import { capabilitiesSchema } from './src/adapters/capability';
import { attachmentMediaRequestSchema, imsgMediaRequestSchema, messageMediaRequestSchema } from './src/adapters/media';
import { toProviderError } from './src/adapters/provider-error';
import { approvalFor, createSendGate } from './src/adapters/policy';
import { isMessageSend } from './src/linkedin-write';
import { createWhatsAgent } from './src/adapters/whatsagent';
import type { Account, Conversation } from './src/adapters/types';

// The transport: it validates one RPC call, asks the registry which adapter
// answers for the account, and owns caching, search, unread preservation and error
// isolation. Every send goes through one gate (src/adapters/policy.ts), so the
// refusal and the audit record are owned in one place. How a source lists, opens,
// serves media and acts lives in src/adapters/ — never here.


/** The name a person knows a source by, used only when a failure has nothing specific to say. */
const SOURCE_LABEL: Record<Account, string> = {
  personal: 'Personal Gmail',
  business: 'Business Gmail',
  whatsapp: 'WhatsApp',
  imessage: 'Messages',
  linkedin: 'LinkedIn',
};

/** Failure text a source already phrased for a person, or one the provider-error factory scrubbed. */
const DESCRIBED_FAILURE = /^(?:WhatsAgent backend is unavailable\.|LinkedIn |(?:gmail|whatsapp|imsg|linkedin) \w+ request failed \()/;

/** The mention picker's icon per source: mail reads as mail, every conversation source as chat. */
const MENTION_ICON: Record<Account, string> = {
  personal: 'Mail',
  business: 'Mail',
  whatsapp: 'MessageCircle',
  imessage: 'MessageCircle',
  linkedin: 'MessageCircle',
};

/** One failed source never hides the others: it becomes one line in `list`'s `errors`. */
function listError(account: Account, cause: unknown): string {
  const message = cause instanceof Error ? cause.message : '';
  return DESCRIBED_FAILURE.test(message) ? message : `${SOURCE_LABEL[account]} unavailable. Check its connection.`;
}

export default function plugin(bb: BbPluginApi) {
  const db = bb.storage.database();
  const cache = createInboxCache(db);
  const searchIndex = createSearchIndex(cache, createSearchStore(db));
  // Every send attempt is written here: one table in the plugin's own database.
  const sendAudit = createSendAudit(db);
  const sendGate = createSendGate({ now: () => Date.now(), store: sendAudit });
  const imsgPath = [join(homedir(), '.local/bin/imsg'), '/opt/homebrew/bin/imsg', '/usr/local/bin/imsg'].find(path => existsSync(path)) ?? 'imsg';
  const imsg = new ImsgClient(imsgPath);
  bb.onDispose(() => imsg.dispose());
  bb.onDispose(() => { void stopLinkedInBrowser(); });
  // Chrome's start is the slow part of a LinkedIn read; load the page once the profile exists.
  if (existsSync(linkedinProfileDir())) void prewarmLinkedInBrowser();

  const registry = createRegistry({
    cache,
    gmail: createGwsRunner(),
    whatsapp: createWhatsAgent(),
    imsg,
    linkedInPage: createLinkedInPageSession(expression => evaluateInLinkedInProfile(expression)),
    armLinkedInRecorder: armLinkedInWriteRecorder,
    providerError: toProviderError,
  });

  /** Rows the cache holds for a source this build understands. */
  const cachedRows = () => cache.list().filter(row => isSourceAccount(row.account)) as Conversation[];

  /** A source's cache-only decoration (WhatsApp group participants) is applied wherever rows leave the gateway. */
  const decorated = (rows: Conversation[]) => rows.map(row => registry[row.account].decorate?.(row) ?? row);

  /**
   * Where each source's next older page begins: Gmail's own page token, WhatsAgent's row offset,
   * and `null` once a source says nothing older exists (a source that cannot page is `null` too).
   * The newest-page read seeds it and only `older` advances it, so the 45-second refresh cannot
   * restart a walk the owner started. It lives in memory, not in the cache: a restart shows the
   * newest page again, exactly as this inbox did before it could page.
   */
  const olderCursor: Partial<Record<Account, string | null>> = {};
  /** Whether any source still holds rows older than the newest page it showed. */
  const hasOlder = () => accounts.some(name => typeof olderCursor[name] === 'string');

  /**
   * How many rows one older page asks a source for. A Gmail row costs one CLI read of its thread
   * (a listing carries only an id and a snippet), and twenty of those per account — forty in a
   * round, sharing the runner's pool with the periodic refreshes — measured 11–20s and lost the
   * panel's 15-second ceiling, so the owner saw the WhatsApp page and no mail. Ten fits: the same
   * page lands in about five seconds, and a press that is quick is worth two that never arrive.
   * WhatsApp pages by offset and answers fifty chats in a second, so it keeps its fifty.
   */
  const OLDER_PAGE: Partial<Record<Account, number>> = { personal: 10, business: 10 };

  bb.rpc.register(rpcContract, {
    capabilities() {
      return registryCapabilities(registry);
    },
    cached() {
      return { items: decorated(cachedRows()) };
    },
    search({ query }) {
      const ranked = searchIndex.search(query);
      return { ids: ranked.slice(0, 50).flatMap(row => {
        const split = row.id.indexOf('\u0000');
        const name = row.id.slice(0, split);
        if (!isSourceAccount(name)) return [];
        return [{ account: name, id: row.id.slice(split + 1), score: row.score }];
      }) };
    },
    search_status() { return searchIndex.status(); },
    async cached_open({ account, id }) {
      const parsed = z.array(message).safeParse(cache.readThread(account, id) ?? []);
      if (!parsed.success) return { messages: [] };
      const repair = registry[account].repairThread;
      return { messages: repair ? await repair(id, parsed.data) : parsed.data };
    },
    clear_cache() { cache.clear(); return { cleared: true }; },
    async sync({ account, limit }) {
      const { cursor, ...result } = await registry[account].sync({ limit });
      // The newest page is what seeds the walk; once `older` has advanced it, a refresh leaves it
      // alone, or every poll would drop the owner back to page two.
      if (olderCursor[account] === undefined) olderCursor[account] = cursor ?? null;
      searchIndex.warm();
      return { ...result, items: decorated(result.items), more: typeof olderCursor[account] === 'string' };
    },
    async open({ account, id }) {
      const result = await registry[account].open(id);
      searchIndex.warm();
      return result;
    },
    // Slice D, observation first: arming watches the page's own fetch, and `writes` reports only
    // what a real action produced. Nothing here sends anything.
    async linkedin_ui(step) {
      if (step.op === 'goto') {
        if (!step.path) throw new Error('LinkedIn navigation needs a path.');
        await openInLinkedInProfile(step.path);
        return { url: step.path };
      }
      if (step.op === 'snapshot') return { controls: await inspectLinkedInPage() };
      if (step.op === 'text') return { text: String(await evaluateInLinkedInProfile(pageTextExpression()) ?? '') };
      if (step.op === 'describe') {
        if (!step.control) throw new Error('A description needs the control to describe.');
        return { description: await evaluateInLinkedInProfile(describeControlExpression(step.control, step.role)) };
      }
      if (step.op === 'press') {
        if (!step.key) throw new Error('A key press needs a key.');
        await pressKeyInLinkedInPage(step.key);
        return { clicked: true };
      }
      // A control is named, not numbered: an index resolved one call ago can be a different control by
      // the next, because this page re-renders continuously.
      const target = step.control;
      if (!target) throw new Error('A LinkedIn page click or typing step needs the control to act on.');
      if (step.op === 'click') {
        const allowed = step.allow ? { allow: step.allow, ...(step.recipient ? { recipient: step.recipient } : {}), ...(step.conversation ? { conversation: step.conversation } : {}), ...(step.invitation ? { invitation: step.invitation } : {}) } : undefined;
        const click = () => clickNamedControl(target, step.role, allowed);
        // One click can deliver a message and every other step cannot: that one goes through the
        // gate so the send log sees it, with no approval minted — the page-confirmed target and the
        // caller's own `allow: 'send'` are what authorise it. The row lands before the click.
        const record = sendClickRecord(step);
        const answered = record
          ? await sendGate.observe({ account: 'linkedin', ...record }, click)
          : await click();
        return { clicked: answered.clicked, ...(answered.reason ? { reason: answered.reason } : {}), ...(answered.recipients ? { recipients: answered.recipients } : {}) };
      }
      if (typeof step.text !== 'string') throw new Error('A LinkedIn page typing step needs the text to type.');
      return typeIntoNamedControl(target, step.text, step.role, step.replace === true);
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
      return sendGate.observe({
        account: 'linkedin',
        conversationId: input.conversationId,
        reason: 'Delivered by a LinkedIn replay with no approval minted for it: the page confirmed the conversation, and the caller confirmed this exact action with confirm: true.',
      }, deliver);
    },
    async linkedin_signin() {
      const profile = await openLinkedInSignIn();
      return { profile, message: 'Sign in to LinkedIn in the window that just opened, then close it and refresh the inbox.' };
    },
    // One media path for every source: the request says how the file is addressed, and the
    // adapter that owns the source answers. A shared post answers with a link because its
    // payload carries no thumbnail.
    async media({ account: source, ...request }) {
      return registry[source].media(request);
    },
    async action({ account: source, id, action, text, allow }) {
      if (action !== 'reply') return registry[source].action(action, id, { text });
      // A send is the gate's call: it refuses before the adapter, records either way, and
      // hands delivery back so the adapter still validates the send it was given. The approval
      // exists only when the caller said `allow: 'send'`; otherwise the gate gets none.
      return sendGate(
        { account: source, conversationId: id, text: text ?? '' },
        approvalFor(allow, id, Date.now()),
        () => registry[source].action(action, id, { text }),
      );
    },
    async send_audit({ limit }) {
      return { rows: sendAudit.list(limit ?? 5) };
    },
    async send_gmail(input) {
      const deliver = registry[input.account].send;
      if (!deliver) throw new Error('This source cannot send from the inbox.');
      // Gmail is enabled by SEND_POLICY; the approval is what makes this send one the owner asked
      // for, and the gate writes its row before the adapter is reached.
      return sendGate(
        { account: input.account, conversationId: input.threadId ?? input.to, text: input.text, bcc: input.bcc },
        approvalFor(input.allow, input.threadId ?? input.to, Date.now()),
        () => deliver({ kind: 'gmail', ...input }, {}),
      );
    },
    async list(options) {
      const older = options?.older === true;
      const scope = options?.account ? [options.account] : accounts;
      // A source that already answered "nothing older" is not asked again.
      const names = older ? scope.filter(name => typeof olderCursor[name] === 'string') : scope;
      const results = await Promise.allSettled(names.map(name => registry[name].list(older ? olderCursor[name]! : undefined, older ? { limit: OLDER_PAGE[name] ?? undefined } : undefined)));
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
        if (older) olderCursor[name] = undefined;
        errors.push(listError(name, result.reason));
      });
      searchIndex.warm();
      // A call that named one source answers for that source; the whole-inbox call answers for all.
      const more = options?.account ? typeof olderCursor[options.account] === 'string' : hasOlder();
      return { items: decorated(items.sort((a, b) => b.date - a.date)), errors, more };
    },
  });

  bb.cli.register({
    name: 'unified-inbox',
    summary: 'Unified Inbox helpers: the one-time LinkedIn sign-in, and the send gate audit',
    commands: [
      { name: 'linkedin-signin', summary: 'Open the inbox LinkedIn profile so you can sign in once', usage: 'bb unified-inbox linkedin-signin' },
      { name: 'send-audit', summary: 'Show what the send gate allowed or refused, newest first', usage: 'bb unified-inbox send-audit [limit]' },
    ],
    async run(argv) {
      if (argv[0] === 'linkedin-signin') {
        const profile = await openLinkedInSignIn();
        return { exitCode: 0, stdout: `Sign in to LinkedIn in the window that just opened, then close it. Profile: ${profile}\n` };
      }
      if (argv[0] === 'send-audit') {
        const rows = sendAudit.list(Number(argv[1] ?? 20));
        if (!rows.length) return { exitCode: 0, stdout: 'No send attempts recorded yet.\n' };
        return { exitCode: 0, stdout: rows.map(row => `${new Date(row.at).toISOString()} ${row.decision.padEnd(7)} ${row.account} ${row.conversationId}${row.bcc ? ` bcc ${row.bcc}` : ''}${row.reason ? ` — ${row.reason}` : ''}\n`).join('') };
      }
      return { exitCode: 1, stderr: 'Usage: bb unified-inbox <linkedin-signin|send-audit>' };
    },
  });

  bb.ui.registerMentionProvider({
    id: MENTION_PROVIDER,
    label: 'Inbox',
    triggers: ['#'],
    search({ query }) {
      const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
      return cache.list()
        .filter(item => isSourceAccount(item.account))
        .filter(item => words.every(word => `${item.sender ?? ''} ${item.title} ${item.preview}`.toLowerCase().includes(word)))
        .sort((a, b) => b.date - a.date)
        .slice(0, 20)
        .map(item => ({ id: mentionId(item.account, item.id), title: item.title || item.sender || 'Untitled conversation', subtitle: `${mentionLabels[item.account]} · ${item.preview}`.slice(0, 140), icon: MENTION_ICON[item.account] }));
    },
    async resolve(mention) {
      const { account, id } = parseMentionId(mention);
      const listed = cache.list().find(item => item.account === account && item.id === id);
      const cached = z.array(message).safeParse(cache.readThread(account, id) ?? []);
      let messages: MentionMessage[] = cached.success ? cached.data : [];
      if (!messages.length) {
        try { messages = (await registry[account].open(id)).messages; } catch { /* the mention still names the conversation */ }
      }
      return { context: inboxMentionContext({ account, id, title: listed?.title, preview: listed?.preview, messages }) };
    },
  });
}
