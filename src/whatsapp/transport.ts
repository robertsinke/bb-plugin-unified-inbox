// What answers a WhatsApp read (plan U3).
//
// The adapter asks this, not a socket: the store holds what arrived, so a read works with the socket
// down and answers the same way whichever path put the row there. Three decisions live here and
// nowhere else:
//   - a chat's name, preview and unread count, because only the store knows the newest stored row
//     and where reading stopped;
//   - a sender's display name, because only the store can turn a jid into an address-book name, a
//     push name or a phone number;
//   - what a media request gets: the bytes when they are cached, one download through the socket when
//     they are not, and a report — never a throw and never a wait — when neither is possible.
//
// The socket is asked only where a live WhatsApp is the point: a send, and a read receipt beside the
// recorded cursor. A read that finds no socket is not a failure — that is the whole reason the store
// exists.
import { randomBytes } from 'node:crypto';
import type {
  WhatsAppChatRow,
  WhatsAppMediaAnswer,
  WhatsAppMessageRow,
  WhatsAppTransport,
  WhatsAppTransportStatus,
} from '../adapters/types.ts';
import type { WhatsAppConnection, WhatsAppMediaSocket } from './connection.ts';
import { createWhatsAppAvatars } from './avatars.ts';
import type { MediaDownloader } from './media.ts';
import { createWhatsAppSendTransport } from './send.ts';
import { usableName, type Message, type WhatsAppStore } from './store.ts';
import { whatsappPhone, whatsappText } from '../whatsapp-chat.ts';
import { whatsAppMedia } from '../whatsapp-media.ts';

export type WhatsAppTransportOptions = {
  store: WhatsAppStore;
  /**
   * The socket, when the plugin has one open. Absent is a state, not an error: the store still
   * answers reads, and only a send or a receipt has nowhere to go.
   */
  connection: () => WhatsAppConnection | undefined;
  /**
   * How a call that needs a socket asks for one: the lifecycle opens a linked account on demand and
   * answers `undefined` when the open was refused. A read never pays for this; a download and a send do.
   */
  ensure: () => Promise<WhatsAppConnection | undefined>;
  /** Where cached media bytes live; defaults to the plugin data dir (`src/whatsapp/media.ts`). */
  dataDir?: string;
  /** Injected for tests; defaults to Baileys' `downloadMediaMessage` (`src/whatsapp/media.ts`). */
  download?: MediaDownloader;
};

/** Baileys' own shape for a message id: uppercase, no separators, unique per device. */
function newMessageId(): string {
  return randomBytes(16).toString('hex').toUpperCase();
}

