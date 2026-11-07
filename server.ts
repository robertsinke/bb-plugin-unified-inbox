import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInboxCache } from './src/inbox-cache';
import { createGmailFaceStore, createGmailFaces, type GmailFaces } from './src/gmail-faces';
import { createPeopleClient } from './src/google-people';
import { createWhatsAppStore } from './src/whatsapp/store';
import { createWhatsAppLifecycle } from './src/whatsapp/lifecycle';
import { clearCachedMedia, whatsAppDataDir } from './src/whatsapp/media';
import { createWhatsAppTransport } from './src/whatsapp/transport';
import { attachIngest } from './src/whatsapp/ingest';
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
import { createGateway } from './src/gateway';
import { createGmailClient } from './src/gmail-client';
import { createGmailCredentials } from './src/gmail-oauth';
import { accounts, gmailAccounts, type GmailAccount } from './src/adapters/types';
import { importGwsAccount } from './src/account-import';
import { runInboxRefresh } from './src/inbox-refresh';
import { registerInboxAgentTools } from './src/inbox-agent-tools';
import { parseMailKeyIds, type MailMode } from './src/mail-approval';
import { createAttentionStore, watchNewConversations } from './src/attention';

// The wiring: this module builds one instance's storage, gate, registry and page, hands them to
// the gateway (src/gateway.ts) as one plain object, and registers the result with the host. The
// handler table itself is that module, so a test calls a handler without a host API or a browser.
// How a source lists, opens, serves media and acts lives in src/adapters/ — never here.


