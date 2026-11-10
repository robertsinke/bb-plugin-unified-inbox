// LinkedIn adapter (Migration state 3). It owns the LinkedIn shapes: the live
// read behind `sync`, the conversation open with its cache fallback,
// the media answer for a photo or a shared post, and the reply, the reaction, and the read mark,
// each replayed from the requests the page itself sent for the same actions. An archive still
// needs its own recorded action, so it stays refused.
import { canChange } from './capability.ts';
import { isConversationId, isInvitationId, linkedinItems, linkedinMessages, type LinkedInMessage } from '../linkedin-inbox.ts';
import { linkedinDelta, linkedinMarker, linkedinMarkerMailbox } from '../linkedin-delta.ts';
import { linkedinMailboxUrn, linkedinProbe, type LinkedInProbe } from '../linkedin-probe.ts';
import { LINKEDIN_WALK_START } from '../linkedin-page.ts';
import type { LinkedInProbePayload } from '../linkedin-page-session.ts';
import { linkedinCdnUrl, readLinkedInImage } from '../linkedin-media.ts';
import {
  isMessageSend,
  linkedinInvitationWrite,
  linkedinReactWrite,
  linkedinReplyWrite,
  linkedinSendWrite,
  markReadWrite,
  markReadTarget,
  sameConversationUrn,
  messageSendTemplate,
  recordedSendText,
} from '../linkedin-write.ts';
import { isReactionEmoji } from '../reaction-set.ts';
import type { RegistryDeps } from './deps.ts';
import type {
  ActionKind, ActionOptions, ActionResult, Adapter, Capabilities, Conversation, LinkedInRecordOp, LinkedInRecordResult,
  LinkedInReplayInput, LinkedInReplayResult, ListResult, MediaPayload, OpenOptions, OpenResult, SourceDeclaration, SyncResult,
} from './types.ts';

/** The mailbox a probe payload reported, or the empty string when it did not report one. */
const mailboxOf = (payload: { mailboxUrn?: unknown } | null) => linkedinMailboxUrn(payload?.mailboxUrn);

const CAPABILITIES: Capabilities = { send: true, markRead: true, archive: false, invitations: true, media: true, attachments: false, threads: true, followsList: false, react: true, reactRemove: true, quoteReply: true, pollVote: false };

const ACCOUNT = 'linkedin';

/**
 * Conversations per older page. Measured against the live page: the older-conversations query answers
 * 20 rows in 0.6–1.3 s with their participants and newest message inlined, and refuses a `count` much
 * above this one by answering an empty page.
 */
const PAGE = 20;

/** How long a failed post read stays failed. Same window as a missed WhatsApp picture (`AVATAR_RETRY_MS`). */
const SHARE_MISS_MS = 60 * 60 * 1000;

function activityFromLink(link: string): string {
  const match = /^https:\/\/www\.linkedin\.com\/feed\/update\/(urn:li:activity:\d+)\/$/.exec(link);
  return match?.[1] ?? '';
}

const SOURCE: SourceDeclaration = { label: 'LinkedIn', icon: 'linkedin', pollIntervalMs: 45_000, pageSize: PAGE };

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

/** Media is addressed by the LinkedIn message urn the thread read recorded. */
function isMessageId(id: string): boolean {
  return /^urn:li:msg_message:.+/.test(id) && id.length <= 512;
}

