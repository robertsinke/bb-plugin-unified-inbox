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
  armLinkedInWriteRecorder, clickNamedControl, evaluateInLinkedInProfile, evaluateLinkedInListRead, inspectLinkedInPage, linkedinProfileDir, openInLinkedInProfile,
  openLinkedInSignIn, prewarmLinkedInBrowser, pressKeyInLinkedInPage, readSendTarget,
  stopLinkedInBrowser, typeIntoNamedControl,
} from './src/linkedin-chrome';
import { createLinkedInPageSession } from './src/linkedin-page-session';
import { inboxMentionContext, isSourceAccount, MENTION_PROVIDER, mentionId, parseMentionId, type MentionMessage } from './src/inbox-mention';
import { message, rpcContract } from './src/rpc-contract';
import { createRegistry } from './src/adapters/index';
import { toProviderError } from './src/adapters/provider-error';
import { createSendGate } from './src/adapters/policy';
import { createWhatsAgent } from './src/adapters/whatsagent';
import { createGateway } from './src/gateway';
import { createGmailClient } from './src/gmail-client';
import { createGmailCredentials } from './src/gmail-oauth';
import { accounts, gmailAccounts, type GmailAccount } from './src/adapters/types';
import { importGwsAccount } from './src/account-import';
import { runInboxRefresh } from './src/inbox-refresh';
import { registerInboxAgentTools } from './src/inbox-agent-tools';
import { parseMailKeyIds, type MailMode } from './src/mail-approval';

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
  const mailSettings = bb.settings.define({
    mailApprovalMode: { type: 'select', label: 'Mail approval rollout', options: ['prepare', 'compatibility', 'require'], default: 'compatibility' },
    mailApprovalKeyIds: { type: 'string', label: 'Enrolled mail signing key ids', default: '', experimental_multiline: true,
      description: 'Deliberately configure trusted SHA-256 key ids. Empty authorizes no signing keys.',
      experimental_schema: z.string().refine(value => { try { parseMailKeyIds(value); return true; } catch { return false; } }, 'Use lowercase SHA-256 ids separated by commas or whitespace') },
  });
  const sendGate = createSendGate({ now, store: sendAudit, mail: { db, lastRefusal: sendAudit.lastMailRefusal, policy: async () => {
    const settings = await mailSettings.get();
    return { mode: settings.mailApprovalMode as MailMode, allowedKeyIds: parseMailKeyIds(settings.mailApprovalKeyIds) };
  } } });
  const imsgPath = [join(homedir(), '.local/bin/imsg'), '/opt/homebrew/bin/imsg', '/usr/local/bin/imsg'].find(path => existsSync(path)) ?? 'imsg';
  const imsg = new ImsgClient(imsgPath);
  bb.onDispose(() => imsg.dispose());
  bb.onDispose(() => { void stopLinkedInBrowser(); });
  // Chrome's start is the slow part of a LinkedIn read; load the page once the profile exists.
  if (existsSync(linkedinProfileDir())) void prewarmLinkedInBrowser();

  // The plugin's own Gmail credential: one store for both accounts, so a token renewed for one
  // account is never handed to the other, and concurrent reads wait on one grant per account.
  const gmailCredentials = createGmailCredentials();

  const registry = createRegistry({
    cache,
    // Gmail reads and sends go over HTTPS with the plugin's own credential — no CLI, no shell.
    gmail: account => createGmailClient({ account, credentials: gmailCredentials }),
    whatsapp: createWhatsAgent(),
    imsg,
    linkedInPage: createLinkedInPageSession(evaluateInLinkedInProfile, evaluateLinkedInListRead),
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
  registerInboxAgentTools(bb, gateway);
  for (const account of accounts) {
    bb.background.service(`refresh-${account}`, {
      start: signal => runInboxRefresh(async () => gateway.sync({ account }), registry[account].source.pollIntervalMs, signal),
    });
  }

  bb.cli.register({
    name: 'unified-inbox',
    summary: 'Unified Inbox helpers: the one-time LinkedIn sign-in and Gmail credential import, and the send gate audit',
    commands: [
      { name: 'linkedin-signin', summary: 'Open the inbox LinkedIn profile so you can sign in once', usage: 'bb unified-inbox linkedin-signin' },
      { name: 'import-gws-account', summary: 'Copy one Gmail account out of its gws config into the plugin credential store, once', usage: 'bb unified-inbox import-gws-account <gmail-personal|gmail-business> [--force]' },
      { name: 'send-audit', summary: 'Show what the send gate allowed or refused, newest first', usage: 'bb unified-inbox send-audit [limit]' },
    ],
    async run(argv) {
      if (argv[0] === 'linkedin-signin') {
        const profile = await openLinkedInSignIn();
        return { exitCode: 0, stdout: `Sign in to LinkedIn in the window that just opened, then close it. Profile: ${profile}\n` };
      }
      if (argv[0] === 'import-gws-account') {
        const account = argv[1];
        if (!gmailAccounts.includes(account as GmailAccount)) {
          return { exitCode: 1, stderr: `Usage: bb unified-inbox import-gws-account <${gmailAccounts.join('|')}> [--force]\n` };
        }
        try {
          const imported = await importGwsAccount({ account: account as GmailAccount, force: argv.includes('--force') });
          return { exitCode: 0, stdout: `${imported.replaced ? 'Replaced' : 'Imported'} ${imported.account} from gws into ${imported.path} (source gws-import).\n` };
        } catch (error) {
          // Every message the import throws is already secret-free; it names the account, not the token.
          return { exitCode: 1, stderr: `${error instanceof Error ? error.message : String(error)}\n` };
        }
      }
      if (argv[0] === 'send-audit') {
        const rows = sendAudit.list(Number(argv[1] ?? 20));
        if (!rows.length) return { exitCode: 0, stdout: 'No send attempts recorded yet.\n' };
        return { exitCode: 0, stdout: rows.map(row => `${new Date(row.at).toISOString()} ${row.decision.padEnd(7)} ${row.account} ${row.conversationId}${row.bcc ? ` bcc ${row.bcc}` : ''}${row.reason ? ` — ${row.reason}` : ''}\n`).join('') };
      }
      return { exitCode: 1, stderr: 'Usage: bb unified-inbox <linkedin-signin|import-gws-account|send-audit>' };
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
