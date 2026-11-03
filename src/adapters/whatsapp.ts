// WhatsApp adapter (Migration state 3). It owns the WhatsAgent shapes: chat
// rows and their group previews, the message mapping with media and reactions,
// the cached-thread repairs an older build needs, the propose → confirm send
// flow, and the media payload.
import { sourceAvatarUrl } from '../avatar-url.ts';
import { whatsappListUnchanged } from '../sync-plan.ts';
import { whatsappTimestamp } from '../timestamps.ts';
import { groupPreview, isWhatsAppNoise, isWhatsAppNoisePreview, whatsappPhone, whatsappSender, whatsappTitle } from '../whatsapp-chat.ts';
import { composerSendRequest } from '../whatsapp-send.ts';
import { whatsAppMedia } from '../whatsapp-media.ts';
import { IMAGE_LIMIT, mediaDataUrl, VIDEO_LIMIT } from './media.ts';
import { canChange } from './capability.ts';
import type { RegistryDeps } from './deps.ts';
import type {
  ActionKind, ActionOptions, ActionResult, Adapter, Capabilities, Conversation, ListResult,
  MediaPayload, Message, OpenOptions, OpenResult, SourceDeclaration, SyncResult,
} from './types.ts';

const CAPABILITIES: Capabilities = { send: true, markRead: true, archive: false, invitations: false, media: true, attachments: false, threads: true, followsList: true };

/** WhatsApp rows are the only ones with group participants and legacy previews to repair. */
const ACCOUNT = 'whatsapp';

/**
 * What a person knows WhatsApp by, and how the panel paces it. WhatsApp pages by offset and
 * answers fifty chats in a second, so its page is the whole page `list-chats` was already asked
 * for. An open chat is cheap to re-read, so the panel watches it more often than it polls.
 */
const SOURCE: SourceDeclaration = { label: 'WhatsApp', icon: 'MessageCircle', pollIntervalMs: 8_000, watchIntervalMs: 5_000, pageSize: 50 };

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
      if (threadChanged) cache.saveThread(ACCOUNT, item.id, messages, cache.threadUpdatedAt(ACCOUNT, item.id));
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

  /**
   * One page of chats. `cursor` is the row offset `list-chats` pages by; WhatsAgent answers
   * `has_more`, so an empty next page is never mistaken for the end of the list.
   */
  async function listChats(cursor?: string, limit = SOURCE.pageSize ?? 50): Promise<{ items: Conversation[]; cursor?: string }> {
    const offset = Number.parseInt(cursor ?? '0', 10) || 0;
    const p = await wa('list-chats', { filter: 'all', limit, offset });
    const raw: any[] = p.items ?? [];
    const chats = raw.filter((c: any) => !c.archived).map((c: any) => ({ ...c, preview: isWhatsAppNoisePreview(String(c.preview || '')) ? '' : String(c.preview || '') }));
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
    return {
      items: chats.map((c: any) => {
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
      }),
      // The offset advances by the rows WhatsAgent returned, not by the rows kept: an archived
      // chat is filtered here, and skipping by the filtered count would re-read it every page.
      ...(p.has_more === true ? { cursor: String(offset + raw.length) } : {}),
    };
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

  /**
   * The owner's composer path: WhatsAgent enqueues the text to its paced outbox and answers 202
   * with the row. It accepts a group, which the agent's proposal tool does not (R8).
   */
  async function sendFromComposer(chatJid: string, text: string): Promise<void> {
    const { port } = await waRuntime();
    const request = composerSendRequest(port, chatJid, text);
    const response = await fetch(request.url, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: request.origin }, body: JSON.stringify(request.body) });
    const payload = await response.json().catch(() => ({})) as { error?: unknown };
    if (!response.ok) throw new Error(typeof payload.error === 'string' ? payload.error : 'WhatsApp did not accept the message. It has not been sent.');
  }

  /** The live WhatsApp list: the read, the cache migration it triggers, and the rows worth saving. */
  async function liveList(): Promise<{ items: Conversation[]; cursor?: string }> {
    const page = await listChats();
    await migrateCache();
    const previous = cache.list().filter(item => item.account === ACCOUNT);
    const previews = new Map(previous.map(item => [item.id, item.preview]));
    const items = page.items.map(item => {
      const kept = cache.keptUnread(ACCOUNT, item.id);
      return { ...item, preview: item.preview || previews.get(item.id) || '', ...(kept ? { unread: true } : {}) };
    });
    if (!whatsappListUnchanged(previous, items)) cache.save(ACCOUNT, items);
    return { items, ...(page.cursor ? { cursor: page.cursor } : {}) };
  }

  return {
    source: SOURCE,
    capabilities: () => CAPABILITIES,

    async list(cursor?: string, opts?: OpenOptions): Promise<ListResult> {
      // An older page is a read only: the cache holds the newest chats, and a refresh replaces
      // them wholesale, so a second page written into it would vanish on the next sync.
      if (cursor) return { ...(await listChats(cursor, opts?.limit)), errors: [] };
      return { ...(await liveList()), errors: [] };
    },

    async sync(_opts?: OpenOptions): Promise<SyncResult> {
      return { ...(await liveList()), updatedAt: Date.now() };
    },

    open: (id: string) => openChat(id),

    async media(request) {
      if (request.kind !== 'message') throw new Error('This account has no attachments.');
      return image(request.id);
    },

    async action(kind: ActionKind, id: string, opts?: ActionOptions): Promise<ActionResult> {
      if (CAPABILITIES.send && kind === 'reply') {
        const draft = opts?.text?.trim();
        if (!draft) throw new Error('Sending needs the text to send.');
        await sendFromComposer(id, draft);
        return { status: 'Sending.' };
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
      if (changed) cache.saveThread(ACCOUNT, id, repaired, cache.threadUpdatedAt(ACCOUNT, id));
      return repaired;
    },
  };
}
