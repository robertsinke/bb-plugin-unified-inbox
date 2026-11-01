// Messages adapter (Migration state 3). It owns the imsg shapes: chats, history
// with attachment slots, the one permitted mutation (`send`), local read state,
// and the attachment payload. Every other write stays refused by the client and
// by this adapter's capabilities.
import { findImsgAttachment, imsgChatId, mapImsgChats, mapImsgHistory } from '../imsg-mapping.ts';
import { readImsgImage } from '../imsg-media.ts';
import { sendImsgText } from '../imsg-send.ts';
import { canChange } from './capability.ts';
import type { RegistryDeps } from './deps.ts';
import type {
  ActionKind, ActionOptions, ActionResult, Adapter, Capabilities, Conversation, ListResult, MediaPayload, Message, OpenOptions, OpenResult,
} from './types.ts';

const CAPABILITIES: Capabilities = { send: true, markRead: true, archive: false, invitations: false, media: true, attachments: true, threads: true, followsList: true };

const ACCOUNT = 'imessage';

export function createIMessageAdapter(deps: RegistryDeps): Adapter {
  const { cache } = deps;

  async function history(id: string) {
    return deps.imsg.request('messages.history', { chat_id: imsgChatId(id), limit: 60, attachments: true });
  }

  return {
    capabilities: () => CAPABILITIES,

    async list(_cursor?: string, opts?: OpenOptions): Promise<ListResult> {
      const items = mapImsgChats(await deps.imsg.request('chats.list', { limit: opts?.limit ?? 20 })) as Conversation[];
      cache.save(ACCOUNT, items);
      return { items, errors: [] };
    },

    async open(id: string, _opts?: OpenOptions): Promise<OpenResult> {
      const messages = mapImsgHistory(await history(id)) as Message[];
      cache.saveThread(ACCOUNT, id, messages);
      return { messages };
    },

    async media(): Promise<MediaPayload> {
      throw new Error('A Messages attachment opens through its conversation, not by message id.');
    },

    async imsgMedia(chatId: string, messageId: string, index: number): Promise<MediaPayload> {
      const chat = imsgChatId(chatId);
      imsgChatId(messageId);
      const attachment = findImsgAttachment(await deps.imsg.request('messages.history', { chat_id: chat, limit: 60, attachments: true }), messageId, index);
      return readImsgImage(attachment.filename, attachment.mime);
    },

    async action(kind: ActionKind, id: string, opts?: ActionOptions): Promise<ActionResult> {
      if (canChange(CAPABILITIES, kind)) {
        if (kind === 'read') {
          cache.dropUnread(ACCOUNT, id);
          return { status: 'Marked read.' };
        }
        cache.keepUnread(ACCOUNT, id);
        return { status: 'Marked unread.' };
      }
      // Sending is enabled for Messages at the owner's explicit request; nothing else here mutates the source.
      if (CAPABILITIES.send && kind === 'reply' && opts?.text?.trim()) return { status: await sendImsgText(deps.imsg, id, opts.text) };
      throw new Error('This action is not supported for Messages.');
    },
  };
}
