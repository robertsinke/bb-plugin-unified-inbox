import type { BbPluginApi } from '@get-bb/plugin-sdk';
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
  openLinkedInSignIn, prewarmLinkedInBrowser, pressKeyInLinkedInPage, readSendTarget,
  stopLinkedInBrowser, typeIntoNamedControl,
} from './src/linkedin-chrome';
import { createLinkedInPageSession } from './src/linkedin-page-session';
import { inboxMentionContext, isSourceAccount, MENTION_PROVIDER, mentionId, parseMentionId, type MentionMessage } from './src/inbox-mention';
import { message, rpcContract } from './src/rpc-contract';
import { createGwsRunner } from './src/adapters/gws';
import { createRegistry } from './src/adapters/index';
import { toProviderError } from './src/adapters/provider-error';
import { createSendGate } from './src/adapters/policy';
import { createWhatsAgent } from './src/adapters/whatsagent';
import { createGateway } from './src/gateway';
import { accounts } from './src/adapters/types';
import { runInboxRefresh } from './src/inbox-refresh';

// The wiring: this module builds one instance's storage, gate, registry and page, hands them to
// the gateway (src/gateway.ts) as one plain object, and registers the result with the host. The
// handler table itself is that module, so a test calls a handler without a host API or a browser.
// How a source lists, opens, serves media and acts lives in src/adapters/ — never here.


export default function plugin(bb: BbPluginApi) {
  const db = bb.storage.database();
  const cache = createInboxCache(db);
  const searchIndex = createSearchIndex(cache, createSearchStore(db));
  // Every send attempt is written here: one table in the plugin's own database.
  const sendAudit = createSendAudit(db);
  const now = () => Date.now();
  const sendGate = createSendGate({ now, store: sendAudit });
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

  const gateway = createGateway({
    cache,
    search: searchIndex,
    audit: sendAudit,
    gate: sendGate,
    registry,
    now,
    driver: {
      openInLinkedInProfile,
      inspectLinkedInPage,
      evaluateInLinkedInProfile,
      pressKeyInLinkedInPage,
      readSendTarget,
      clickNamedControl,
      typeIntoNamedControl,
      openLinkedInSignIn,
    },
  });
  bb.rpc.register(rpcContract, gateway);
  for (const account of accounts) {
    bb.background.service(`refresh-${account}`, {
      start: signal => runInboxRefresh(async () => gateway.sync({ account }), registry[account].source.pollIntervalMs, signal),
    });
  }

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
        // The name and the icon are the source's own declaration, not a table kept here.
        .map(item => ({ id: mentionId(item.account, item.id), title: item.title || item.sender || 'Untitled conversation', subtitle: `${registry[item.account].source.label} · ${item.preview}`.slice(0, 140), icon: registry[item.account].source.icon }));
    },
    async resolve(mention) {
      const { account, id } = parseMentionId(mention);
      const listed = cache.list().find(item => item.account === account && item.id === id);
      const cached = z.array(message).safeParse(cache.readThread(account, id) ?? []);
      let messages: MentionMessage[] = cached.success ? cached.data : [];
      if (!messages.length) {
        try { messages = (await registry[account].open(id)).messages; } catch { /* the mention still names the conversation */ }
      }
      return { context: inboxMentionContext({ account, label: registry[account].source.label, id, title: listed?.title, preview: listed?.preview, messages }) };
    },
  });
}