export default function plugin(bb: BbPluginApi) {
  const db = bb.storage.database();
  const whatsappStore = createWhatsAppStore(db);
  // Where a Gmail row's contact photo is cached (INBOX-38): one table in the same database, so
  // `clear_cache` takes it with everything else — a photo is the contacts' data, not the cache's.
  const gmailFaceStore = createGmailFaceStore(db);
  // A clear covers what this plugin stored for WhatsApp: the rows and the media bytes they name.
  // The account state is not here and is not touched — forgetting it is a re-pair.
  const cache = createInboxCache(db, { alsoClear: [() => whatsappStore.clear(), () => clearCachedMedia(whatsAppDataDir()), () => gmailFaceStore.clear()] });
  const attention = createAttentionStore(db);
  const attentionWatch = watchNewConversations({
    cache,
    store: attention,
    log: line => bb.log.warn(line),
    ask: input => bb.sdk.plugins.callRpc({
      pluginId: 'decisions',
      method: 'ask',
      input: JSON.parse(JSON.stringify(input)),
      outputSchema: z.object({
        model: z.string(),
        answers: z.record(z.string(), z.unknown()),
        usage: z.object({
          input_tokens: z.number().nullable(),
          output_tokens: z.number().nullable(),
        }).strict(),
      }).strict(),
    }),
    wording: () => bb.sdk.plugins.callRpc({
      pluginId: 'decisions',
      method: 'wording',
      input: null,
      outputSchema: z.object({
        question: z.string(),
        yes: z.string(),
        no: z.string(),
      }).strict(),
    }),
    recentLines: (account, id) => {
      if (account !== 'whatsapp') return null;
      return whatsappStore.listRecentMessages(id, 64).flatMap(message => {
        const text = message.text?.trim() ?? '';
        if (!text) return [];
        return [{ sender: message.from_me ? 'You' : (message.sender ?? ''), text, fromMe: message.from_me }];
      });
    },
  });
  bb.onDispose(() => attentionWatch.stop());
  // The plugin's own WhatsApp socket, when one is open. Absent is the normal state for a stranger —
  // and reads still answer, because the store holds what already arrived. The lifecycle, not this
  // module, decides when that is and why a start failed; `src/whatsapp/lifecycle.ts` says how.
  const whatsappLifecycle = createWhatsAppLifecycle({
    // Baileys is 7.9 MB of bundle and most starts never open a socket, so the client loads with the
    // first ask; the store answers `getMessage` and receives what arrives through the same ingest.
    create: async () => {
      const { WhatsAppConnection } = await import('./src/whatsapp/connection');
      return new WhatsAppConnection({
        getMessage: whatsappStore.storedMessageLoader(),
        bindSocket: socket => attachIngest(socket.ev, whatsappStore, {
          onMessageIngested: message => attentionWatch.arrived('whatsapp', message.chat_jid, {
            sender: message.sender ?? '',
            text: message.text ?? '',
            fromMe: message.from_me,
          }),
        }),
      });
    },
    // One line per socket opened, closed or refused: a dead source is otherwise only visible as a
    // lie on the pairing card, and a repeat has to be diagnosable without a reload and a guess.
    note: (level, line) => bb.log[level](line),
  });

  const whatsappTransport = createWhatsAppTransport({
    store: whatsappStore,
    connection: () => whatsappLifecycle.current(),
    // A read never needs a socket; a download and a send do, and a linked account is reopened on
    // demand rather than left dead because no timer or service happened to hold it.
    ensure: () => whatsappLifecycle.ensure(),
  });
  // Every send attempt is written here: one table in the plugin's own database.
  const sendAudit = createSendAudit(db);
  const now = () => Date.now();
  // The pairing state machine is the socket's only public story, and it is loaded with the socket:
  // a read of the card is the first thing that needs 7.9 MB of client, and most starts never pair.
  let pairingModule: Promise<import('./src/whatsapp/pairing.ts').WhatsAppPairing> | undefined;
  const whatsappPairing = () => (pairingModule ??= import('./src/whatsapp/pairing').then(({ createWhatsAppPairing }) =>
    createWhatsAppPairing({
      open: () => whatsappLifecycle.open(),
      current: () => whatsappLifecycle.current(),
      close: reason => whatsappLifecycle.close(reason),
      failure: () => whatsappLifecycle.failure(),
      opening: () => whatsappLifecycle.opening(),
      now,
    })));

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
  // The socket started by the pairing card is nobody's background service, so a reload has to
  // close it here: the lock is held for the life of the socket, and a second socket on one device
  // identity is the failure WhatsApp answers with a re-pair.
  bb.onDispose(() => { void whatsappLifecycle.close('the plugin was disposed'); });
  bb.onDispose(() => { void stopLinkedInBrowser(); });
  // Chrome's start is the slow part of a LinkedIn read; load the page once the profile exists.
  if (existsSync(linkedinProfileDir())) void prewarmLinkedInBrowser();

  // The plugin's own Gmail credential: one store for both accounts, so a token renewed for one
  // account is never handed to the other, and concurrent reads wait on one grant per account.
  const gmailCredentials = createGmailCredentials();

  // One face source per account: the address book is the account's own, and so is its grant. The
  // read happens behind the draw (`src/gmail-faces.ts`), and a refusal is one log line plus initials
  // rather than an error row: until both accounts are re-consented, every People call answers 403.
  const gmailFaces = Object.fromEntries(gmailAccounts.map(account => [account, createGmailFaces({
    account,
    store: gmailFaceStore,
    people: createPeopleClient({ account, credentials: gmailCredentials }),
    note: (line: string) => bb.log.warn(line),
    now,
  })])) as Record<GmailAccount, GmailFaces>;

  const registry = createRegistry({
    cache,
    // Gmail reads and sends go over HTTPS with the plugin's own credential — no CLI, no shell.
    gmail: account => createGmailClient({ account, credentials: gmailCredentials }),
    gmailFaces: account => gmailFaces[account],
    whatsapp: whatsappTransport,
    imsg,
    linkedInPage: createLinkedInPageSession(evaluateInLinkedInProfile, evaluateLinkedInListRead),
    armLinkedInRecorder: armLinkedInWriteRecorder,
    providerError: toProviderError,
  });

  // What search holds for one account: a source that keeps its own corpus answers for all of it, and
  // a networked source answers with the cache's newest page. One hook, so no source is named here.
  const searchIndex = createSearchIndex({
    corpus: async account => {
      const own = registry[account].searchCorpus;
      if (own) return own();
      return cache.list().filter(row => row.account === account).map(item => ({ item }));
    },
    readThread: (account, id) => cache.readThread(account, id),
    onChange: listener => cache.onChange(listener),
  }, createSearchStore(db));

  const gateway = createGateway({
    cache,
    search: searchIndex,
    audit: sendAudit,
    gate: sendGate,
    registry,
    now,
    pairing: async request => (await whatsappPairing()).handle(request),
    // A source that fails says "check its connection" to the owner and its real cause here: one is
    // the act they can take, the other is what a repeat is diagnosed from.
    note: (level, line) => bb.log[level](line),
    attentionOf: (account, id) => attention.get(account, id)?.verdict ?? null,
    attentionDismissed: (account, id) => attention.get(account, id)?.dismissed === true,
    clearAttention: (account, id) => { attention.dismiss(account, id); },
    restoreAttention: (account, id) => attention.restore(account, id),
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
  // The socket is the other half of the WhatsApp transport: it ingests what arrives, so the next
  // read has something to answer from. Opened at boot only when an account state exists — an
  // unpaired source is a state, not a socket waiting on a QR (R5), and the pairing card opens it when
  // the owner asks. Stopped when the host reloads, and the pairing state follows it: a stopped
  // socket is a socket whose QR and code are gone.
  //
  // A start that is refused leaves the failure with the lifecycle, where the pairing card draws it.
  // Nothing retries here: re-pairing is the ban lever, so the next attempt is the owner's, and holding
  // this service open after a refusal would only hide the reason from the card.
  bb.background.service('whatsapp-connection', {
    async start(signal) {
      const { whatsAppAccountExists } = await import('./src/whatsapp/auth');
      if (!whatsAppAccountExists()) return;
      try {
        await whatsappLifecycle.open();
      } catch {
        return;
      }
      try {
        await untilAborted(signal);
      } finally {
        // Every way a socket ends here is written down: without this line the owner, and the next
        // reader, cannot tell a host that stopped the service from a source that never had a socket.
        await whatsappLifecycle.close('the host stopped the whatsapp-connection service');
      }
    },
  });

  bb.cli.register({
    name: 'unified-inbox',
    summary: 'Unified Inbox helpers: the one-time LinkedIn sign-in, the Gmail credential import, the WhatsApp pairing, and the send gate audit',
    commands: [
      { name: 'linkedin-signin', summary: 'Open the inbox LinkedIn profile so you can sign in once', usage: 'bb unified-inbox linkedin-signin' },
      { name: 'import-gws-account', summary: 'Copy one Gmail account out of its gws config into the plugin credential store, once', usage: 'bb unified-inbox import-gws-account <gmail-personal|gmail-business> [--force]' },
      { name: 'send-audit', summary: 'Show what the send gate allowed or refused, newest first', usage: 'bb unified-inbox send-audit [limit]' },
      { name: 'whatsapp-link', summary: "Open the plugin's own WhatsApp socket and pair it; without a number it only proves the socket", usage: 'bb unified-inbox whatsapp-link [phone-number] [--wait <seconds>]' },
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
      if (argv[0] === 'whatsapp-link') {
        // The pairing proof, run by a human with a phone: this plugin's own socket over its own
        // account state, with the ingest bound, so what it receives is stored and the panel has
        // something to show afterwards. Without a number it connects, reports what the socket said,
        // and stops before asking WhatsApp for anything — which is how the socket is proven on a
        // machine that has never been paired. With a number it requests a pairing code, and the code
        // is the only thing printed: no body, no bytes, no auth state.
        const parsed = parseWhatsAppLinkArgs(argv.slice(1));
        if ('error' in parsed) return { exitCode: 1, stderr: `${parsed.error}\n` };
        return await runWhatsAppLink(parsed.phone, parsed.waitSeconds, whatsappStore);
      }
      return { exitCode: 1, stderr: 'Usage: bb unified-inbox <linkedin-signin|import-gws-account|send-audit|whatsapp-link>' };
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

/**
 * `whatsapp-link [phone-number] [--wait <seconds>]`, parsed at the boundary so the socket never sees
 * a number-shaped mistake as a country code. A number is optional: without one the command proves the
 * socket and stops at the pairing prompt.
 */
function parseWhatsAppLinkArgs(args: string[]): { phone?: string; waitSeconds: number } | { error: string } {
  let waitSeconds = 180;
  let phone: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--wait') {
      const seconds = Number(args[index + 1]);
      if (!Number.isFinite(seconds) || seconds <= 0) {
        return { error: 'Usage: bb unified-inbox whatsapp-link [phone-number] [--wait <seconds>]' };
      }
      waitSeconds = seconds;
      index += 1;
      continue;
    }
    if (argument.startsWith('--')) return { error: `Unknown option ${argument}` };
    if (phone !== undefined) return { error: 'One phone number per run: pairing is one deliberate act' };
    phone = argument;
  }
  if (phone !== undefined) {
    // WhatsApp wants the international number without punctuation; this refuses a truncated one before
    // a socket is opened, because a wrong number burns a pairing request on the server.
    const digits = phone.replace(/\D/g, '');
    if (digits.length < 7 || digits.length > 15) {
      return { error: 'A full international phone number is required, for example 31612345678' };
    }
  }
  return { phone, waitSeconds };
}

/**
 * `bb unified-inbox whatsapp-link [phone-number]` — the proof that this plugin, alone, has WhatsApp.
 * Every line it prints is a fact about the socket: the state it moved to, what WhatsApp offered, and
 * the metadata of each message that arrived. It never prints a message body, an auth byte, or a path
 * inside the account state beyond the directory's own name, mode and file count.
 *
 * What arrives goes through the same ingest the background socket uses, so a message received here
 * is stored and readable in the panel afterwards — the run is not a preview of the transport, it is
 * the transport.
 *
 * Without a phone number it stops at the pairing prompt, so the socket can be proven live without
 * asking WhatsApp to pair anything. With one, the eight characters are the only output that matters.
 */
async function runWhatsAppLink(
  phone: string | undefined,
  waitSeconds: number,
  store: ReturnType<typeof createWhatsAppStore>,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  // A deliberate pairing touches the owner's own device slots, so it happens only when they run this
  // with their number. The plugin never pairs on its own.
  const { WhatsAppConnection } = await import('./src/whatsapp/connection');
  const connection = new WhatsAppConnection({
    ...(phone ? { pairingPhone: phone } : {}),
    getMessage: store.storedMessageLoader(),
    bindSocket: socket => attachIngest(socket.ev, store),
  });
  const state = connection.accountState();
  const output: string[] = [
    `Account state ${state.dir}: mode ${state.dirMode ? state.dirMode.toString(8).padStart(4, '0') : 'absent'}, ${state.fileCount} files\n`,
  ];
  const recent: string[] = [];
  let dropped = 0;
  let settle: (code: number) => void = () => {};
  const settled = new Promise<number>((resolve) => { settle = resolve; });

  const record = (line: string) => {
    recent.push(line);
    // Bounded output: a busy account can deliver messages faster than a terminal can scroll.
    if (recent.length > 50) {
      recent.shift();
      dropped += 1;
    }
  };

  const timer = setTimeout(() => settle(1), Math.max(5, waitSeconds) * 1_000);
  const off = connection.onEvent((event) => {
    switch (event.type) {
      case 'connection':
        record(`connection ${event.state}\n`);
        if (event.state === 'connected') settle(0);
        break;
      case 'pairing-needed':
        record(`pairing-needed: WhatsApp offered a QR${phone ? '' : '; rerun with your phone number for a pairing code instead'}\n`);
        break;
      case 'pairing-code':
        record(`pairing code ${event.code} — enter it on your phone under Linked devices\n`);
        break;
      case 'message':
        record(`message ${event.id} chat=${event.chatId}${event.fromMe ? ' fromMe' : ''}\n`);
        break;
      case 'logged-out':
        record('logged out: this device was unlinked; pair again with whatsapp-link <phone-number>\n');
        settle(1);
        break;
      case 'error':
        record(`error${event.fatal ? ' (fatal)' : ''}: ${event.error.message}\n`);
        break;
    }
  });

  try {
    await connection.start();
  } catch (error) {
    clearTimeout(timer);
    off();
    return { exitCode: 1, stdout: output.join(''), stderr: `${error instanceof Error ? error.message : String(error)}\n` };
  }

  const exitCode = await settled;
  clearTimeout(timer);
  off();
  await connection.stop();
  if (dropped) output.push(`(${dropped} earlier lines dropped)\n`);
  output.push(...recent);
  const after = connection.accountState();
  output.push(exitCode === 0
    ? `connected; account state now mode ${after.dirMode.toString(8)} with ${after.fileCount} files\n`
    : 'not connected\n');
  return { exitCode, stdout: output.join(''), stderr: '' };
}

/**
 * Resolves when the host asks a background service to stop. A service's `start` must resolve on
 * dispose, reload or shutdown, and the socket is stopped in the `finally` either way.
 */
function untilAborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
}
