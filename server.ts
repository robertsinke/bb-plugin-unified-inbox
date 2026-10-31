import { defineRpcContract, type BbPluginApi } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInboxCache } from './src/inbox-cache';
import { createSearchIndex, createSearchStore } from './src/search-index';
import { ImsgClient } from './src/imsg-client';
import { linkedinProfileDir, openLinkedInSignIn, prewarmLinkedInBrowser, readLinkedInInChrome, stopLinkedInBrowser } from './src/linkedin-chrome';
import { inboxMentionContext, isSourceAccount, MENTION_PROVIDER, mentionId, mentionLabels, parseMentionId, type MentionMessage } from './src/inbox-mention';
import { ATTACHMENT_LIMIT } from './src/adapters/gmail';
import { createGwsRunner } from './src/adapters/gws';
import { accounts, createRegistry, registryCapabilities } from './src/adapters/index';
import { toProviderError } from './src/adapters/provider-error';
import { createWhatsAgent } from './src/adapters/whatsagent';
import type { Account, Conversation } from './src/adapters/types';

// The transport: it validates one RPC call, asks the registry which adapter
// answers for the account, and owns caching, search, unread preservation, error
// isolation and the send policy. How a source lists, opens, serves media and
// acts lives in src/adapters/ — never here.

const account = z.enum(accounts);
const item = z.object({ account, id: z.string(), title: z.string(), preview: z.string(), date: z.number(), unread: z.boolean(), sender: z.string().optional(), avatarUrl: z.string().url().max(2048).optional(), recipients: z.string().max(4000).optional(), attachments: z.array(z.string().max(255)).max(20).optional(), participants: z.array(z.string()).optional() });
const messageMedia = z.object({ messageId: z.string(), kind: z.enum(['image','sticker','video']), cached: z.boolean(), available: z.boolean(), mime: z.string().optional(), filename: z.string().optional(), size: z.number().positive().optional() });
const imsgAttachment = z.object({ index: z.number().int().nonnegative(), name: z.string(), available: z.boolean() });
const message = z.object({ edited: z.boolean().optional(), replyContext: z.boolean().optional(), imsgId: z.string().optional(), imsgAttachments: z.array(imsgAttachment).optional(), sender: z.string(), text: z.string(), date: z.number(), fromMe: z.boolean().optional(), html: z.string().max(800_000).optional(), to: z.string().optional(), cc: z.string().optional(), replyTo: z.string().optional(), subject: z.string().optional(), messageId: z.string().optional(), references: z.string().optional(), suggestedTo: z.string().optional(), suggestedCc: z.string().optional(), attachments: z.array(z.string().max(255)).max(20).optional(), gmailId: z.string().max(512).optional(), media: messageMedia.optional(), reactions: z.array(z.object({ sender: z.string(), label: z.string() })).optional() });
const capabilities = z.object({ send: z.boolean(), markRead: z.boolean(), archive: z.boolean(), media: z.boolean(), attachments: z.boolean(), search: z.boolean().optional() });
const header = z.string().max(2000).refine(v => !/[\r\n\0]/.test(v), 'Invalid header');
export const rpcContract = defineRpcContract({
  list: { input: z.null(), output: z.object({ items: z.array(item), errors: z.array(z.string()) }) },
  cached: { input: z.null(), output: z.object({ items: z.array(item) }) },
  search: { input: z.object({ query: z.string().max(200) }).strict(), output: z.object({ ids: z.array(z.object({ account, id: z.string(), score: z.number() })) }) },
  search_status: { input: z.null(), output: z.object({ size: z.number().int().nonnegative(), updatedAt: z.number().int().nonnegative().nullable(), ready: z.boolean() }) },
  cached_open: { input: z.object({ account, id: z.string().min(1).max(512) }).strict(), output: z.object({ messages: z.array(message) }) },
  clear_cache: { input: z.null(), output: z.object({ cleared: z.boolean() }) },
  list_source: { input: z.object({ account, limit: z.number().int().min(1).max(20).optional() }).strict(), output: z.object({ items: z.array(item) }) },
  open: { input: z.object({ account, id: z.string().min(1).max(512) }).strict(), output: z.object({ messages: z.array(message) }) },
  linkedin_sync: { input: z.null(), output: z.object({ items: z.array(item), updatedAt: z.number().int().nonnegative() }) },
  linkedin_signin: { input: z.null(), output: z.object({ profile: z.string(), message: z.string() }) },
  media: { input: z.object({ messageId: z.string().min(1).max(512) }).strict(), output: z.object({ dataUrl: z.string(), mime: z.string(), filename: z.string().optional() }) },
  attachment: { input: z.object({ account: z.enum(['personal','business']), gmailId: z.string().min(1).max(512), filename: z.string().min(1).max(255) }).strict(), output: z.object({ dataUrl: z.string().max(8_000_000), mime: z.string(), filename: z.string().max(255), size: z.number().int().nonnegative().max(ATTACHMENT_LIMIT) }) },
  imsg_media: { input: z.object({ chatId: z.string().min(1).max(20), messageId: z.string().min(1).max(20), index: z.number().int().min(0).max(99) }).strict(), output: z.object({ dataUrl: z.string(), mime: z.string() }) },
  action: { input: z.object({ account, id: z.string().min(1).max(512), action: z.enum(['read','unread','archive','reply','confirm','reject']), text: z.string().max(20000).optional(), proposalId: z.number().int().positive().optional() }).strict(), output: z.object({ status: z.string(), proposalId: z.number().int().positive().optional(), text: z.string().optional() }) },
  send_gmail: { input: z.object({ account: z.enum(['personal','business']), to: header.min(1), cc: header, subject: header, text: z.string().min(1).max(100000), threadId: z.string().max(512).optional(), inReplyTo: header.optional(), references: header.optional() }).strict(), output: z.object({ status: z.string() }) },
  capabilities: { input: z.null(), output: z.record(account, capabilities) },
});

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
    readLinkedIn: readLinkedInInChrome,
    providerError: toProviderError,
  });

  /** Rows the cache holds for a source this build understands. */
  const cachedRows = () => cache.list().filter(row => isSourceAccount(row.account)) as Conversation[];

  /** A source's cache-only decoration (WhatsApp group participants) is applied wherever rows leave the gateway. */
  const decorated = (rows: Conversation[]) => rows.map(row => registry[row.account].decorate?.(row) ?? row);

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
    async list_source({ account, limit }) {
      const { items } = await registry[account].list(undefined, { limit });
      searchIndex.warm();
      return { items: decorated(items) };
    },
    async open({ account, id }) {
      const result = await registry[account].open(id);
      searchIndex.warm();
      return result;
    },
    async linkedin_sync() {
      const sync = registry.linkedin.sync;
      if (!sync) throw new Error('LinkedIn sync is not available in this build.');
      const result = await sync();
      searchIndex.warm();
      return result;
    },
    async linkedin_signin() {
      const profile = await openLinkedInSignIn();
      return { profile, message: 'Sign in to LinkedIn in the window that just opened, then close it and refresh the inbox.' };
    },
    // `media` carries no account (T9 unifies it); WhatsApp is its only producer today.
    async media({ messageId }) { return registry.whatsapp.media('whatsapp', messageId, 0); },
    async attachment({ account, gmailId, filename }) {
      const read = registry[account].gmailAttachment;
      if (!read) throw new Error('This account has no attachments.');
      return read(gmailId, filename);
    },
    async imsg_media({ chatId, messageId, index }) {
      const read = registry.imessage.imsgMedia;
      if (!read) throw new Error('Messages attachments are not available in this build.');
      return read(chatId, messageId, index);
    },
    async action({ account, id, action, text, proposalId }) {
      return registry[account].action(action, id, { text, proposalId });
    },
    async send_gmail(input) {
      // Disabled until the BB owner-confirmation boundary is verified; RPC is agent-callable.
      const sendingVerified = false;
      if (!sendingVerified) throw new Error('Gmail sending is not enabled yet. Your draft has not been sent.');
      const send = registry[input.account].send;
      if (!send) throw new Error('This source cannot send from the inbox.');
      return send({ kind: 'gmail', ...input }, {});
    },
    async list() {
      const results = await Promise.allSettled(accounts.map(name => registry[name].list()));
      const errors: string[] = [];
      const items: Conversation[] = [];
      results.forEach((result, index) => {
        if (result.status === 'fulfilled') items.push(...result.value.items);
        else errors.push(listError(accounts[index], result.reason));
      });
      searchIndex.warm();
      return { items: decorated(items.sort((a, b) => b.date - a.date)), errors };
    },
  });

  bb.cli.register({
    name: 'unified-inbox',
    summary: 'Unified Inbox helpers, such as the one-time LinkedIn sign-in',
    commands: [{ name: 'linkedin-signin', summary: 'Open the inbox LinkedIn profile so you can sign in once', usage: 'bb unified-inbox linkedin-signin' }],
    async run(argv) {
      if (argv[0] !== 'linkedin-signin') return { exitCode: 1, stderr: 'Usage: bb unified-inbox linkedin-signin' };
      const profile = await openLinkedInSignIn();
      return { exitCode: 0, stdout: `Sign in to LinkedIn in the window that just opened, then close it. Profile: ${profile}\n` };
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
