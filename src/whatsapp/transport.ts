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
import type { WhatsAppConnection } from './connection.ts';
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
  const send = createWhatsAppSendTransport(() => connection()?.getSendSocket());

  /** The name to show for a jid: the address book first, then the name they chose for themselves. */
  function contactName(jid: string): string {
    const contact = store.getContact(jid);
    return usableName(contact?.name) ?? usableName(contact?.push_name) ?? '';
  }

  /** Who wrote a stored row, in words the panel can draw. Never the chat's own title. */
  function senderName(sender: string | null): string {
    if (!sender || sender === 'me') return '';
    return contactName(sender) || whatsappPhone(sender);
  }

  function previewOf(message: Message): NonNullable<WhatsAppChatRow['preview']> {
    return {
      text: whatsappText(message.text ?? '', message.type, whatsAppMedia(message)),
      fromMe: message.from_me,
      sender: senderName(message.sender),
    };
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

    async openChat({ id, limit }) {
      const rows = store.listRecentMessages(id, limit);
      // A document's name, size and type exist only inside its envelope, so the module that already
      // unwraps one to download it is asked once per open — and only when a document is on screen.
      const documents = rows.some(row => row.type === 'document' && row.raw)
        ? (await import('./media.ts')).documentFacts
        : undefined;
      return rows.map((message): WhatsAppMessageRow => {
        const media = whatsAppMedia(message, documents?.(message.raw));
        return {
          id: message.id,
          chatJid: message.chat_jid,
          fromMe: message.from_me,
          ts: message.ts,
          type: message.type,
          text: message.text ?? '',
          sender: message.from_me ? '' : senderName(message.sender),
          edited: message.edited_at != null,
          ...(media ? { media } : {}),
        };
      });
    },

    async loadMedia(messageId): Promise<WhatsAppMediaAnswer> {
      const stored = store.getMessage(messageId);
      if (!stored) return {};
      const facts = whatsAppMedia(stored);
      if (!facts) return {};
      // Baileys is 7.9 MB of bundle and most starts never serve a picture, so the media module — the
      // one that owns where bytes live — loads on the first media read (the reason `server.ts`
      // imports the connection lazily, and `store.ts` its codec).
      const media = await import('./media.ts');
      const documents = stored.type === 'document' ? media.documentFacts(stored.raw) : undefined;
      const info = whatsAppMedia(stored, documents) ?? facts;
      const dataDir = options.dataDir ?? media.whatsAppDataDir();

      // Bytes already on disk answer with no socket at all, which is the point of caching them.
      const cached = stored.media_ref ? media.readCachedMedia(dataDir, stored.media_ref) : undefined;
      if (cached && stored.media_ref) {
        // The extension names the type for the kinds this module writes; a document keeps the type
        // its envelope declared, which is the only honest answer for a file it did not recognise.
        const served = media.mediaMime(stored.media_ref);
        return { info: { ...info, cached: true, ...(served ? { mime: served } : {}) }, bytes: cached };
      }

      // A verdict the transport already recorded is not asked again on every open: WhatsApp-side
      // expiry is permanent, and re-asking it is the bug docs/bugs/2026-11-04-media-download-failure-is-not-temporary.md records.
      if (!info.available) return { info };

      // A download needs the socket, because a refusal is answered by asking the phone to re-upload.
      // With no socket the answer is a report — never a wait, and never a thrown promise the panel
      // has to draw as a broken picture.
      const socket = connection()?.getMediaSocket();
      if (!socket) return { info };

      try {
        const { mediaRef } = await media.downloadAndCacheMedia(store, messageId, {
          dataDir,
          ...(options.download ? { download: options.download } : {}),
          reuploadRequest: message => socket.updateMediaMessage(message),
        });
        const bytes = media.readCachedMedia(dataDir, mediaRef);
        const served = whatsAppMedia(store.getMessage(messageId) ?? stored, documents) ?? info;
        const extensionMime = media.mediaMime(mediaRef);
        return bytes
          ? { info: { ...served, ...(extensionMime ? { mime: extensionMime } : {}) }, bytes }
          : { info: served };
      } catch {
        // The downloader persisted why it failed, so the stored row is the report: `available`
        // already says whether a later open may try again. Nothing is thrown from this seam.
        return { info: whatsAppMedia(store.getMessage(messageId) ?? stored, documents) ?? info };
      }
    },

    async markRead({ id, messageId }) {
      const target = messageId ?? store.newestMessageId(id);
      if (!target) return;
      store.markRead(id, target);
      // A receipt only exists to clear the badge on the owner's phone; it is a nicety beside the
      // recorded cursor, so a socket that is down or refuses must not turn a recorded read into a
      // failed one.
      if (!connection()?.getSendSocket()) return;
      try {
        await send.markRead(id, target);
      } catch {
        /* the cursor is recorded; the phone will clear the badge on the next open */
      }
    },

    async sendText({ id, text }) {
      const draft = text.trim();
      if (!draft) throw new Error('Expected text to send');
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
