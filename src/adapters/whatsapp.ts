// The WhatsApp adapter (plan U3). It owns the panel's shapes for WhatsApp — chat rows and their
// group previews, the message mapping with media and edits, the cached-thread repairs an older build
// needs, the reply, the read mark, and the media payload — and every fact behind them comes from
// `WhatsAppTransport`. The adapter therefore never learns whether an answer came from WhatsApp a
// second ago or from what the plugin's socket stored: a read works with the socket down, which is
// what plan D5 bought.
//
// What the old build did per refresh, and why none of it survives: each group row asked a second
// service for its preview sender, an open 1:1 asked again for its title, and media asked for a
// loopback URL. All three are stored rows here — the sender, the name and the cached bytes.
import { whatsappListUnchanged } from '../sync-plan.ts';
import { sourceAvatarUrl } from '../avatar-url.ts';
import { whatsappTimestamp } from '../timestamps.ts';
import { groupPreview, isWhatsAppNoise, isWhatsAppNoisePreview, whatsappSender, whatsappText, whatsappTitle } from '../whatsapp-chat.ts';
import { classifySendFailure } from '../whatsapp/failure.ts';
import { AUDIO_LIMIT, IMAGE_LIMIT, mediaDataUrl, SAVE_LIMIT, VIDEO_LIMIT } from './media.ts';
import { savedPayload } from '../media-save.ts';
import { canChange } from './capability.ts';
import type { RegistryDeps } from './deps.ts';
import type {
  ActionKind, ActionOptions, ActionResult, Adapter, Capabilities, Conversation, ListResult,
  MediaPayload, Message, OpenOptions, OpenResult, SearchRow, SourceDeclaration, SyncResult,
} from './types.ts';

const CAPABILITIES: Capabilities = { send: true, markRead: true, archive: false, invitations: false, media: true, attachments: false, threads: true, followsList: true };

/** WhatsApp rows are the only ones with group participants and legacy previews to repair. */
const ACCOUNT = 'whatsapp';

/** The messages one open asks for: enough to fill the panel, cheap because it is a local read. */
const OPEN_LIMIT = 60;

/**
 * WhatsApp's own composer refuses a body past 65,536 characters, counted in JavaScript string
 * units, which is how its web client counts them. The check sits here, before a dispatch, because a
 * ceiling the panel can name beats a rejection it has to explain afterwards: `decisions/0002` puts
 * a source's ceiling beside that source's adapter and measures what the service measures.
 */
const TEXT_LIMIT = 65_536;

/**
 * What a person knows WhatsApp by, and how the panel paces it. WhatsApp pages by row offset and a
 * page is a local read now, so its page is the whole page the panel asks for. An open chat is cheap
 * to re-read, so the panel watches it more often than it polls.
 */
const SOURCE: SourceDeclaration = { label: 'WhatsApp', icon: 'MessageCircle', pollIntervalMs: 8_000, watchIntervalMs: 5_000, pageSize: 50 };

