// LinkedIn adapter (Migration state 3). It owns the LinkedIn shapes: the live
// read behind `linkedin_sync`, the conversation open with its cache fallback,
// the media answer for a photo or a shared post, and the reply and the read mark, each replayed
// from the requests the page itself sent for the same actions. An invitation answer
// and an archive still need their own recorded actions, so they stay refused.
import { canChange } from './capability.ts';
import { isConversationId, isInvitationId, linkedinItems, linkedinMessages, type LinkedInMessage } from '../linkedin-inbox.ts';
import { linkedinDelta, linkedinMarker, linkedinMarkerMailbox } from '../linkedin-delta.ts';
import { linkedinMailboxUrn, linkedinProbe, type LinkedInProbe } from '../linkedin-probe.ts';
import type { LinkedInProbePayload } from '../linkedin-page-session.ts';
import { readLinkedInImage } from '../linkedin-media.ts';
import {
  isMessageSend,
  linkedinInvitationWrite,
  linkedinSendWrite,
  markReadWrite,
  markReadTarget,
  sameConversationUrn,
  messageSendTemplate,
  recordedSendText,
} from '../linkedin-write.ts';
import type { RegistryDeps } from './deps.ts';
import type {
  Account, ActionKind, ActionOptions, ActionResult, Adapter, Capabilities, Conversation, LinkedInRecordOp, LinkedInRecordResult,
  LinkedInReplayInput, LinkedInReplayResult, ListResult, MediaPayload, OpenOptions, OpenResult, SyncResult,
} from './types.ts';

/** The mailbox a probe payload reported, or the empty string when it did not report one. */
const mailboxOf = (payload: { mailboxUrn?: unknown } | null) => linkedinMailboxUrn(payload?.mailboxUrn);

const CAPABILITIES: Capabilities = { send: true, markRead: true, archive: false, invitations: true, media: true, attachments: false, threads: true, followsList: false };

const ACCOUNT = 'linkedin';

/** What an invitation answer needs, kept from the last read: the sharedSecret the page sends as its
 * validationToken, the inviter's profile id, and the person's first name for the toast. */
type InvitationParams = { token: string; inviterProfileId: string; firstName: string };
const invitationParams = (value: unknown): InvitationParams | null => {
  if (!value || typeof value !== 'object') return null;
  const row = value as { token?: unknown; inviterProfileId?: unknown; firstName?: unknown };
  if (typeof row.token !== 'string' || !row.token || typeof row.inviterProfileId !== 'string' || !row.inviterProfileId) return null;
  return { token: row.token, inviterProfileId: row.inviterProfileId, firstName: typeof row.firstName === 'string' ? row.firstName : '' };
};

