// Shared stubs for the capability-parity tests. Every dependency is a local
// object: no test in this directory reaches Gmail, WhatsAgent, Messages or
// LinkedIn. The stubs record the calls that actually crossed the adapter
// boundary, so a refusal can be proven to stop before the source.
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createInboxCache } from '../../src/inbox-cache.ts';
import { createRegistry } from '../../src/adapters/index.ts';
import { toProviderError } from '../../src/adapters/provider-error.ts';
import type { RegistryDeps } from '../../src/adapters/deps.ts';
import type { Account, Adapter, GmailClient, GmailTransport, WhatsAppTransport } from '../../src/adapters/types.ts';


export const LINKEDIN_ID = 'urn:li:msg_conversation:(urn:li:fsd_profile:ACoAAAtest,2-abc)';

/** A pending invitation the read carries, with the params its answer needs. */
export const LINKEDIN_INVITE = 'urn:li:fs_relInvitation:12345';
export const WHATSAPP_ID = '15551234567@s.whatsapp.net';
/** A group chat: the transport sends to one, and its preview is `sender: body`. */
export const WHATSAPP_GROUP_ID = '120363000000000003@g.us';
export const IMSG_ID = '50';

const GMAIL_THREAD = {
  id: 't1',
  messages: [{
    id: 'm1',
    internalDate: '1700000000000',
    snippet: 'See you at six',
    labelIds: [],
    payload: {
      mimeType: 'text/plain',
      headers: [
        { name: 'Subject', value: 'Dinner' },
        { name: 'From', value: 'Ada Lovelace <ada@example.com>' },
        { name: 'To', value: 'personal@example.com' },
      ],
      body: { data: Buffer.from('See you at six').toString('base64url') },
    },
  }],
};

const GMAIL_MESSAGE_WITH_ATTACHMENT = {
  id: 'm-att',
  payload: {
    mimeType: 'multipart/mixed',
    parts: [{
      filename: 'notes.txt',
      mimeType: 'text/plain',
      body: { data: Buffer.from('hello').toString('base64url'), size: 5 },
    }],
  },
};

/** A typed call crossing the transport seam: which endpoint, and the input it carried. */
export interface GmailCall {
  method: keyof GmailClient;
  input?: any;
}

/** The label each typed call is recorded under: the endpoint the suite has always named. */
const GMAIL_LABEL: Record<keyof GmailClient, string> = {
  profile: 'getProfile',
  threadsList: 'threads:list',
  threadGet: 'threads:get',
  threadsModify: 'threads:modify',
  messageGet: 'messages:get',
  attachmentGet: 'messages:attachments',
  sendRaw: 'send',
};

function gmailResponse(call: GmailCall): unknown {
  if (call.method === 'profile') return { historyId: '77' };
  if (call.method === 'threadsList') return { threads: [{ id: 't1', historyId: '77', snippet: 'See you at six' }] };
  if (call.method === 'threadGet') return GMAIL_THREAD;
  if (call.method === 'threadsModify') return {};
  if (call.method === 'messageGet') return GMAIL_MESSAGE_WITH_ATTACHMENT;
  // The default message carries its bytes inline, so nothing reaches for this fetch by default.
  if (call.method === 'attachmentGet') return Buffer.from('attachment bytes');
  throw new Error(`unexpected Gmail call: ${call.method}`);
}

/**
 * A fake WhatsApp transport: the adapter suite must run with no socket, no HTTP and no fixture
 * server, so every answer a read needs is a literal here, recorded under the call that asked.
 */
export function fakeWhatsAppTransport(
  calls: string[],
  overrides: Partial<WhatsAppTransport> = {},
): WhatsAppTransport {
  return {
    async listChats() {
      calls.push('whatsapp:listChats');
      return {
        chats: [{
          jid: WHATSAPP_ID,
          name: 'Ada',
          kind: '1:1',
          lastMsgAt: 1_700_000_000_000,
          preview: { text: 'See you', fromMe: false, sender: 'Ada' },
          unread: 2,
        }],
      };
    },
    async openChat() {
      calls.push('whatsapp:openChat');
      return [{ id: 'm1', chatJid: WHATSAPP_ID, fromMe: false, ts: 1_700_000_000_000, type: 'text', text: 'See you', sender: 'Ada', edited: false }];
    },
    async mediaFacts() {
      calls.push('whatsapp:mediaFacts');
      return undefined;
    },
    // Nothing is stored for a picture by default: a row draws initials until a test hands one over.
    avatarUrl() {
      return undefined;
    },
    async loadMedia() {
      calls.push('whatsapp:loadMedia');
      return {};
    },
    async discardMedia() {
      calls.push('whatsapp:discardMedia');
    },
    async markRead() {
      calls.push('whatsapp:markRead');
    },
    async sendText() {
      calls.push('whatsapp:sendText');
    },
    async status() {
      calls.push('whatsapp:status');
      return { connection: 'disconnected', paired: false };
    },
    ...overrides,
  };
}

