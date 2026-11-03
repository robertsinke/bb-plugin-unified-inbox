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
import type { Account, Adapter } from '../../src/adapters/types.ts';


export const LINKEDIN_ID = 'urn:li:msg_conversation:(urn:li:fsd_profile:ACoAAAtest,2-abc)';

/** A pending invitation the read carries, with the params its answer needs. */
export const LINKEDIN_INVITE = 'urn:li:fs_relInvitation:12345';
export const WHATSAPP_ID = '15551234567@s.whatsapp.net';
/** A group chat: the composer endpoint accepts one, the agent's proposal tool does not. */
export const WHATSAPP_GROUP_ID = '120363413535442462@g.us';
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
        { name: 'To', value: 'robertsinke.jr@gmail.com' },
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

function gmailResponse(args: string[]): unknown {
  const resource = args[1];
  const action = args[2];
  if (resource === 'getProfile') return { historyId: '77' };
  if (resource === 'threads' && action === 'list') return { threads: [{ id: 't1', historyId: '77', snippet: 'See you at six' }] };
  if (resource === 'threads' && action === 'get') return GMAIL_THREAD;
  if (resource === 'threads' && action === 'modify') return {};
  if (resource === 'messages' && action === 'get') return GMAIL_MESSAGE_WITH_ATTACHMENT;
  throw new Error(`unexpected gws call: ${args.join(' ')}`);
}

function whatsappResponse(tool: string): unknown {
  if (tool === 'list-chats') {
    return { items: [{ jid: WHATSAPP_ID, name: 'Ada', preview: 'See you', last_msg_at: 1_700_000_000_000, unread: 2, kind: 'dm' }] };
  }
  if (tool === 'get-messages') {
    return { items: [{ id: 'm1', type: 'chat', text: 'See you', ts: 1_700_000_000_000, from_me: false, sender: { name: 'Ada' } }] };
  }
  if (tool === 'mark-read') return {};
  if (tool === 'propose-send') return { proposal_id: 7, proposal: { text: 'On my way' } };
  if (tool === 'reject-proposal') return {};
  if (tool === 'load-media') return { id: 'm1', type: 'image', media: { cached: true, mime: 'image/png' } };
  throw new Error(`unexpected WhatsAgent call: ${tool}`);
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
  gmailCall?: (account: Account, args: string[]) => unknown;
  linkedInThread?: () => Promise<unknown>;
  /** Replace one Messages history response, for attachment cases that need a real file name. */
  imsgHistory?: (params?: Record<string, unknown>) => unknown;
}

/** Registry wired to stubs; `calls` is the only record of source traffic. */
export function harness(options: HarnessOptions = {}): Harness {
  const db = new Database(':memory:');
  const cache = createInboxCache(db);
  const calls: string[] = [];
  const sent: Harness['sent'] = [];
  const deps: RegistryDeps = {
    cache,
    gmail: {
      call: async (account, args) => {
        const action = args[2] && !args[2].startsWith('--') ? `:${args[2]}` : '';
        calls.push(`gmail:${account}:${args[1]}${action}`);
        return options.gmailCall ? options.gmailCall(account, args) : gmailResponse(args);
      },
      send: async (account, message) => {
        calls.push(`gmail:${account}:send`);
        sent.push({ account, ...message });
        return { id: 'm-sent' };
      },
    },
    whatsapp: {
      call: async tool => { calls.push(`whatsapp:${tool}`); return whatsappResponse(tool); },
      runtime: async () => { calls.push('whatsapp:runtime'); return { baseUrl: 'http://whatsapp.test', token: 'test-token', port: 1 }; },
    },
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