export function createLinkedInAdapter(deps: RegistryDeps): Adapter {
  /** The last read's invitation action params, keyed by the invitation urn a row carries. */
  const invitationActions = new Map<string, InvitationParams>();
  /**
   * Both reads answer where the walk starts: a source showing rows has an older page behind them, and
   * the gateway seeds its one cursor from whichever of `list` or `sync` runs first.
   */
  const fromNewestPage = (rows: Conversation[]) => (rows.length ? { cursor: LINKEDIN_WALK_START } : {});
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
        return message.id === id || message.messageId === id || message.media?.messageId === id;
      });
      if (found) return found as LinkedInMessage;
    }
    return undefined;
  }

  /** The open thread's copy of one message, which a reply quotes. */
  function threadMessage(conversationId: string, messageId: string): LinkedInMessage | undefined {
    const thread = cache.readThread(ACCOUNT, conversationId);
    if (!Array.isArray(thread)) return undefined;
    const found = thread.find(value => {
      if (!value || typeof value !== 'object') return false;
      const message = value as LinkedInMessage;
      return message.messageId === messageId || message.id === messageId;
    });
    return found as LinkedInMessage | undefined;
  }

  /** The panel sees the message. The profile urn stays in the cache, where a reply reads it. */
  function present(messages: LinkedInMessage[]): OpenResult['messages'] {
    return messages.map(({ senderUrn: _senderUrn, ...message }) => message);
  }

  /**
   * Fills a share card for each post on this page that does not already have one.
   * One activity at a time. A miss is remembered so the next open does not ask again at once.
   * The list never calls this.
   */
  async function withShares(id: string, messages: LinkedInMessage[]): Promise<LinkedInMessage[]> {
    const previous = new Map(linkedinMessages({ messages: cache.readThread(ACCOUNT, id) ?? [] }).flatMap(row => row.messageId ? [[row.messageId, row] as const] : []));
    for (const message of messages) {
      const activity = message.link ? activityFromLink(message.link) : '';
      const key = message.messageId;
      if (!activity || !key) continue;
      const stored = previous.get(key);
      if (stored?.share) {
        message.share = stored.share;
        if (stored.imageUrl) message.imageUrl = stored.imageUrl;
        continue;
      }
      if (stored?.shareMissAt && Date.now() - stored.shareMissAt < SHARE_MISS_MS) {
        message.shareMissAt = stored.shareMissAt;
        continue;
      }
      try {
        const card = await deps.linkedInPage.post(activity);
        const imageUrl = linkedinCdnUrl(card.imageUrl);
        const title = card.title.trim().slice(0, 300);
        const author = card.author.trim().slice(0, 200);
        message.share = { title, ...(author ? { author } : {}), hasImage: Boolean(imageUrl) };
        if (imageUrl) message.imageUrl = imageUrl;
      } catch {
        message.shareMissAt = Date.now();
      }
    }
    return messages;
  }

  return {
    source: SOURCE,
    capabilities: () => CAPABILITIES,

    /**
     * The newest page is the cache, and the walk starts from it. No cursor is a request for that page,
     * which answers `LINKEDIN_WALK_START` without touching the page. The first press reads the first
     * primary page; the panel drops rows this cache already shows. A cursored call is one live page
     * and nothing else — an older page is drawn, never cached, because `cache.save` replaces an
     * account's rows wholesale and this page is older than the newest one.
     */
    async list(cursor?: string): Promise<ListResult> {
      const rows = cache.list().filter(item => item.account === ACCOUNT) as Conversation[];
      if (cursor === undefined) return { items: rows, errors: [], ...fromNewestPage(rows) };
      const page = await deps.linkedInPage.older(cursor, PAGE);
      const items = linkedinItems({ conversations: page.conversations }).map((item): Conversation => ({ ...item, account: ACCOUNT }));
      return { items, errors: [], ...(page.nextCursor ? { cursor: page.nextCursor } : {}) };
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
        return { ok: outcome.accepted, status: outcome.status };
      }
      if (!isMessageSend(input.write, input.conversationId)) {
        throw new Error('The recorded action is neither a message send nor a mark-read for this conversation; record the action through the UI instead.');
      }
      const recorded = recordedSendText(input.write, input.conversationId);
      const text = typeof input.text === 'string' ? input.text : recorded;
      if (text === null) throw new Error('The recorded send carries no single text field to repeat; supply the text to send.');
      const template = messageSendTemplate(input.write, input.conversationId, text);
      const outcome = await deps.linkedInPage.replay(template);
      return { ok: outcome.accepted, status: outcome.status };
    },

    async open(id: string, _opts?: OpenOptions): Promise<OpenResult> {
      if (!isConversationId(id)) throw new Error('That LinkedIn conversation cannot be opened.');
      const keep = (): OpenResult => ({ messages: present(linkedinMessages({ messages: cache.readThread(ACCOUNT, id) ?? [] })) });
      let live: LinkedInMessage[];
      try {
        live = await withShares(id, linkedinMessages(await deps.linkedInPage.thread(id)));
      } catch (error) {
        // A browser that cannot start must not hide messages this plugin already has.
        const cached = keep();
        if (cached.messages.length) return { ...cached, cacheFallback: true };
        throw error;
      }
      cache.saveThread(ACCOUNT, id, live);
      return { messages: present(live) };
    },

    /** A photo is fetched from LinkedIn's CDN; a shared post answers with its link, because it has no thumbnail. */
    async media(request): Promise<MediaPayload> {
      if (request.kind !== 'message') throw new Error('This account has no attachments.');
      const message = cachedMessage(request.id);
      if (!message) throw new Error('Open this LinkedIn conversation again to show its media.');
      if (linkedinCdnUrl(message.imageUrl)) return readLinkedInImage(message.imageUrl);
      if (message.link && !message.media) return { dataUrl: '', mime: '', url: message.link };
      if (!message.media) throw new Error('This LinkedIn message carries no media.');
      return readLinkedInImage(message.media.url);
    },

    async action(kind: ActionKind, id: string, opts?: ActionOptions): Promise<ActionResult> {
      // Read marks, reactions, replies, and invitation answers are the requests the page itself
      // sent. An archive still has no captured action.
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
      if (CAPABILITIES.react && kind === 'react') {
        // Set and remove are the two captured reaction actions. A reply is the branch below.
        if (!isConversationId(id)) throw new Error('That LinkedIn conversation cannot take a reaction.');
        if (opts?.remove === true && !CAPABILITIES.reactRemove) throw new Error('This source cannot remove a reaction. Nothing was sent.');
        const write = linkedinReactWrite(opts?.messageId, opts?.emoji, opts?.remove === true);
        if (!write) {
          if (!isReactionEmoji(opts?.emoji)) throw new Error('That emoji is not one of the four reactions. Nothing was sent.');
          throw new Error('A reaction needs the message it reacts to. Nothing was sent.');
        }
        const outcome = await deps.linkedInPage.replay(write);
        if (!outcome.accepted) throw new Error(`LinkedIn did not accept the reaction (status ${outcome.status}); it may still have been sent — check the thread before trying again.`);
        return { status: 'Sent.' };
      }
      if (CAPABILITIES.send && kind === 'reply') {
        const text = typeof opts?.text === 'string' ? opts.text.trim() : '';
        // A message id is a reply to that message. It must not fall through to a plain conversation send.
        if (opts?.messageId) {
          if (!isConversationId(id)) throw new Error('That LinkedIn conversation cannot receive a reply.');
          if (!text) throw new Error('A reply needs the text to send.');
          const target = threadMessage(id, opts.messageId);
          const write = target?.messageId && target.senderUrn ? linkedinReplyWrite({
            conversationUrn: id,
            text,
            messageUrn: target.messageId,
            sentAt: target.date,
            senderUrn: target.senderUrn,
            quotedText: target.text,
          }) : null;
          if (!write) throw new Error('Open this LinkedIn conversation again before replying to one message.');
          const outcome = await deps.linkedInPage.replay(write);
          if (!outcome.accepted) throw new Error(`LinkedIn did not accept the message (status ${outcome.status}); it may still have been sent — check the thread before trying again.`);
          return { status: 'Sent.' };
        }
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
    async sync(_opts?: OpenOptions): Promise<SyncResult> {
      const cached = (): Conversation[] => cache.list().filter(item => item.account === ACCOUNT) as Conversation[];
      const stored = cache.cursor(ACCOUNT);
      let payload: LinkedInProbePayload | null = null;
      let probe: LinkedInProbe | null = null;
      try {
        payload = await deps.linkedInPage.probe(linkedinMarkerMailbox(stored));
        probe = linkedinProbe(payload);
      } catch { probe = null; }
      const decision = linkedinDelta({ stored, probe });
      if (decision.action === 'skip' && cached().length) {
        // The probe just proved the rows are current, so it may also hand over the mailbox it
        // learned: a refresh that skips must not leave the next one asking who it is again.
        if (probe) cache.setCursor(ACCOUNT, linkedinMarker(probe, mailboxOf(payload)));
        return { items: cached(), updatedAt: Date.now(), reason: decision.action, ...fromNewestPage(cached()) };
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
      return { items, updatedAt: Date.now(), reason: decision.action, ...fromNewestPage(items) };
    },
  };
}
