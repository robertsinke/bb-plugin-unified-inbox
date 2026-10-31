// LinkedIn adapter (Migration state 3). It owns the LinkedIn shapes: the live
// read behind `linkedin_sync`, the conversation open with its cache fallback,
// the media answer for a photo or a shared post, and the refusal of every write
// — a reply, an invitation answer, and a read mark all change the owner's real
// account, so none is enabled in this build.
import { isConversationId, linkedinItems, linkedinMessages, type LinkedInMessage } from '../linkedin-inbox.ts';
import { linkedinDelta, linkedinMarker, linkedinMarkerMailbox } from '../linkedin-delta.ts';
import { linkedinMailboxUrn, linkedinProbe, type LinkedInProbe } from '../linkedin-probe.ts';

/** The mailbox a probe payload reported, or the empty string when it did not report one. */
const mailboxOf = (payload: unknown) => linkedinMailboxUrn((payload as { mailboxUrn?: unknown } | null)?.mailboxUrn);
import { readLinkedInImage } from '../linkedin-media.ts';
import type { RegistryDeps } from './deps.ts';
import type {
  Account, ActionKind, ActionOptions, ActionResult, Adapter, Capabilities, Conversation, ListResult, MediaPayload, OpenOptions, OpenResult, SyncResult,
} from './types.ts';

const CAPABILITIES: Capabilities = { send: false, markRead: false, archive: false, media: true, attachments: false };

const ACCOUNT = 'linkedin';

const READ_ONLY = 'LinkedIn is read-only here: nothing can be sent, accepted, or marked read.';

/**
 * The `media` answer for LinkedIn: the image itself, or — for a shared post, whose
 * payload carries no thumbnail — the post's link with no image data.
 *
 * `MediaPayload` has no `url` yet; this wider shape is what the gateway's `media`
 * output needs to carry for the inbox to render that link.
 */
export type LinkedInMediaPayload = MediaPayload & { url?: string };

/** Media is addressed by the LinkedIn message urn the thread read recorded. */
function isMessageId(id: string): boolean {
  return /^urn:li:msg_message:.+/.test(id) && id.length <= 512;
}

export function createLinkedInAdapter(deps: RegistryDeps): Adapter {
  const { cache } = deps;

  /**
   * The cached message a media request names. A LinkedIn message lives only
   * inside its conversation, so the threads this cache already holds are where
   * the picture read with the message is found — no second browser read, and
   * nothing new cached for it.
   */
  function cachedMessage(id: string): LinkedInMessage | undefined {
    if (!isMessageId(id)) return undefined;
    for (const row of cache.list()) {
      if (row.account !== ACCOUNT) continue;
      const thread = cache.readThread(ACCOUNT, row.id);
      if (!Array.isArray(thread)) continue;
      const found = thread.find(value => {
        if (!value || typeof value !== 'object') return false;
        const message = value as LinkedInMessage;
        return message.id === id || message.media?.messageId === id;
      });
      if (found) return found as LinkedInMessage;
    }
    return undefined;
  }

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

    /** A photo is fetched from LinkedIn's CDN; a shared post answers with its link, because it has no thumbnail. */
    async media(_account: Account, id: string, _index: number): Promise<LinkedInMediaPayload> {
      const message = cachedMessage(id);
      if (!message) throw new Error('Open this LinkedIn conversation again to show its media.');
      if (message.link && !message.media) return { dataUrl: '', mime: '', url: message.link };
      if (!message.media) throw new Error('This LinkedIn message carries no media.');
      return readLinkedInImage(message.media.url);
    },

    async action(_kind: ActionKind, _id: string, _opts?: ActionOptions): Promise<ActionResult> {
      // Every capability is false, so every action ends here; enabling one means
      // declaring it and implementing it against a recorded request.
      throw new Error(READ_ONLY);
    },

    /**
     * One cheap probe first: the full read costs a payload plus about twenty profile
     * lookups, so an unchanged inbox keeps its cached rows instead. A probe that cannot
     * run is not a change — it falls back to reading, never to skipping.
     */
    async sync(force?: boolean): Promise<SyncResult> {
      const cached = (): Conversation[] => cache.list().filter(item => item.account === ACCOUNT) as Conversation[];
      const stored = cache.cursor(ACCOUNT);
      let payload: unknown = null;
      let probe: LinkedInProbe | null = null;
      try {
        payload = await deps.probeLinkedIn(linkedinMarkerMailbox(stored));
        probe = linkedinProbe(payload);
      } catch { probe = null; }
      const decision = linkedinDelta({ stored, probe, force });
      if (decision.action === 'skip' && cached().length) {
        // The probe just proved the rows are current, so it may also hand over the mailbox it
        // learned: a refresh that skips must not leave the next one asking who it is again.
        if (probe) cache.setCursor(ACCOUNT, linkedinMarker(probe, mailboxOf(payload)));
        return { items: cached(), updatedAt: Date.now(), reason: decision.action };
      }

      const listed = await deps.readLinkedIn({ mode: 'list' }) as { conversations?: unknown; invitations?: unknown };
      const items = linkedinItems(listed).map((item): Conversation => ({ ...item, account: ACCOUNT }));
      cache.save(ACCOUNT, items);
      // Only a probe can describe the state this read produced, so the marker is stored from it.
      if (probe) cache.setCursor(ACCOUNT, linkedinMarker(probe, mailboxOf(payload)));
      return { items, updatedAt: Date.now(), reason: decision.action };
    },
  };
}
