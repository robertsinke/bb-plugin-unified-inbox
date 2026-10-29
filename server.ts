import { defineRpcContract, type BbPluginApi } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { buildGmailMime } from './src/gmail-mime';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { whatsappTimestamp } from './src/timestamps';
import { mailSenderName, replyRecipients } from './src/recipients';
import { createAsyncGate } from './src/async-gate';
import { createInboxCache } from './src/inbox-cache';
import { pickGmailBodies } from './src/gmail-body';
import { gmailCursorUnchanged, gmailIdsToFetch, whatsappListUnchanged } from './src/sync-plan';
import { approvalHash, confirmProposalRequest, latestInboundId } from './src/whatsapp-confirm';
import { bm25Rank, conversationText } from './src/bm25';
import { groupPreview } from './src/whatsapp-chat';
import { IMAGE_LIMIT, mediaDataUrl, VIDEO_LIMIT, whatsAppMedia } from './src/whatsapp-media';
import { ImsgClient } from './src/imsg-client';
import { findImsgAttachment, imsgChatId, mapImsgChats, mapImsgHistory } from './src/imsg-mapping';
import { readImsgImage } from './src/imsg-media';
import { existsSync } from 'node:fs';

const exec = promisify(execFile);
const account = z.enum(['personal', 'business', 'whatsapp', 'imessage']);
const item = z.object({ account, id: z.string(), title: z.string(), preview: z.string(), date: z.number(), unread: z.boolean(), sender: z.string().optional() });
const messageMedia = z.object({ messageId: z.string(), kind: z.enum(['image','sticker','video']), cached: z.boolean(), available: z.boolean(), mime: z.string().optional(), filename: z.string().optional(), size: z.number().positive().optional() });
const imsgAttachment = z.object({ index: z.number().int().nonnegative(), name: z.string(), available: z.boolean() });
const message = z.object({ edited: z.boolean().optional(), replyContext: z.boolean().optional(), imsgId: z.string().optional(), attachments: z.array(imsgAttachment).optional(), sender: z.string(), text: z.string(), date: z.number(), fromMe: z.boolean().optional(), html: z.string().max(800_000).optional(), to: z.string().optional(), cc: z.string().optional(), replyTo: z.string().optional(), subject: z.string().optional(), messageId: z.string().optional(), references: z.string().optional(), suggestedTo: z.string().optional(), suggestedCc: z.string().optional(), media: messageMedia.optional(), reactions: z.array(z.object({ sender: z.string(), label: z.string() })).optional() });
const header = z.string().max(2000).refine(v => !/[\r\n\0]/.test(v), 'Invalid header');
export const rpcContract = defineRpcContract({
  list: { input: z.null(), output: z.object({ items: z.array(item), errors: z.array(z.string()) }) },
  cached: { input: z.null(), output: z.object({ items: z.array(item) }) },
  search: { input: z.object({ query: z.string().max(200) }).strict(), output: z.object({ ids: z.array(z.object({ account, id: z.string(), score: z.number() })) }) },
  cached_open: { input: z.object({ account, id: z.string().min(1).max(512) }).strict(), output: z.object({ messages: z.array(message) }) },
  clear_cache: { input: z.null(), output: z.object({ cleared: z.boolean() }) },
  list_source: { input: z.object({ account, limit: z.number().int().min(1).max(20).optional() }).strict(), output: z.object({ items: z.array(item) }) },
  open: { input: z.object({ account, id: z.string().min(1).max(512) }).strict(), output: z.object({ messages: z.array(message) }) },
  media: { input: z.object({ messageId: z.string().min(1).max(512) }).strict(), output: z.object({ dataUrl: z.string(), mime: z.string(), filename: z.string().optional() }) },
  imsg_media: { input: z.object({ chatId: z.string().min(1).max(20), messageId: z.string().min(1).max(20), index: z.number().int().min(0).max(99) }).strict(), output: z.object({ dataUrl: z.string(), mime: z.string() }) },
  action: { input: z.object({ account, id: z.string().min(1).max(512), action: z.enum(['read','unread','archive','reply','confirm','reject']), text: z.string().max(20000).optional(), proposalId: z.number().int().positive().optional() }).strict(), output: z.object({ status: z.string(), proposalId: z.number().int().positive().optional(), text: z.string().optional() }) },
  send_gmail: { input: z.object({ account: z.enum(['personal','business']), to: header.min(1), cc: header, subject: header, text: z.string().min(1).max(100000), threadId: z.string().max(512).optional(), inReplyTo: header.optional(), references: header.optional() }).strict(), output: z.object({ status: z.string() }) },
});
type Account = z.infer<typeof account>;
const home = homedir();
const gmailGate = createAsyncGate();
async function gmail(a: Account, args: string[]) {
  return gmailGate(() => gmailNow(a, args));
}
async function gmailNow(a: Account, args: string[]) {
  if (a !== 'personal' && a !== 'business') throw new Error('Not a Gmail account');
  const config = a === 'business' ? join(home, '.config/gws-inhouse') : join(home, '.config/gws');
  try {
    const { stdout } = await exec('/usr/local/bin/gws', ['gmail', ...args], { env: { ...process.env, GOOGLE_WORKSPACE_CLI_CONFIG_DIR: config }, timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
    return JSON.parse(stdout);
  } catch (cause) {
    const error = cause as NodeJS.ErrnoException & { stderr?: string; stdout?: string };
    const code = error.code;
    const diagnostic = `${error.stderr ?? ''} ${error.stdout ?? ''}`;
    const hints = ['keyring', 'keychain', 'locked', 'interaction', 'denied', 'no such file', 'credentials', 'resource temporarily unavailable', 'token', 'discovery', 'timeout', 'not found', 'panic', 'broken pipe'].filter(word => diagnostic.toLowerCase().includes(word));
    throw new Error(`Gmail ${a} request failed (${typeof code === 'string' || typeof code === 'number' ? code : 'invalid response'}${hints.length ? `; ${hints.join(', ')}` : ''}).`);
  }
}
const waGate = createAsyncGate();
const waMediaGate = createAsyncGate();
const groupPreviewSenders = new Map<string, { signature: string; sender: string }>();
let waReady: Promise<Client> | null = null;
async function waClient() {
  if (!waReady) {
    waReady = (async () => {
      let runtime: any;
      try {
        runtime = JSON.parse(await readFile(join(home, 'Library/Application Support/whatsagent-desktop/mcp-runtime.json'), 'utf8'));
        if (!Number.isSafeInteger(runtime.pid) || runtime.pid <= 0) throw new Error('invalid pid');
        process.kill(runtime.pid, 0);
      } catch {
        throw new Error('WhatsAgent backend is unavailable. Check the existing com.robert.whatsagent-headless launch agent; the inbox will not start another connection.');
      }
      const url = new URL(runtime.url);
      if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.pathname !== '/mcp' || typeof runtime.token !== 'string') throw new Error('Invalid WhatsAgent connection');
      const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${runtime.token}` } } });
      const client = new Client({ name: 'bb-unified-inbox', version: '0.1.0' });
      await client.connect(transport);
      return client;
    })().catch(error => { waReady = null; throw error; });
  }
  return waReady;
}
async function wa(name: string, args: Record<string, unknown>): Promise<any> {
  const gate = name === 'load-media' ? waMediaGate : waGate;
  return gate(async () => {
    try {
      const client = await waClient();
      const result = await client.callTool({ name, arguments: args });
      if (result.isError) throw new Error('WhatsAgent rejected the request');
      const text = Array.isArray(result.content) ? result.content.find((x: any) => x.type === 'text') as any : null;
      if (!text || typeof text.text !== 'string') throw new Error('Unexpected WhatsAgent response');
      return JSON.parse(text.text);
    } catch (error) {
      waReady = null;
      throw error;
    }
  });
}
function headers(m: any) { return Object.fromEntries((m?.payload?.headers ?? []).map((h: any) => [String(h.name).toLowerCase(), h.value])); }
function plain(payload: any): string {
  if (payload?.mimeType === 'text/plain' && payload.body?.data) return Buffer.from(payload.body.data, 'base64url').toString('utf8');
  for (const part of payload?.parts ?? []) { const text = plain(part); if (text) return text; }
  return '';
}
const HTML_LIMIT = 800_000;
async function messageHtml(a: Account, messageId: string, payload: unknown) {
  const bodies = pickGmailBodies(payload as Parameters<typeof pickGmailBodies>[0]);
  let html = bodies.html;
  const size = bodies.htmlAttachmentSize ?? 0;
  if (!html && bodies.htmlAttachmentId && (size === 0 || size <= HTML_LIMIT)) {
    try {
      const attachment = await gmail(a, ['users', 'messages', 'attachments', 'get', '--params', JSON.stringify({ userId: 'me', messageId, id: bodies.htmlAttachmentId })]);
      if (typeof attachment?.data === 'string') html = Buffer.from(attachment.data, 'base64url').toString('utf8');
    } catch { html = ''; }
  }
  if (!html || html.length > HTML_LIMIT) return undefined;
  return html;
}
async function thread(a: Account, id: string) { return gmail(a, ['users','threads','get','--params',JSON.stringify({ userId: 'me', id, format: 'full' })]); }
function gmailItem(a: Extract<Account, 'personal' | 'business'>, t: any) {
  const ms = t.messages ?? []; const last = ms.at(-1) ?? {}; const h = headers(last);
  return { account:a, id:String(t.id), title:String(h.subject || '(no subject)'), sender:mailSenderName(String(h.from || '')), preview:String(last.snippet || t.snippet || ''), date:Number(last.internalDate || 0), unread:ms.some((m:any) => m.labelIds?.includes('UNREAD')) };
}
async function listGmail(a: Extract<Account, 'personal' | 'business'>, limit = 20, cache?: ReturnType<typeof createInboxCache>) {
  const stored = () => (cache?.list() ?? []).filter(item => item.account === a);
  let historyId = '';
  try {
    const profile = await gmail(a, ['users','getProfile','--params',JSON.stringify({ userId:'me' })]);
    historyId = String(profile.historyId ?? '');
  } catch (error) {
    const fallback = stored().slice(0, limit);
    if (fallback.length) return fallback;
    throw error;
  }
  const storedItems = stored();
  if (cache && gmailCursorUnchanged(cache.cursor(a), historyId) && storedItems.length && storedItems.slice(0, limit).every(item => item.sender && item.preview)) return storedItems.slice(0, limit);
  const page = await gmail(a, ['users','threads','list','--params',JSON.stringify({ userId:'me', labelIds:['INBOX'], maxResults:limit })]);
  const listed = (page.threads ?? []).map((entry: any) => ({ id: String(entry.id), historyId: String(entry.historyId ?? ''), snippet: String(entry.snippet ?? '') }));
  const changed = new Set<string>(cache ? gmailIdsToFetch(cache.revisions(a), listed) : listed.map((entry: { id: string }) => entry.id));
  for (const entry of listed) {
    const known = storedItems.find(item => item.id === entry.id);
    if (known && !known.sender) changed.add(entry.id);
  }
  const fetched = new Map<string, ReturnType<typeof gmailItem>>();
  for (const id of changed) fetched.set(id, gmailItem(a, await thread(a, id)));
  const previous = new Map(stored().map(item => [item.id, item]));
  const items = listed.flatMap((entry: { id: string; snippet: string }) => {
    const item = fetched.get(entry.id) ?? previous.get(entry.id);
    if (!item) return [];
    const preview = item.preview || entry.snippet;
    return [preview === item.preview ? item : { ...item, preview }];
  });
  cache?.save(a, items);
  cache?.saveRevisions(a, listed.map((entry: { id: string; historyId: string; snippet: string }) => ({ id: entry.id, historyId: entry.historyId, preview: entry.snippet })));
  if (cache && historyId) cache.setCursor(a, historyId);
  return items.slice(0, limit);
}
async function waPreviewSender(chat: any, runtime: { baseUrl: string; token: string }): Promise<string> {
  const jid = String(chat.jid);
  const signature = `${chat.last_msg_at}\0${chat.preview}`;
  const cached = groupPreviewSenders.get(jid);
  if (cached?.signature === signature) return cached.sender;
  try {
    const response = await fetch(`${runtime.baseUrl}/api/chats/${encodeURIComponent(jid)}/messages?limit=1`, { headers: { Authorization: `Bearer ${runtime.token}` }, signal: AbortSignal.timeout(1000) });
    if (!response.ok) return '';
    const payload = await response.json() as { items?: Array<{ from_me?: boolean; sender?: { name?: string; display_jid?: string } }> };
    const last = payload.items?.[0];
    const sender = last?.from_me ? 'You' : String(last?.sender?.name || last?.sender?.display_jid || '');
    if (sender) groupPreviewSenders.set(jid, { signature, sender });
    return sender;
  } catch { return ''; }
}
async function listWa() {
  const p = await wa('list-chats', { filter:'all', limit:50 });
  const chats = (p.items ?? []).filter((c:any) => !c.archived);
  const senders = new Map<string, string>();
  let runtime: { baseUrl: string; token: string } | undefined;
  try { runtime = await waRuntime(); } catch { /* group previews stay bare when the loopback API is unavailable */ }
  const groups = chats.filter((c:any) => c.kind === 'group' && c.preview && !c.preview_from_me);
  if (runtime) {
    const api = runtime;
    for (let index = 0; index < groups.length; index += 6) {
      await Promise.all(groups.slice(index, index + 6).map(async (c:any) => {
        const sender = await waPreviewSender(c, api);
        if (sender) senders.set(String(c.jid), sender);
      }));
    }
  }
  return chats.map((c:any) => ({
    account:'whatsapp' as const,
    id:String(c.jid),
    title:String(c.name || c.display_jid || c.jid),
    preview: c.kind === 'group' ? groupPreview(String(c.preview || ''), c.preview_from_me === true, senders.get(String(c.jid)) || '') : String(c.preview || ''),
    date:whatsappTimestamp(c.last_msg_at),
    unread:Number(c.unread || 0) > 0,
  }));
}
async function waRuntime() {
  const runtime = JSON.parse(await readFile(join(home, 'Library/Application Support/whatsagent-desktop/mcp-runtime.json'), 'utf8'));
  let url: URL;
  try { url = new URL(String(runtime.url)); } catch { throw new Error('Invalid WhatsAgent connection'); }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.pathname !== '/mcp' || typeof runtime.token !== 'string' || !runtime.token) throw new Error('Invalid WhatsAgent connection');
  const port = Number(url.port || 80);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid WhatsAgent connection');
  return { baseUrl: url.origin, token: runtime.token, port };
}
async function waImage(messageId: string) {
  const loaded = await wa('load-media', { messageId });
  const info = whatsAppMedia(loaded);
  if (!info) throw new Error('This message has no image or video.');
  if (!info.available) throw new Error('This media is no longer available.');
  if (!info.cached) throw new Error('This media could not be loaded.');
  const limit = info.kind === 'video' ? VIDEO_LIMIT : IMAGE_LIMIT;
  const { baseUrl, token } = await waRuntime();
  const response = await fetch(`${baseUrl}/api/messages/${encodeURIComponent(messageId)}/media`, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error('Could not read this media.');
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > limit) throw new Error(info.kind === 'video' ? 'This video is too large to play here.' : 'This image is too large to show here.');
  const bytes = new Uint8Array(await response.arrayBuffer());
  const mime = response.headers.get('content-type') ?? info.mime ?? '';
  return { dataUrl: mediaDataUrl(bytes, mime), mime: mime.split(';')[0].trim().toLowerCase(), ...(info.filename ? { filename: info.filename } : {}) };
}
async function confirmInWhatsAgent(proposalId: number, baseHash: string, inboundId: string | undefined) {
  const { port } = await waRuntime();
  const request = confirmProposalRequest(port, proposalId, baseHash, inboundId);
  const response = await fetch(request.url, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: request.origin }, body: JSON.stringify(request.body) });
  const payload = await response.json().catch(() => ({})) as { error?: unknown };
  if (!response.ok) throw new Error(typeof payload.error === 'string' ? payload.error : 'WhatsApp did not accept the confirmation. It has not been sent.');
}
export default function plugin(bb: BbPluginApi) {
  const db = bb.storage.database();
  db.exec('CREATE TABLE IF NOT EXISTS inbox_cache (account TEXT NOT NULL, id TEXT NOT NULL, title TEXT NOT NULL, preview TEXT NOT NULL, date INTEGER NOT NULL, unread INTEGER NOT NULL, PRIMARY KEY(account,id))');
  const cache = createInboxCache(db);
  const imsgPath = [join(home, '.local/bin/imsg'), '/opt/homebrew/bin/imsg', '/usr/local/bin/imsg'].find(path => existsSync(path)) ?? 'imsg';
  const imsg = new ImsgClient(imsgPath);
  bb.onDispose(() => imsg.dispose());
  async function listImsg(limit = 20) {
    const items = mapImsgChats(await imsg.request('chats.list', { limit }));
    cache.save('imessage', items);
    return items;
  }
  bb.rpc.register(rpcContract, {
    cached() { return {items: cache.list()}; },
    search({ query }) {
      const items = cache.list();
      const ranked = bm25Rank(query, items.map(item => ({
        id: `${item.account}\u0000${item.id}`,
        text: conversationText({ title: [item.sender, item.title].filter(Boolean).join('\n'), preview: item.preview, messages: cache.readThread(item.account, item.id) ?? [] }),
      })));
      return { ids: ranked.slice(0, 50).flatMap(row => {
        const split = row.id.indexOf('\u0000');
        const name = row.id.slice(0, split);
        if (name !== 'personal' && name !== 'business' && name !== 'whatsapp' && name !== 'imessage') return [];
        const accountName: Account = name;
        return [{ account: accountName, id: row.id.slice(split + 1), score: row.score }];
      }) };
    },
    cached_open({ account, id }) {
      const parsed = z.array(message).safeParse(cache.readThread(account, id) ?? []);
      return { messages: parsed.success ? parsed.data : [] };
    },
    clear_cache() { cache.clear(); return {cleared: true}; },
    async list_source({ account, limit }) {
      if (account === 'imessage') return { items: await listImsg(limit ?? 20) };
      if (account === 'whatsapp') {
        const items = (await listWa()).map((item: { account: 'whatsapp'; id: string; unread: boolean }) => cache.keptUnread(item.account, item.id) ? { ...item, unread: true } : item);
        const previous = cache.list().filter(item => item.account === 'whatsapp');
        if (!whatsappListUnchanged(previous, items)) cache.save('whatsapp', items);
        return {items};
      }
      return { items: await listGmail(account, limit ?? 20, cache) };
    },
    async list() {
      const results = await Promise.allSettled([listGmail('personal', 20, cache), listGmail('business', 20, cache), listWa(), listImsg()]);
      const names = ['Personal Gmail','Business Gmail','WhatsApp','Messages']; const errors:string[] = []; const items:any[] = [];
      results.forEach((r,i) => {
        if (r.status === 'fulfilled') items.push(...r.value);
        else if (r.reason instanceof Error && (r.reason.message.startsWith('WhatsAgent backend is unavailable.') || r.reason.message.startsWith('Gmail '))) errors.push(r.reason.message);
        else errors.push(`${names[i]} unavailable. Check its connection.`);
      });
      return { items: items.sort((a,b) => b.date-a.date), errors };
    },
    async media({ messageId }) { return waImage(messageId); },
    async imsg_media({ chatId, messageId, index }) {
      const chat = imsgChatId(chatId);
      imsgChatId(messageId);
      const history = await imsg.request('messages.history', { chat_id: chat, limit: 60, attachments: true });
      const attachment = findImsgAttachment(history, messageId, index);
      return readImsgImage(attachment.filename, attachment.mime);
    },
    async open({account,id}) {
      if (account === 'imessage') {
        const messages = mapImsgHistory(await imsg.request('messages.history', { chat_id: imsgChatId(id), limit: 60, attachments: true }));
        cache.saveThread(account, id, messages);
        return { messages };
      }
      if (account === 'whatsapp') {
        const p = await wa('get-messages',{chatJid:id,limit:60});
        const messages = (p.items ?? []).map((m:any) => {
          const media = whatsAppMedia(m);
          return { sender:m.from_me ? 'You' : String(m.sender?.name || 'WhatsApp'), fromMe:!!m.from_me, text:String(m.text || (media ? '' : m.type ? `[${m.type}]` : '')), date:whatsappTimestamp(m.ts), ...(media ? { media } : {}) };
        });
        cache.saveThread(account, id, messages);
        return { messages };
      }
      const remembered = z.array(message).safeParse(cache.readThread(account, id) ?? []);
      if (remembered.success && remembered.data.length) {
        try {
          const profile = await gmail(account, ['users','getProfile','--params',JSON.stringify({ userId:'me' })]);
          if (gmailCursorUnchanged(cache.cursor(account), String(profile.historyId ?? ''))) return { messages: remembered.data };
        } catch { /* a full thread read still answers the open */ }
      }
      const t = await thread(account,id);
      const messages = await Promise.all((t.messages ?? []).map(async (m: any) => {
        const h = headers(m); const sender=String(h.from || ''), to=String(h.to || ''), cc=String(h.cc || ''), replyTo=String(h['reply-to'] || '');
        const suggested=replyRecipients({from:sender,to,cc,replyTo,self:account==='business'?'work@example.com':'personal@example.com'});
        const html = await messageHtml(account, String(m.id), m.payload);
        return {sender, text:plain(m.payload) || String(m.snippet || ''), date:Number(m.internalDate || 0), ...(html ? { html } : {}), to, cc, replyTo, subject:String(h.subject || ''), messageId:String(h['message-id'] || ''), references:String(h.references || ''), suggestedTo:suggested.to, suggestedCc:suggested.cc};
      }));
      cache.saveThread(account, id, messages);
      return { messages };
    },
    async send_gmail(input) {
      // Disabled until the BB owner-confirmation boundary is verified; RPC is agent-callable.
      const sendingVerified = false;
      if (!sendingVerified) throw new Error('Gmail sending is not enabled yet. Your draft has not been sent.');
      const dir = await mkdtemp(join(tmpdir(), 'bb-inbox-mail-'));
      const file = join(dir, 'message.eml');
      try {
        const sender = input.account === 'business' ? 'work@example.com' : 'personal@example.com';
        const raw = await buildGmailMime({ from: sender, to: input.to, cc: input.cc, subject: input.subject, text: input.text, inReplyTo: input.inReplyTo, references: input.references });
        await writeFile(file, raw, { mode: 0o600 });
        const config = input.account === 'business' ? join(home, '.config/gws-inhouse') : join(home, '.config/gws');
        // The message body stays in a private temporary file, not process arguments.
        const { stdout } = await exec('/usr/local/bin/gws', ['gmail','users','messages','send','--params',JSON.stringify({userId:'me'}),'--json',JSON.stringify(input.threadId ? {threadId: input.threadId} : {}),'--upload','message.eml','--upload-content-type','message/rfc822'], { cwd: dir, env: {...process.env, GOOGLE_WORKSPACE_CLI_CONFIG_DIR: config}, timeout:30000, maxBuffer:1024*1024 });
        const response = JSON.parse(stdout);
        if (typeof response.id !== 'string' || !response.id) throw new Error('Send result missing message ID');
        return {status:'Sent.'};
      } catch {
        throw new Error('Send failed or its outcome is unknown. Check Gmail Sent before trying again.');
      } finally { await rm(dir, {recursive:true,force:true}); }
    },
    async action({account,id,action,text,proposalId}) {
      if (account === 'imessage') throw new Error('Messages actions are not enabled.');
      if (account === 'whatsapp') {
        if (action === 'read') { cache.dropUnread(account, id); await wa('mark-read',{chatJid:id}); return {status:'Marked read in WhatsAgent (no WhatsApp read receipt).'}; }
        if (action === 'unread') { cache.keepUnread(account, id); return {status:'Marked unread.'}; }
        if (action === 'reject' && proposalId) {
          await wa('reject-proposal', { id: proposalId }).catch(() => undefined);
          return { status: 'Not sent.' };
        }
        if (action === 'reply' && text?.trim()) {
          const proposed = await wa('propose-send',{chatJid:id,text:text.trim()});
          const created = Number(proposed.proposal_id ?? proposed.proposal?.id);
          const proposalText = String(proposed.proposal?.text ?? text.trim());
          if (!Number.isInteger(created) || created <= 0) throw new Error('WhatsAgent did not create a proposal. Nothing was sent.');
          return { status: 'Review this message before it sends.', proposalId: created, text: proposalText };
        }
        if (action === 'confirm' && proposalId && text?.trim()) {
          const hash = approvalHash(text);
          try {
            const fresh = await wa('get-messages', { chatJid: id, limit: 30 });
            await confirmInWhatsAgent(proposalId, hash, latestInboundId(fresh.items ?? []));
            return { status: 'Sending.' };
          } catch (cause) {
            await wa('reject-proposal', { id: proposalId }).catch(() => undefined);
            throw cause instanceof Error ? cause : new Error('WhatsApp did not accept the confirmation. It has not been sent.');
          }
        }
        throw new Error('This action is not supported by WhatsAgent MCP.');
      }
      if (action !== 'read' && action !== 'unread' && action !== 'archive') throw new Error('This action is not supported.');
      const body = action === 'archive' ? {removeLabelIds:['INBOX']} : action === 'read' ? {removeLabelIds:['UNREAD']} : {addLabelIds:['UNREAD']};
      await gmail(account,['users','threads','modify','--params',JSON.stringify({userId:'me',id}),'--json',JSON.stringify(body)]);
      return {status: action === 'archive' ? 'Archived.' : 'Updated.'};
    },
  });
}