function imsgResponse(method: string, params?: Record<string, unknown>): unknown {
  if (method === 'chats.list') {
    return { chats: [{ id: 50, name: 'Ada', display_name: null, identifier: null, service: 'iMessage', last_message_at: '2024-01-01T00:00:00Z', unread_count: 1 }] };
  }
  if (method === 'messages.history') {
    return { messages: [{ id: 1, guid: 'g-1', sender: '+15551234567', sender_name: 'Ada', chat_name: null, text: 'Hello', created_at: '2024-01-01T00:00:00Z', is_from_me: false, attachments: [], reactions: [] }] };
  }
  if (method === 'send') return { ok: true, guid: 'g-sent', message_id: params?.text };
  throw new Error(`unexpected Messages call: ${method}`);
}

export interface Harness {
  cache: ReturnType<typeof createInboxCache>;
  registry: Record<Account, Adapter>;
  calls: string[];
  sent: { account: string; raw: string | Uint8Array; threadId?: string }[];
  close(): void;
}

export interface HarnessOptions {
  gmailCall?: (account: Account, call: GmailCall) => unknown;
  /** Replace the whole Gmail transport factory, for a test that needs the real client. */
  gmail?: GmailTransport;
  linkedInThread?: () => Promise<unknown>;
  /** Replace one Messages history response, for attachment cases that need a real file name. */
  imsgHistory?: (params?: Record<string, unknown>) => unknown;
  /** Replace the fake WhatsApp transport, or one of its answers. */
  whatsapp?: Partial<WhatsAppTransport>;
}

/** Registry wired to stubs; `calls` is the only record of source traffic. */
export function harness(options: HarnessOptions = {}): Harness {
  const db = new Database(':memory:');
  const cache = createInboxCache(db);
  const calls: string[] = [];
  const sent: Harness['sent'] = [];
  const deps: RegistryDeps = {
    cache,
    // One typed client per account: no test in this directory spawns a CLI or opens a socket.
    gmail: options.gmail ?? (account => {
      const answer = (call: GmailCall): any => {
        calls.push(`gmail:${account}:${GMAIL_LABEL[call.method]}`);
        return options.gmailCall ? options.gmailCall(account, call) : gmailResponse(call);
      };
      return {
        profile: async () => answer({ method: 'profile' }),
        threadsList: async (input = {}) => answer({ method: 'threadsList', input }),
        threadGet: async input => answer({ method: 'threadGet', input }),
        threadsModify: async input => answer({ method: 'threadsModify', input }),
        messageGet: async input => answer({ method: 'messageGet', input }),
        attachmentGet: async input => answer({ method: 'attachmentGet', input }),
        sendRaw: async input => {
          calls.push(`gmail:${account}:${GMAIL_LABEL.sendRaw}`);
          sent.push({ account, ...input });
          return { id: 'm-sent' };
        },
      };
    }),
    whatsapp: fakeWhatsAppTransport(calls, options.whatsapp),
    imsg: {
      request: async (method, params) => {
        calls.push(`imsg:${method}`);
        return method === 'messages.history' && options.imsgHistory ? options.imsgHistory(params) : imsgResponse(method, params);
      },
    },
    armLinkedInRecorder: async () => {
      calls.push('linkedin:arm');
      return { installed: true, recording: true };
    },
    // The adapter receives the page seam; this stub answers the typed reads directly.
    linkedInPage: {
      list: async () => {
        calls.push('linkedin:list');
        return {
          conversations: [{ id: LINKEDIN_ID, title: 'Ada Lovelace', preview: 'Hello from LinkedIn', date: 1_700_000_000_000, unread: true }],
          invitations: [{ id: LINKEDIN_INVITE, title: 'Grace Hopper', preview: 'A note with the invitation', date: 1_700_000_000_000, unread: true, sender: 'Grace Hopper', token: 'tok123', inviterProfileId: 'ACoAAAGRACE', firstName: 'Grace' }],
        };
      },
      thread: async () => {
        calls.push('linkedin:thread');
        return options.linkedInThread ? await options.linkedInThread() as { messages: unknown[] } : { messages: [{ sender: 'Ada', text: 'Hello from LinkedIn', date: 1_700_000_000_000, fromMe: false }] };
      },
      probe: async mailbox => {
        calls.push(mailbox ? `linkedin:probe@${mailbox}` : 'linkedin:probe');
        return { conversations: [{ at: 1_700_000_000_000, unread: 1 }], invitations: [] };
      },
      replay: async () => {
        calls.push('linkedin:write:replay');
        return { accepted: true, status: 200 };
      },
      recorded: async () => {
        calls.push('linkedin:write:dump');
        return { writes: [], seen: { fetch: 0, xhr: 0, considered: 0, skipped: {} } };
      },
      clearRecorded: async () => {
        calls.push('linkedin:write:clear');
      },
    },
    providerError: toProviderError,
  };
  return { cache, registry: createRegistry(deps), calls, sent, close: () => db.close() };
}

/** A refusal must reject and must not touch the source behind the adapter. */
export async function refused(calls: string[], run: () => Promise<unknown>, pattern: RegExp): Promise<void> {
  const before = calls.length;
  await assert.rejects(run, pattern);
  assert.deepEqual(calls.slice(before), [], 'a refused capability must not reach the source');
}