export function createWhatsAppAdapter(deps: RegistryDeps): Adapter {
  const { cache } = deps;
  const transport = deps.whatsapp;
  let cacheMigrated = false;

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
      if (legacySender) {
        // A cached row that said "WhatsApp" meant "the sender was not known yet": in a group that is
        // a stranger, in a 1:1 it is the person the conversation is named after.
        const replacement = item.id.endsWith('@g.us') ? 'Unknown' : item.title;
        messages = messages.map(message => {
          if (message?.sender !== 'WhatsApp') return message;
          threadChanged = true;
          return { ...message, sender: replacement };
        });
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
   * One page of chats, newest activity first. `cursor` is the row offset the transport pages by, and
   * it answers one only when there is another page — so an empty next page is never mistaken for the
   * end of the list, and a full page is not mistaken for a further one.
   */
  async function listChats(cursor?: string, limit = SOURCE.pageSize ?? 50): Promise<{ items: Conversation[]; cursor?: string }> {
    const page = await transport.listChats({ ...(cursor ? { cursor } : {}), limit });
    return {
      items: page.chats.map(chat => {
        const preview = chat.preview && !isWhatsAppNoisePreview(chat.preview.text) ? chat.preview : undefined;
        const text = preview?.text ?? '';
        return {
          account: ACCOUNT,
          id: chat.jid,
          title: whatsappTitle(chat.name, chat.jid),
          preview: preview ? (chat.kind === 'group' ? groupPreview(text, preview.fromMe, preview.sender) : text) : '',
          date: whatsappTimestamp(chat.lastMsgAt),
          unread: chat.unread > 0,
        };
      }),
      ...(page.cursor ? { cursor: page.cursor } : {}),
    };
  }

  async function openChat(id: string): Promise<OpenResult> {
    const group = id.endsWith('@g.us');
    const messages: Message[] = (await transport.openChat({ id, limit: OPEN_LIMIT }))
      .filter(row => !isWhatsAppNoise(row.type, row.text))
      .map(row => ({
        sender: whatsappSender(row.fromMe, row.sender, group, ''),
        fromMe: row.fromMe,
        text: whatsappText(row.text, row.type, row.media),
        date: whatsappTimestamp(row.ts),
        ...(row.edited ? { edited: true } : {}),
        ...(row.media ? { media: row.media } : {}),
      }));
    cache.saveThread(ACCOUNT, id, messages);
    return { messages };
  }

  /** The ceiling a request is held to: what the panel will draw, or what may be saved to the disk. */
  function ceilingFor(kind: NonNullable<Message['media']>['kind']): number {
    if (kind === 'document') return SAVE_LIMIT;
    return kind === 'video' ? VIDEO_LIMIT : kind === 'audio' ? AUDIO_LIMIT : IMAGE_LIMIT;
  }

  function tooLarge(kind: NonNullable<Message['media']>['kind']): Error {
    if (kind === 'document') return new Error('This attachment is too large to save.');
    if (kind === 'audio') return new Error('This audio is too large to play here.');
    return new Error(kind === 'video' ? 'This video is too large to play here.' : 'This image is too large to show here.');
  }

  /**
   * The bytes behind one message: a picture, a video or a voice note is bounded by what the panel will
   * draw, a document by what may be saved to the disk, and a document is named by its own filename so the
   * saved file opens as the file it was sent as. A voice note is played whole — no range request, no
   * stream — because every one measured is a few hundred kilobytes or less (see `AUDIO_LIMIT`).
   *
   * A declared size over the ceiling is refused before the download, because a file nobody will keep
   * must not be fetched at all — a sender chooses its size, and `{dataDir}/media` is only ever emptied by
   * hand. The declared length is a hint and not a promise, so what lands is checked too, and bytes this
   * panel will refuse are taken back off the disk rather than left as a cache entry nothing reads.
   * A document under the save ceiling but over the inline one is not refused: it is written to the
   * owner's Downloads folder and answered with where it went.
   */
  async function mediaPayload(messageId: string): Promise<MediaPayload> {
    const facts = await transport.mediaFacts(messageId);
    if (!facts) throw new Error('This message has no media.');
    if (!facts.available) throw new Error('This media is no longer available.');
    const limit = ceilingFor(facts.kind);
    if (facts.size !== undefined && facts.size > limit) throw tooLarge(facts.kind);

    const { info, bytes, notConnected } = await transport.loadMedia(messageId);
    if (!info) throw new Error('This message has no media.');
    // WhatsApp refusing to serve a message is permanent; WhatsApp not being reachable is not, and
    // the owner can act on the second. Two different sentences, because they are two different facts.
    if (!info.available) throw new Error('This media is no longer available.');
    if (notConnected) throw new Error('WhatsApp is not connected, so this media cannot be fetched yet. Reconnect it and try again.');
    if (!info.cached || !bytes) throw new Error('This media could not be loaded.');
    if (bytes.byteLength > limit) {
      await transport.discardMedia(messageId);
      throw tooLarge(facts.kind);
    }
    if (info.kind === 'document') {
      return savedPayload(bytes, { mime: info.mime, filename: info.filename || 'WhatsApp document' });
    }
    if (!info.mime) throw new Error('This media could not be loaded.');
    return {
      dataUrl: mediaDataUrl(bytes, info.mime),
      mime: info.mime.split(';')[0].trim().toLowerCase(),
      ...(info.filename ? { filename: info.filename } : {}),
    };
  }

  /**
   * What the panel says about a reply that did not resolve (plan U5, R4). The three classes are
   * `src/whatsapp/failure.ts`'s, because only that module decides what a thrown send means; the
   * words are here because this is the layer the owner reads. The middle sentence is Gmail's,
   * worded for the phone the owner has to check instead of a Sent folder.
   */
  function sendFailure(error: unknown): Error {
    switch (classifySendFailure(error)) {
      case 'offline':
        return new Error('Nothing was sent: WhatsApp is not connected. Reconnect it and try again.');
      case 'terminal':
        // The class, never the provider's own text: a raw rejection can carry a payload back.
        return new Error('WhatsApp refused this message, and a repeat cannot change that. Nothing was sent; change it and try again.');
      case 'transient':
        return new Error('Send failed or its outcome is unknown. Check WhatsApp on your phone before trying again.');
    }
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
      return mediaPayload(request.id);
    },

    async action(kind: ActionKind, id: string, opts?: ActionOptions): Promise<ActionResult> {
      if (CAPABILITIES.send && kind === 'reply') {
        const draft = opts?.text?.trim();
        if (!draft) throw new Error('Sending needs the text to send.');
        // Refused before the socket, with the number in it: an over-long body would otherwise come
        // back as a rejection the panel could say nothing useful about.
        if (draft.length > TEXT_LIMIT) {
          throw new Error(`Nothing was sent: WhatsApp accepts a message up to ${TEXT_LIMIT} characters, and this one is ${draft.length}.`);
        }
        try {
          // One attempt per click, never a retry: a second attempt is a second message, and the
          // class the failure carries is how the panel tells "nothing left" from "may have".
          await transport.sendText({ id, text: draft });
        } catch (error) {
          throw sendFailure(error);
        }
        // The transport resolves only once WhatsApp accepted it, so this is not a guess.
        return { status: 'Sent.' };
      }
      if (canChange(CAPABILITIES, kind)) {
        if (kind === 'read') {
          cache.dropUnread(ACCOUNT, id);
          await transport.markRead({ id });
          return { status: 'Marked read.' };
        }
        cache.keepUnread(ACCOUNT, id);
        return { status: 'Marked unread.' };
      }
      throw new Error('This action is not supported for WhatsApp.');
    },

    /**
     * The row as the panel draws it: its group mosaic names, and its picture. The picture is a store
     * read (`transport.avatarUrl`), so a row whose face WhatsApp has not answered yet draws initials
     * now; the ask runs behind the draw and the next page has the URL. `src/avatar-url.ts` is the one
     * gate a URL passes before the panel may load it — applied here, not in the transport, so what is
     * stored stays what WhatsApp said.
     */
    decorate(item: Conversation): Conversation {
      const avatarUrl = sourceAvatarUrl(transport.avatarUrl(item.id), 'whatsapp');
      const group = item.id.endsWith('@g.us');
      return {
        ...item,
        ...(group ? { participants: participants(item.id) } : {}),
        ...(avatarUrl ? { avatarUrl } : {}),
      };
    },

    /**
     * What search can reach: every chat the store holds, with every message in it. Read from SQLite,
     * so the 5,000-odd messages past the newest page are searchable without a socket or a network
     * call — and a message a search matches is a row the panel can then open, because the corpus
     * carries the chat's own row too.
     */
    async searchCorpus(): Promise<SearchRow[]> {
      const rows = await transport.listCorpus();
      return rows.map(row => {
        const group = row.kind === 'group';
        // The same noise rule the list applies, so a protocol row or a "you were added" system
        // message never becomes a match nobody can act on.
        const kept = row.messages.filter(message => !isWhatsAppNoise(message.type, message.text));
        const last = kept.at(-1);
        return {
          item: {
            account: ACCOUNT,
            id: row.jid,
            title: whatsappTitle(row.name, row.jid),
            preview: last ? (group ? groupPreview(last.text, last.fromMe, last.sender) : last.text) : '',
            date: whatsappTimestamp(row.lastMsgAt),
            unread: row.unread > 0,
          },
          messages: kept.map(message => ({
            sender: whatsappSender(message.fromMe, message.sender, group, ''),
            fromMe: message.fromMe,
            text: whatsappText(message.text, message.type),
            date: whatsappTimestamp(message.ts),
          })),
        };
      });
    },

    async repairThread(id: string, messages: Message[]): Promise<Message[]> {
      let repaired = messages.filter(message => !isWhatsAppNoise('', String(message.text || '')));
      let changed = repaired.length !== messages.length;
      if (repaired.some(message => message.sender === 'WhatsApp')) {
        // Same repair as `migrateCache`, from the cache alone: the conversation's own title is the
        // best name a 1:1 thread cached before senders were named has.
        const replacement = id.endsWith('@g.us')
          ? 'Unknown'
          : (cache.list().find(item => item.account === ACCOUNT && item.id === id)?.title ?? 'Unknown');
        repaired = repaired.map(message => message.sender === 'WhatsApp' ? { ...message, sender: replacement } : message);
        changed = true;
      }
      if (changed) cache.saveThread(ACCOUNT, id, repaired, cache.threadUpdatedAt(ACCOUNT, id));
      return repaired;
    },
  };
}
