// WhatsApp adapter (Migration state 3). It owns the WhatsAgent shapes: chat
// rows and their group previews, the message mapping with media and reactions,
// the cached-thread repairs an older build needs, the propose → confirm send
// flow, and the media payload.
import { sourceAvatarUrl } from '../avatar-url.ts';
import { whatsappListUnchanged } from '../sync-plan.ts';
import { whatsappTimestamp } from '../timestamps.ts';
import { groupPreview, isWhatsAppNoise, isWhatsAppNoisePreview, whatsappPhone, whatsappSender, whatsappTitle } from '../whatsapp-chat.ts';
import { approvalHash, confirmProposalRequest, latestInboundId } from '../whatsapp-confirm.ts';
import { IMAGE_LIMIT, mediaDataUrl, VIDEO_LIMIT, whatsAppMedia } from '../whatsapp-media.ts';
import { canChange } from './capability.ts';
import type { RegistryDeps } from './deps.ts';
import type {
  ActionKind, ActionOptions, ActionResult, Adapter, Capabilities, Conversation, ListResult,
  MediaPayload, Message, OpenOptions, OpenResult,
} from './types.ts';

const CAPABILITIES: Capabilities = { send: true, markRead: true, archive: false, media: true, attachments: false };

/** WhatsApp rows are the only ones with group participants and legacy previews to repair. */
const ACCOUNT = 'whatsapp';

