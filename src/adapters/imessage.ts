// Messages adapter (Migration state 3). It owns the imsg shapes: chats, history
// with attachment slots, the permitted mutations (`send` and `tapback`), the
// inbox read dot, and the attachment payload. Every other write stays refused
// by the client and by this adapter's capabilities.
import { IMSG_CHAT_LIMIT, findImsgAttachment, imsgChatId, mapImsgChats, mapImsgHistory } from '../imsg-mapping.ts';
import { readImsgImage } from '../imsg-media.ts';
import { sendImsgTapback, sendImsgText } from '../imsg-send.ts';
import { canChange } from './capability.ts';
import type { RegistryDeps } from './deps.ts';
import type {
  ActionKind, ActionOptions, ActionResult, Adapter, Capabilities, Conversation, ListResult, MediaPayload, Message, OpenOptions, OpenResult, SearchRow, SourceDeclaration, SyncResult,
} from './types.ts';
import type { MediaRequest } from './media.ts';

const CAPABILITIES: Capabilities = { send: true, markRead: true, archive: false, invitations: false, media: true, attachments: true, threads: true, followsList: true, react: true, reactRemove: true, quoteReply: true };

const ACCOUNT = 'imessage';

/**
 * What a person knows Messages by, and how the panel paces it: a local read, so it is watched too.
 * `chats.list` takes a `limit` and no offset, so a page is a slice of the whole chat database, and a
 * page is worth what the newest page is worth.
 */
const SOURCE: SourceDeclaration = { label: 'Messages', icon: 'messages', pollIntervalMs: 8_000, watchIntervalMs: 8_000, pageSize: 20 };

export function createIMessageAdapter(deps: RegistryDeps): Adapter {
  const { cache } = deps;

  /**
   * The whole chat database as of one read, and the read itself so two callers join one. The call
   * has no offset: paging and the search corpus are both slices of this, and the names it resolves
   * are the same ones the newest page already pays for.
   */
  let chatDatabase: Conversation[] | null = null;
  let reading: Promise<Conversation[]> | null = null;
  function wholeDatabase(): Promise<Conversation[]> {
    if (chatDatabase) return Promise.resolve(chatDatabase);
    reading ??= (async () => {
      try {
        const rows = paintReads(mapImsgChats(await deps.imsg.request('chats.list', { limit: IMSG_CHAT_LIMIT })) as Conversation[]);
        chatDatabase = rows;
        return rows;
      } finally { reading = null; }
    })();
    return reading;
  }

  async function history(id: string) {
    return deps.imsg.request('messages.history', { chat_id: imsgChatId(id), limit: 60, attachments: true });
  }

  /**
   * The date this inbox has already shown the owner. A read mark keeps the dot clear
   * until a chat comes back newer than that. Messages' own unread count stays as it is.
   */
  function readThrough(id: string): number {
    const cached = cache.list().find(row => row.account === ACCOUNT && row.id === id);
    if (cached && cached.date > 0) return cached.date;
    const listed = chatDatabase?.find(row => row.id === id);
    if (listed && listed.date > 0) return listed.date;
    return Date.now();
  }

  /** Keep a held chat read. A newer message drops the hold and shows the dot again. */
  function paintReads(items: Conversation[]): Conversation[] {
    const holds = new Map(cache.readHolds(ACCOUNT).map(row => [row.id, row.throughMs]));
    return items.map(item => {
      if (!holds.has(item.id)) return item;
      const through = holds.get(item.id);
      if (through != null && item.date > through) {
        cache.releaseRead(ACCOUNT, item.id);
        chatDatabase = null;
        return item;
      }
      return { ...item, unread: false };
    });
  }

  /**
   * The newest page, saved to the cache as it is read, and a cursor only when the source answered a
   * row past it — a full page is not a promise of more, and a cursor this adapter invented would page
   * a list that has nothing behind it.
   */
  async function newestPage(limit: number): Promise<{ items: Conversation[]; cursor?: string }> {
    const listed = mapImsgChats(await deps.imsg.request('chats.list', { limit: limit + 1 })) as Conversation[];
    const items = paintReads(listed.slice(0, limit));
    cache.save(ACCOUNT, items);
    return { items, ...(listed.length > limit ? { cursor: String(limit) } : {}) };
  }

  return {
    source: SOURCE,
    capabilities: () => CAPABILITIES,

    async list(cursor?: string, opts?: OpenOptions): Promise<ListResult> {
      const limit = opts?.limit ?? SOURCE.pageSize ?? 20;
      const offset = Number.parseInt(cursor ?? '0', 10) || 0;
      if (offset === 0) return { ...(await newestPage(limit)), errors: [] };
      // An older page is a read only: the cache holds the newest page, and a refresh replaces it
      // wholesale, so a second page written into it would vanish on the next sync.
      const rows = await wholeDatabase();
      const items = rows.slice(offset, offset + limit);
      const next = offset + items.length;
      return { items, errors: [], ...(next < rows.length ? { cursor: String(next) } : {}) };
    },

    async sync(opts?: OpenOptions): Promise<SyncResult> {
      return { ...(await newestPage(opts?.limit ?? SOURCE.pageSize ?? 20)), updatedAt: Date.now() };
    },

    /**
     * Every conversation in `chat.db`, for search: the whole list is one local read, which is what
     * makes a chat outside the newest page findable. The bodies are not read here — an open reads a
     * thread — so a search matches a conversation's name and what the cache already knows of it.
     */
    async searchCorpus(): Promise<SearchRow[]> {
      return (await wholeDatabase()).map(item => ({ item }));
    },

    async open(id: string, _opts?: OpenOptions): Promise<OpenResult> {
      const messages = mapImsgHistory(await history(id)) as Message[];
      cache.saveThread(ACCOUNT, id, messages);
      return { messages };
    },

    async media(request: MediaRequest): Promise<MediaPayload> {
      if (request.kind === 'message') throw new Error('A Messages attachment opens through its conversation, not by message id.');
      if (request.kind !== 'imsg') throw new Error('This account has no attachments.');
      const chat = imsgChatId(request.chatId);
      imsgChatId(request.messageId);
      const attachment = findImsgAttachment(await deps.imsg.request('messages.history', { chat_id: chat, limit: 60, attachments: true }), request.messageId, request.index);
      return readImsgImage(attachment.filename, attachment.mime);
    },

    async action(kind: ActionKind, id: string, opts?: ActionOptions): Promise<ActionResult> {
      if (canChange(CAPABILITIES, kind)) {
        if (kind === 'read') {
          // The next chats.list still reports Messages' unread count. Remember the chat
          // date so that refresh keeps the dot clear until a newer message arrives.
          cache.dropUnread(ACCOUNT, id);
          cache.holdRead(ACCOUNT, id, readThrough(id));
          chatDatabase = null;
          return { status: 'Marked read.' };
        }
        cache.releaseRead(ACCOUNT, id);
        cache.keepUnread(ACCOUNT, id);
        chatDatabase = null;
        return { status: 'Marked unread.' };
      }
      // A reaction is one tapback. A reply that names a message is the same send, with that guid.
      // A bridge refusal stops here: nothing is sent without the target.
      if (kind === 'react') return { status: await sendImsgTapback(deps.imsg, opts?.messageId ?? '', opts?.emoji ?? '', opts?.remove === true) };
      if (CAPABILITIES.send && kind === 'reply' && opts?.text?.trim()) return { status: await sendImsgText(deps.imsg, id, opts.text, opts.messageId) };
      throw new Error('This action is not supported for Messages.');
    },
  };
}