const READ_ONLY = 'LinkedIn here can send a reply and mark a conversation read; an invitation answer and an archive still need their own recorded actions.';

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
  /** The last read's invitation action params, keyed by the invitation urn a row carries. */
  const invitationActions = new Map<string, InvitationParams>();
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

    /**
     * The recorder behind slice D: arming it watches the page's own `fetch`, so the only
     * thing that can produce a recorded write is a real action somebody performed.
     */
    async record(op: LinkedInRecordOp): Promise<LinkedInRecordResult> {
      if (op === 'arm') {
        const armed = await deps.armLinkedInRecorder() as { installed?: unknown; recording?: unknown };
        return { installed: armed?.installed === true, recording: armed?.recording === true };
      }
      if (op === 'clear') {
        await deps.linkedInPage.clearRecorded();
        return { installed: true, recording: true, writes: [] };
      }
      // A dump also says whether the wrappers were called at all: "nothing recorded" and "never
      // watched" are different answers, and the page session parses both.
      return deps.linkedInPage.recorded();
    },

    /**
     * Replaying is the only path that can change the account, so it settles three questions
     * first: was this approved, is the template a message send to this conversation, and does
     * it still carry exactly one text field. A refusal names what is missing.
     */
    async replay(input: LinkedInReplayInput): Promise<LinkedInReplayResult> {
      if (input.confirm !== true) throw new Error('Replaying a LinkedIn write changes your account. Approve the exact action first.');
      const marking = markReadTarget(input.write);
      if (marking) {
        if (!sameConversationUrn(marking, input.conversationId)) {
          throw new Error('The recorded action marks a different conversation as read; record the action again in this one.');
        }
        if (typeof input.text === 'string' && input.text) throw new Error('A mark-read replay carries no text.');
        const outcome = await deps.linkedInPage.replay(input.write);
        return { ok: outcome.accepted, status: outcome.status, body: null };
      }
      if (!isMessageSend(input.write, input.conversationId)) {
        throw new Error('The recorded action is neither a message send nor a mark-read for this conversation; record the action through the UI instead.');
      }
      const recorded = recordedSendText(input.write, input.conversationId);
      const text = typeof input.text === 'string' ? input.text : recorded;
      if (text === null) throw new Error('The recorded send carries no single text field to repeat; supply the text to send.');
      const template = messageSendTemplate(input.write, input.conversationId, text);
      const outcome = await deps.linkedInPage.replay(template);
      return { ok: outcome.accepted, status: outcome.status, body: null };
    },

    async open(id: string, _opts?: OpenOptions): Promise<OpenResult> {
      if (!isConversationId(id)) throw new Error('That LinkedIn conversation cannot be opened.');
      const keep = (): OpenResult => ({ messages: linkedinMessages({ messages: cache.readThread(ACCOUNT, id) ?? [] }) });
      let live: LinkedInMessage[];
      try {
        live = linkedinMessages(await deps.linkedInPage.thread(id));
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

    async action(kind: ActionKind, id: string, opts?: ActionOptions): Promise<ActionResult> {
      // The one change LinkedIn can make from here: the read mark, replayed from the request the
      // page itself sent for the same menu item. Everything else — a reply, an invitation answer,
      // an archive — still needs its own recorded action first.
      if (CAPABILITIES.invitations && (kind === 'confirm' || kind === 'reject')) {
        // An invitation answer is the same request the page's own button sends: built from the
        // sharedSecret and inviter the read already carried, so any invitation the inbox shows can
        // be answered — never a replay of one recorded invitation.
        const params = isInvitationId(id) ? invitationParams(invitationActions.get(id)) : null;
        if (!params) throw new Error(isInvitationId(id) ? 'Refresh the inbox before answering this invitation.' : 'That LinkedIn invitation cannot be answered.');
        const write = linkedinInvitationWrite({
          invitationId: id.replace(/^urn:li:fs_relInvitation:/, ''),
          token: params.token,
          inviterProfileId: params.inviterProfileId,
          firstName: params.firstName || 'the sender',
          action: kind === 'confirm' ? 'accept' : 'ignore',
        });
        if (!write) throw new Error('That LinkedIn invitation cannot be answered.');
        const outcome = await deps.linkedInPage.replay(write);
        if (!outcome.accepted) throw new Error(`LinkedIn did not accept the answer (status ${outcome.status}); the invitation was not ${kind === 'confirm' ? 'accepted' : 'ignored'}.`);
        return { status: kind === 'confirm' ? 'Accepted.' : 'Ignored.' };
      }
      if (CAPABILITIES.send && kind === 'reply') {
        const text = typeof opts?.text === 'string' ? opts.text.trim() : '';
        const write = text ? linkedinSendWrite(id, text) : null;
        if (!write) throw new Error(id.startsWith('urn:li:msg_conversation:') ? 'A reply needs the text to send.' : 'That LinkedIn conversation cannot receive a reply.');
        const outcome = await deps.linkedInPage.replay(write);
        // A failed answer leaves the send uncertain, exactly as for Messages: it is reported, never retried.
        if (!outcome.accepted) throw new Error(`LinkedIn did not accept the message (status ${outcome.status}); it may still have been sent — check the thread before trying again.`);
        return { status: 'Sent.' };
      }
      if (canChange(CAPABILITIES, kind) && (kind === 'read' || kind === 'unread')) {
        const write = markReadWrite(id, kind === 'read');
        if (!write) throw new Error('That LinkedIn conversation cannot be marked.');
        const outcome = await deps.linkedInPage.replay(write);
        if (!outcome.accepted) throw new Error(`LinkedIn did not accept the read mark (status ${outcome.status}).`);
        if (kind === 'read') cache.dropUnread(ACCOUNT, id);
        else cache.keepUnread(ACCOUNT, id);
        return { status: 'Updated.' };
      }
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
      let payload: LinkedInProbePayload | null = null;
      let probe: LinkedInProbe | null = null;
      try {
        payload = await deps.linkedInPage.probe(linkedinMarkerMailbox(stored));
        probe = linkedinProbe(payload);
      } catch { probe = null; }
      const decision = linkedinDelta({ stored, probe, force });
      if (decision.action === 'skip' && cached().length) {
        // The probe just proved the rows are current, so it may also hand over the mailbox it
        // learned: a refresh that skips must not leave the next one asking who it is again.
        if (probe) cache.setCursor(ACCOUNT, linkedinMarker(probe, mailboxOf(payload)));
        return { items: cached(), updatedAt: Date.now(), reason: decision.action };
      }

      const listed = await deps.linkedInPage.list();
      // The invitation action params are not part of a row, so they are kept beside the cache,
      // replaced wholesale by every read: a stale token cannot outlive the invitation it answered.
      invitationActions.clear();
      for (const row of listed.invitations) {
        const params = invitationParams(row);
        const id = row && typeof row === 'object' && typeof (row as { id?: unknown }).id === 'string' ? (row as { id: string }).id : '';
        if (params && isInvitationId(id)) invitationActions.set(id, params);
      }
      const items = linkedinItems(listed).map((item): Conversation => ({ ...item, account: ACCOUNT }));
      cache.save(ACCOUNT, items);
      // Only a probe can describe the state this read produced, so the marker is stored from it.
      if (probe) cache.setCursor(ACCOUNT, linkedinMarker(probe, mailboxOf(payload)));
      return { items, updatedAt: Date.now(), reason: decision.action };
    },
  };
}