export function createWhatsAppAdapter(deps: RegistryDeps): Adapter {
  const { cache } = deps;
  const wa = (tool: string, args: Record<string, unknown>) => deps.whatsapp.call(tool, args);
  const waRuntime = () => deps.whatsapp.runtime();
  const groupPreviewSenders = new Map<string, { signature: string; sender: string }>();
  const waChatTitles = new Map<string, string>();
  let cacheMigrated = false;

  /** The sender's name for a group preview, fetched at most once per preview signature. */
  async function previewSender(chat: any, runtime: { baseUrl: string; token: string }): Promise<string> {
    const jid = String(chat.jid);
    const signature = `${chat.last_msg_at}\0${chat.preview}`;
    const cached = groupPreviewSenders.get(jid);
    if (cached?.signature === signature) return cached.sender;
    try {
      const response = await fetch(`${runtime.baseUrl}/api/chats/${encodeURIComponent(jid)}/messages?limit=1`, { headers: { Authorization: `Bearer ${runtime.token}` }, signal: AbortSignal.timeout(1000) });
      if (!response.ok) return '';
      const payload = await response.json() as { items?: Array<{ from_me?: boolean; sender?: { name?: string; display_jid?: string } }> };
      const last = payload.items?.[0];
      const sender = last?.from_me ? 'You' : String(last?.sender?.name || whatsappPhone(String(last?.sender?.display_jid || '')) || '');
      if (sender) groupPreviewSenders.set(jid, { signature, sender });
      return sender;
    } catch { return ''; }
  }

  async function chatTitle(jid: string): Promise<string> {
    const known = waChatTitles.get(jid);
    if (known) return known;
    try {
      const { baseUrl, token } = await waRuntime();
      const response = await fetch(`${baseUrl}/api/chats/${encodeURIComponent(jid)}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(1000) });
      if (!response.ok) return '';
      const chat = await response.json() as { name?: string; display_jid?: string; jid?: string };
      const title = whatsappTitle(String(chat.name || ''), String(chat.display_jid || chat.jid || ''));
      if (title) waChatTitles.set(jid, title);
      return title;
    } catch { return ''; }
  }

  /** One-time repair of threads and previews cached before senders were named. */
  async function migrateCache(): Promise<void> {
    if (cacheMigrated) return;
    cacheMigrated = true;
    const items = cache.list();
    let previewChanged = false;
    for (const item of items) {
      if (item.account !== ACCOUNT) continue;
      const thread = cache.readThread(ACCOUNT, item.id);
      if (!Array.isArray(thread)) continue;
      let messages = thread as Array<{ sender?: string; text?: string; fromMe?: boolean }>;
      let threadChanged = false;
      const beforeNoise = messages.length;
      messages = messages.filter(message => !isWhatsAppNoise('', String(message?.text || '')));
      if (messages.length !== beforeNoise) threadChanged = true;
      const legacySender = messages.some(message => message?.sender === 'WhatsApp');
      if (legacySender && item.id.endsWith('@g.us')) {
        messages = messages.map(message => {
          if (message?.sender !== 'WhatsApp') return message;
          threadChanged = true;
          return { ...message, sender: 'Unknown' };
        });
      } else if (legacySender) {
        const title = waChatTitles.get(item.id) || await chatTitle(item.id);
        if (title) {
          messages = messages.map(message => {
            if (message?.sender !== 'WhatsApp') return message;
            threadChanged = true;
            return { ...message, sender: title };
          });
        }
      }
      if (isWhatsAppNoisePreview(item.preview)) {
        item.preview = '';
        previewChanged = true;
      }
      const last = [...messages].reverse().find(message => String(message?.text || '').trim());
      if (last) {
        const group = item.id.endsWith('@g.us');
        if (item.preview.startsWith('WhatsApp: ')) {
          item.preview = `${whatsappSender(!!last.fromMe, String(last.sender || ''), group, item.title)}: ${item.preview.slice('WhatsApp: '.length)}`;
          previewChanged = true;
        } else if (!item.preview) {
          item.preview = group
            ? groupPreview(String(last.text || ''), !!last.fromMe, whatsappSender(!!last.fromMe, String(last.sender || ''), true, item.title))
            : String(last.text || '');
          previewChanged = true;
        }
      }
      if (threadChanged) cache.saveThread(ACCOUNT, item.id, messages);
    }
    if (previewChanged) cache.save(ACCOUNT, items.filter(item => item.account === ACCOUNT));
  }

  /** The first few people who wrote in a group, newest first, for the avatar mosaic. */
  function participants(id: string): string[] {
    if (!id.endsWith('@g.us')) return [];
    const thread = cache.readThread(ACCOUNT, id);
    if (!Array.isArray(thread)) return [];
    const names: string[] = [];
    for (const raw of [...thread].reverse()) {
      const message = raw as { sender?: string; fromMe?: boolean; text?: string };
      if (message?.fromMe || isWhatsAppNoise('', String(message?.text || ''))) continue;
      const sender = String(message?.sender || '').trim();
      if (!sender || sender === 'You' || sender === 'Unknown' || sender === 'WhatsApp' || sender.includes('@')) continue;
      if (!names.includes(sender)) names.push(sender);
      if (names.length === 4) break;
    }
    return names;
  }

  async function listChats(): Promise<Conversation[]> {
    const p = await wa('list-chats', { filter: 'all', limit: 50 });
    const chats = (p.items ?? []).filter((c: any) => !c.archived).map((c: any) => ({ ...c, preview: isWhatsAppNoisePreview(String(c.preview || '')) ? '' : String(c.preview || '') }));
    for (const c of chats) waChatTitles.set(String(c.jid), whatsappTitle(String(c.name || ''), String(c.display_jid || c.jid || '')));
    const senders = new Map<string, string>();
    let runtime: { baseUrl: string; token: string } | undefined;
    try { runtime = await waRuntime(); } catch { /* group previews stay bare when the loopback API is unavailable */ }
    const groups = chats.filter((c: any) => c.kind === 'group' && c.preview && !c.preview_from_me);
    if (runtime) {
      const api = runtime;
      for (let index = 0; index < groups.length; index += 6) {
        await Promise.all(groups.slice(index, index + 6).map(async (c: any) => {
          const sender = await previewSender(c, api);
          if (sender) senders.set(String(c.jid), sender);
        }));
      }
    }
    return chats.map((c: any) => {
      const avatarUrl = sourceAvatarUrl(c.avatar_url, 'whatsapp');
      return {
        account: ACCOUNT,
        id: String(c.jid),
        title: String(c.name || c.display_jid || c.jid),
        preview: c.kind === 'group' ? groupPreview(String(c.preview || ''), c.preview_from_me === true, senders.get(String(c.jid)) || '') : String(c.preview || ''),
        date: whatsappTimestamp(c.last_msg_at),
        unread: Number(c.unread || 0) > 0,
        ...(avatarUrl ? { avatarUrl } : {}),
      };
    });
  }

  async function openChat(id: string): Promise<OpenResult> {
    const group = id.endsWith('@g.us');
    const [p, title] = await Promise.all([
      wa('get-messages', { chatJid: id, limit: 60 }),
      group ? Promise.resolve('') : chatTitle(id),
    ]);
    const messages: Message[] = (p.items ?? []).filter((m: any) => !isWhatsAppNoise(String(m.type || ''), String(m.text || ''))).map((m: any) => {
      const media = whatsAppMedia(m);
      return {
        sender: whatsappSender(!!m.from_me, String(m.sender?.name || whatsappPhone(String(m.sender?.display_jid || '')) || ''), group, title),
        fromMe: !!m.from_me,
        text: String(m.text || (media ? '' : m.type ? `[${m.type}]` : '')),
        date: whatsappTimestamp(m.ts),
        ...(m.edited ? { edited: true } : {}),
        ...(media ? { media } : {}),
      };
    });
    cache.saveThread(ACCOUNT, id, messages);
    return { messages };
  }

  async function image(messageId: string): Promise<MediaPayload> {
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

  /** WhatsAgent holds the approval: the reviewed hash and the latest inbound id travel with it. */
  async function confirm(proposalId: number, baseHash: string, inboundId: string | undefined): Promise<void> {
    const { port } = await waRuntime();
    const request = confirmProposalRequest(port, proposalId, baseHash, inboundId);
    const response = await fetch(request.url, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: request.origin }, body: JSON.stringify(request.body) });
    const payload = await response.json().catch(() => ({})) as { error?: unknown };
    if (!response.ok) throw new Error(typeof payload.error === 'string' ? payload.error : 'WhatsApp did not accept the confirmation. It has not been sent.');
  }

  return {
    capabilities: () => CAPABILITIES,

    async list(_cursor?: string, _opts?: OpenOptions): Promise<ListResult> {
      const listed = await listChats();
      await migrateCache();
      const previous = cache.list().filter(item => item.account === ACCOUNT);
      const previews = new Map(previous.map(item => [item.id, item.preview]));
      const items = listed.map(item => {
        const kept = cache.keptUnread(ACCOUNT, item.id);
        return { ...item, preview: item.preview || previews.get(item.id) || '', ...(kept ? { unread: true } : {}) };
      });
      if (!whatsappListUnchanged(previous, items)) cache.save(ACCOUNT, items);
      return { items, errors: [] };
    },

    open: (id: string) => openChat(id),

    media: (_account, id: string) => image(id),

    async action(kind: ActionKind, id: string, opts?: ActionOptions): Promise<ActionResult> {
      if (CAPABILITIES.send && kind === 'reply' && opts?.text?.trim()) {
        const proposed = await wa('propose-send', { chatJid: id, text: opts.text.trim() });
        const created = Number(proposed.proposal_id ?? proposed.proposal?.id);
        const proposalText = String(proposed.proposal?.text ?? opts.text.trim());
        if (!Number.isInteger(created) || created <= 0) throw new Error('WhatsAgent did not create a proposal. Nothing was sent.');
        return { status: 'Review this message before it sends.', proposalId: created, text: proposalText };
      }
      if (CAPABILITIES.send && kind === 'confirm' && opts?.proposalId && opts.text?.trim()) {
        try {
          const fresh = await wa('get-messages', { chatJid: id, limit: 30 });
          await confirm(opts.proposalId, approvalHash(opts.text), latestInboundId(fresh.items ?? []));
          return { status: 'Sending.' };
        } catch (cause) {
          await wa('reject-proposal', { id: opts.proposalId }).catch(() => undefined);
          throw cause instanceof Error ? cause : new Error('WhatsApp did not accept the confirmation. It has not been sent.');
        }
      }
      if (CAPABILITIES.send && kind === 'reject' && opts?.proposalId) {
        await wa('reject-proposal', { id: opts.proposalId }).catch(() => undefined);
        return { status: 'Not sent.' };
      }
      if (canChange(CAPABILITIES, kind)) {
        if (kind === 'read') {
          cache.dropUnread(ACCOUNT, id);
          await wa('mark-read', { chatJid: id });
          return { status: 'Marked read in WhatsAgent (no WhatsApp read receipt).' };
        }
        cache.keepUnread(ACCOUNT, id);
        return { status: 'Marked unread.' };
      }
      throw new Error('This action is not supported by WhatsAgent MCP.');
    },

    decorate(item: Conversation): Conversation {
      return item.id.endsWith('@g.us') ? { ...item, participants: participants(item.id) } : item;
    },

    async repairThread(id: string, messages: Message[]): Promise<Message[]> {
      let repaired = messages.filter(message => !isWhatsAppNoise('', String(message.text || '')));
      let changed = repaired.length !== messages.length;
      if (repaired.some(message => message.sender === 'WhatsApp')) {
        if (id.endsWith('@g.us')) {
          repaired = repaired.map(message => message.sender === 'WhatsApp' ? { ...message, sender: 'Unknown' } : message);
          changed = true;
        } else {
          const title = waChatTitles.get(id) || await chatTitle(id);
          if (title) {
            repaired = repaired.map(message => message.sender === 'WhatsApp' ? { ...message, sender: title } : message);
            changed = true;
          }
        }
      }
      if (changed) cache.saveThread(ACCOUNT, id, repaired);
      return repaired;
    },
  };
}