export function createWhatsAppTransport(options: WhatsAppTransportOptions): WhatsAppTransport {
  const { store, connection } = options;
  /**
   * The connection a call opened for itself. The lifecycle's `current()` knows about it in the same
   * instant, but the answer of an open is what this call is holding, so it keeps it rather than
   * asking a getter that may not have caught up.
   */
  let ensured: WhatsAppConnection | undefined;
  /** The connection the plugin has: the one this module can see, or one a call that needed it opened. */
  const held = () => connection() ?? ensured;
  const send = createWhatsAppSendTransport(() => held()?.getSendSocket());
  // Pictures answer from the store on the draw and are asked for afterwards, so this seam stays a
  // read: a list never waits on WhatsApp for a face (INBOX-29, `src/whatsapp/avatars.ts`).
  const avatars = createWhatsAppAvatars({ store, socket: () => held()?.getAvatarSocket() });

  /** Opens one for a call that needs a socket; the refusal is the lifecycle's to keep and to word. */
  async function ensureConnection(): Promise<WhatsAppConnection | undefined> {
    ensured = await options.ensure();
    return ensured;
  }

  /** The name to show for a jid: the address book first, then the name they chose for themselves. */
  function contactName(jid: string): string {
    const contact = store.getContact(jid);
    return usableName(contact?.name) ?? usableName(contact?.push_name) ?? '';
  }

  /**
   * Who wrote a stored row, in words the panel can draw. Never the chat's own title.
   *
   * A 1:1 row whose sender was stored blank is still the other person: that is the chat jid.
   * A group has many senders, so a blank one stays blank.
   */
  function senderName(sender: string | null, chatJid: string): string {
    const stored = sender?.trim() ?? '';
    if (stored === 'me') return '';
    const jid = stored || (chatJid.endsWith('@g.us') ? '' : chatJid);
    if (!jid) return '';
    return contactName(jid) || whatsappPhone(jid);
  }

  function previewOf(message: Message): NonNullable<WhatsAppChatRow['preview']> {
    return {
      text: whatsappText(message.text ?? '', message.type, whatsAppMedia(message)),
      fromMe: message.from_me,
      sender: senderName(message.sender, message.chat_jid),
    };
  }

  /**
   * The media facts of one stored row: the descriptor the row itself carries, plus the facts that exist
   * only inside its envelope — a document's name, size and type, a voice note's length and type. The
   * unwrapper is the media module's (the one that already unpacks a document to download it), so it is
   * loaded the same lazy way and not at all for the kinds this module writes as files of a known type.
   */
  async function factsOf(row: Message): Promise<ReturnType<typeof whatsAppMedia>> {
    const facts = whatsAppMedia(row);
    if (!facts || (row.type !== 'document' && row.type !== 'audio')) return facts;
    const { audioFacts, documentFacts } = await import('./media.ts');
    return whatsAppMedia(row, row.type === 'document' ? documentFacts(row.raw) : audioFacts(row.raw));
  }

  /** The re-upload call a download needs: the open socket, or one opened now for a linked account. */
  async function mediaSocket(): Promise<WhatsAppMediaSocket | undefined> {
    const ready = held()?.getMediaSocket();
    if (ready) return ready;
    // The lifecycle is single-flight, so a burst of media asks joins one open rather than racing it.
    return (await ensureConnection())?.getMediaSocket();
  }

  return {
    async listChats({ cursor, limit }) {
      const offset = Number.parseInt(cursor ?? '0', 10) || 0;
      // One row past the page says whether there is another without a second query — and without
      // guessing from a full page, which would offer an empty one at the end.
      const rows = store.listChats({ offset, limit: limit + 1 });
      const page = rows.length > limit ? rows.slice(0, limit) : rows;
      return {
        chats: page.map(({ chat, last, unread }) => ({
          jid: chat.jid,
          name: chat.name ?? contactName(chat.jid),
          kind: chat.kind,
          lastMsgAt: chat.last_msg_at,
          unread,
          ...(last ? { preview: previewOf(last) } : {}),
        })),
        ...(rows.length > limit ? { cursor: String(offset + page.length) } : {}),
      };
    },

    /**
     * The whole store as a corpus: every chat with every message it holds, oldest first. A store
     * read like the list, so a search reaches 6,186 messages with no socket — a socket here would
     * spend a device slot for a query, and a replaced device is a re-pair.
     */
    async listCorpus() {
      return store.listCorpus().map(({ chat, unread, messages }) => ({
        jid: chat.jid,
        name: chat.name ?? contactName(chat.jid),
        kind: chat.kind,
        lastMsgAt: chat.last_msg_at,
        unread,
        messages: messages.map((message): WhatsAppMessageRow => ({
          id: message.id,
          chatJid: message.chatJid,
          fromMe: message.fromMe,
          ts: message.ts,
          type: message.type,
          text: message.text,
          sender: message.fromMe ? '' : senderName(message.sender, message.chatJid),
          edited: message.edited,
        })),
      }));
    },

    async openChat({ id, limit }) {
      const rows = await Promise.all(store.listRecentMessages(id, limit).map(async (message): Promise<WhatsAppMessageRow> => {
        const media = await factsOf(message);
        return {
          id: message.id,
          chatJid: message.chat_jid,
          fromMe: message.from_me,
          ts: message.ts,
          type: message.type,
          text: message.text ?? '',
          sender: message.from_me ? '' : senderName(message.sender, message.chat_jid),
          edited: message.edited_at != null,
          ...(media ? { media } : {}),
        };
      }));
      return rows;
    },

    async mediaFacts(messageId) {
      const stored = store.getMessage(messageId);
      return stored ? await factsOf(stored) : undefined;
    },

    /** A store read by design: a row draws what is known now, and a missing picture is asked for later. */
    avatarUrl(jid) {
      return avatars.url(jid);
    },

    async discardMedia(messageId) {
      const media = await import('./media.ts');
      media.discardCachedMedia(store, messageId, options.dataDir ?? media.whatsAppDataDir());
    },

    async loadMedia(messageId): Promise<WhatsAppMediaAnswer> {
      const stored = store.getMessage(messageId);
      if (!stored) return {};
      const info = await factsOf(stored);
      if (!info) return {};
      // Baileys is 7.9 MB of bundle and most starts never serve a picture, so the media module — the
      // one that owns where bytes live — loads on the first media read (the reason `server.ts`
      // imports the connection lazily, and `store.ts` its codec).
      const media = await import('./media.ts');
      const dataDir = options.dataDir ?? media.whatsAppDataDir();

      // Bytes already on disk answer with no socket at all, which is the point of caching them.
      const cached = stored.media_ref ? media.readCachedMedia(dataDir, stored.media_ref) : undefined;
      if (cached && stored.media_ref) {
        // The envelope names the type when it can — a document's own type, a voice note's declared
        // one — and the cached file's extension fills the gap for the kinds it cannot (a picture,
        // where the sender's declared type is not the one the frame was sent).
        const served = info.mime ? undefined : media.mediaMime(stored.media_ref);
        return { info: { ...info, cached: true, ...(served ? { mime: served } : {}) }, bytes: cached };
      }

      // A verdict the transport already recorded is not asked again on every open: WhatsApp-side
      // expiry is permanent, and re-asking it is the bug docs/bugs/2026-11-04-media-download-failure-is-not-temporary.md records.
      if (!info.available) return { info };

      // A download needs the socket, because a refusal is answered by asking the phone to re-upload.
      // A stopped socket is reopened here rather than turned into a dead source; when even that is
      // refused, the answer is a report — never a wait, and never a thrown promise the panel has to
      // draw as a broken picture.
      const reupload = await mediaSocket();
      // No socket is not a verdict on the message: WhatsApp would still serve these bytes, and the
      // answer says which of the two it is rather than leaving the panel to say "gone".
      if (!reupload) return { info, notConnected: true };

      try {
        const { mediaRef } = await media.downloadAndCacheMedia(store, messageId, {
          dataDir,
          ...(options.download ? { download: options.download } : {}),
          reuploadRequest: message => reupload.updateMediaMessage(message),
        });
        const bytes = media.readCachedMedia(dataDir, mediaRef);
        const served = await factsOf(store.getMessage(messageId) ?? stored) ?? info;
        const extensionMime = served.mime ? undefined : media.mediaMime(mediaRef);
        return bytes
          ? { info: { ...served, ...(extensionMime ? { mime: extensionMime } : {}) }, bytes }
          : { info: served };
      } catch {
        // The downloader persisted why it failed, so the stored row is the report: `available`
        // already says whether a later open may try again. Nothing is thrown from this seam.
        return { info: (await factsOf(store.getMessage(messageId) ?? stored)) ?? info };
      }
    },

    async markRead({ id, messageId }) {
      const target = messageId ?? store.newestMessageId(id);
      if (!target) return;
      store.markRead(id, target);
      // A receipt only exists to clear the badge on the owner's phone; it is a nicety beside the
      // recorded cursor, so a socket that is down or refuses must not turn a recorded read into a
      // failed one.
      if (!held()?.getSendSocket()) return;
      try {
        await send.markRead(id, target);
      } catch {
        /* the cursor is recorded; the phone will clear the badge on the next open */
      }
    },

    async sendText({ id, text }) {
      const draft = text.trim();
      if (!draft) throw new Error('Expected text to send');
      // A send needs a live socket, so a linked account is reopened rather than reported dead. A
      // refusal still reaches the caller as the send failure it is, worded by `failure.ts`.
      if (!held()?.getSendSocket()) await ensureConnection();
      await send.sendText(id, draft, newMessageId());
    },

    async status(): Promise<WhatsAppTransportStatus> {
      // Both the account state and the socket are lazy for the same reason: this module is built on
      // every plugin start, and neither Baileys nor a decrypt of the device identity belongs there.
      const { whatsAppAccountExists } = await import('./auth.ts');
      return {
        connection: connection()?.status() ?? 'disconnected',
        paired: whatsAppAccountExists(),
      };
    },
  };
}
