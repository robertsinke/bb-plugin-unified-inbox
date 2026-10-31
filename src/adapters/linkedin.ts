// LinkedIn adapter (Migration state 3). It owns the LinkedIn shapes: the live
// read behind `linkedin_sync`, the conversation open with its cache fallback,
// and the refusal of every write — a reply, an invitation answer, and a read
// mark all change the owner's real account, so none is enabled in this build.
import { isConversationId, linkedinItems, linkedinMessages } from '../linkedin-inbox.ts';
import type { RegistryDeps } from './deps.ts';
import type {
  ActionKind, ActionOptions, ActionResult, Adapter, Capabilities, Conversation, ListResult, MediaPayload, OpenOptions, OpenResult, SyncResult,
} from './types.ts';

const CAPABILITIES: Capabilities = { send: false, markRead: false, archive: false, media: false, attachments: false };

const ACCOUNT = 'linkedin';

const READ_ONLY = 'LinkedIn is read-only here: nothing can be sent, accepted, or marked read.';

export function createLinkedInAdapter(deps: RegistryDeps): Adapter {
  const { cache } = deps;

  return {
    capabilities: () => CAPABILITIES,

    /** Cached rows only: the live read is `sync`, which the gateway calls on its own. */
    async list(_cursor?: string, _opts?: OpenOptions): Promise<ListResult> {
      return { items: cache.list().filter(item => item.account === ACCOUNT) as Conversation[], errors: [] };
    },

    async open(id: string, _opts?: OpenOptions): Promise<OpenResult> {
      if (!isConversationId(id)) throw new Error('That LinkedIn conversation cannot be opened.');
      const keep = (): OpenResult => ({ messages: linkedinMessages({ messages: cache.readThread(ACCOUNT, id) ?? [] }) });
      let live;
      try {
        live = linkedinMessages(await deps.readLinkedIn({ mode: 'thread', id }) as { messages?: unknown });
      } catch (error) {
        // A browser that cannot start must not hide messages this plugin already has.
        const cached = keep();
        if (cached.messages.length) return cached;
        throw error;
      }
      cache.saveThread(ACCOUNT, id, live);
      return { messages: live };
    },

    async media(): Promise<MediaPayload> {
      throw new Error('LinkedIn messages carry no media this build can serve.');
    },

    async action(_kind: ActionKind, _id: string, _opts?: ActionOptions): Promise<ActionResult> {
      // Every capability is false, so every action ends here; enabling one means
      // declaring it and implementing it against a recorded request.
      throw new Error(READ_ONLY);
    },

    async sync(): Promise<SyncResult> {
      const payload = await deps.readLinkedIn({ mode: 'list' }) as { conversations?: unknown; invitations?: unknown };
      const items = linkedinItems(payload).map((item): Conversation => ({ ...item, account: ACCOUNT }));
      cache.save(ACCOUNT, items);
      return { items, updatedAt: Date.now() };
    },
  };
}
