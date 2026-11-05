// What answers a WhatsApp read (plan U3).
//
// The adapter asks this, not a socket: the store holds what arrived, so a read works with the socket
// down and answers the same way whichever path put the row there. Three decisions live here and
// nowhere else:
//   - a chat's name, preview and unread count, because only the store knows the newest stored row
//     and where reading stopped;
//   - a sender's display name, because only the store can turn a jid into an address-book name, a
//     push name or a phone number;
//   - what a media request gets, because only the store knows whether the bytes are cached.
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
      text: whatsappText(message.text ?? '', message.type, Boolean(whatsAppMedia(message))),
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
      return store.listRecentMessages(id, limit).map((message): WhatsAppMessageRow => {
        const media = whatsAppMedia(message);
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
      const info = stored ? whatsAppMedia(stored) : undefined;
      if (!stored || !info) return {};
      if (!stored.media_ref) return { info };
      // Baileys is 7.9 MB of bundle and most starts never serve a picture, so the media module — the
      // one that owns where bytes live — loads on the first cached read (the reason `server.ts`
      // imports the connection lazily, and `store.ts` its codec).
      const media = await import('./media.ts');
      const bytes = media.readCachedMedia(options.dataDir ?? media.whatsAppDataDir(), stored.media_ref);
      if (!bytes) return { info };
      return { info: { ...info, mime: media.mediaMime(stored.media_ref) }, bytes };
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
