import type { LinkedInRecorderStats } from '../linkedin-page-session.ts';
import type { WhatsAppMedia } from '../whatsapp-media.ts';

// Shared adapter contract for the unified inbox gateway.
// Spec: specs/001-unified-inbox-gateway/spec.md — Migration state 3: the
// adapters in this directory and the registry in ./index.ts implement these
// shapes, and server.ts routes through the registry instead of branching on
// the account name.
//
// Shapes mirror the RPC contract in server.ts (item/message zod schemas)
// so the transport rewires routing without any payload conversion.

import type { CapabilityKey } from './capability.ts';
import type { MediaRequest, MediaKind } from './media.ts';

/**
 * Registry keys: one adapter per account, and the `account` value on every RPC
 * input. The tuple is the canonical list — `server.ts` builds its zod enum from
 * it, so a new source is one entry here plus one adapter.
 */
export const gmailAccounts = ['gmail-personal', 'gmail-business'] as const;
export const accounts = [...gmailAccounts, 'whatsapp', 'imessage', 'linkedin'] as const;

export type Account = (typeof accounts)[number];

/** Gmail accounts are the only ones with a `send_gmail` draft today. */
export type GmailAccount = (typeof gmailAccounts)[number];

/** How much of a thread or message Gmail returns: everything, headers only, or ids only. */
export type GmailFormat = 'full' | 'metadata' | 'minimal';

/** The caller's mailbox; the plugin only ever reads or sends as the account it holds. */
export interface GmailProfile {
  emailAddress?: string;
  messagesTotal?: number;
  threadsTotal?: number;
  historyId?: string;
}

/** A thread listing page. `nextPageToken` is absent on the last page. */
export interface GmailThreadPage {
  threads?: { id?: string; historyId?: string; snippet?: string }[];
  nextPageToken?: string;
  resultSizeEstimate?: number;
}

/** A thread as Gmail returns it; the adapter models `messages` and `payload`. */
export interface GmailThread {
  id?: string;
  historyId?: string;
  messages?: any[];
}

/** A message as Gmail returns it; the adapter models `payload` and `labelIds`. */
export interface GmailMessage {
  id?: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: any;
}

/** What a send reports back: the message it created, which is the only proof of delivery. */
export interface GmailSentMessage {
  id?: string;
  threadId?: string;
  labelIds?: string[];
}

export interface GmailReadInput {
  id: string;
  format?: GmailFormat;
  /** Only sent for a `metadata` read; defaulted to the headers a cached row needs. */
  metadataHeaders?: string[];
}

/**
 * The Gmail transport seam (plan unit U3): one method per endpoint `src/adapters/gmail.ts` asks
 * for, so the plugin can swap what answers behind it without the adapter learning a second
 * vocabulary. The implementation is the plugin's own HTTPS client in
 * `src/gmail-client.ts`; nothing behind this seam shells out to a CLI.
 *
 * Seven calls, eight call sites: `attachmentGet` serves both the HTML-body fetch and the
 * attachment fetch. A rejection is the raw cause; the adapter normalizes it through
 * `src/adapters/provider-error.ts`.
 */
export interface GmailClient {
  profile(): Promise<GmailProfile>;
  threadsList(input?: { labelIds?: string[]; maxResults?: number; pageToken?: string }): Promise<GmailThreadPage>;
  threadGet(input: GmailReadInput): Promise<GmailThread>;
  threadsModify(input: { id: string; addLabelIds?: string[]; removeLabelIds?: string[] }): Promise<GmailThread>;
  messageGet(input: GmailReadInput): Promise<GmailMessage>;
  /** The attachment's bytes, base64url decoded. */
  attachmentGet(input: { messageId: string; id: string }): Promise<Uint8Array>;
  sendRaw(input: { raw: Uint8Array; threadId?: string }): Promise<GmailSentMessage>;
}

/**
 * What the registry hands the Gmail adapters. Which implementation answers is a wiring question
 * (`src/adapters/index.ts`, `server.ts`), and so is which account already has a credential — so the
 * dependency is asked per account rather than fixed for both.
 */
export type GmailTransport = (account: GmailAccount) => GmailClient;

/** One chat as the WhatsApp transport answers it: WhatsApp's own facts, not the panel's shape. */
export interface WhatsAppChatRow {
  jid: string;
  /** The name to show: the chat's own, else the contact's best known one; empty when neither. */
  name: string;
  kind: '1:1' | 'group';
  /** When the newest stored message arrived, in milliseconds; null for a chat with no stored row. */
  lastMsgAt: number | null;
  /** The newest stored message, shaped for a list preview. */
  preview?: { text: string; fromMe: boolean; sender: string };
  /** Other people's stored messages newer than the read cursor. */
  unread: number;
}

/** One message as the WhatsApp transport answers it: stored facts, not yet the panel's shape. */
export interface WhatsAppMessageRow {
  id: string;
  chatJid: string;
  fromMe: boolean;
  /** Unix milliseconds. */
  ts: number;
  /** WhatsApp's own content type: text, image, video, sticker, call, system, protocol… */
  type: string;
  text: string;
  /** Display name of who wrote it; empty when the chat's own name stands in (a 1:1). */
  sender: string;
  edited: boolean;
  media?: WhatsAppMedia;
}

/** One media answer: the stored descriptor, and the cached bytes when there are any. */
export interface WhatsAppMediaAnswer {
  info?: WhatsAppMedia;
  bytes?: Uint8Array;
}

/** What the account is doing, in the words a caller can act on. */
export interface WhatsAppTransportStatus {
  connection: 'connecting' | 'connected' | 'disconnected';
  /** Whether the account state on disk holds a pairing; `connection` says whether it is live. */
  paired: boolean;
}

/**
 * The WhatsApp transport seam (plan U3): one method per thing the adapter asks for, so the adapter
 * stops knowing whether an answer came from WhatsApp a second ago or from what the socket stored
 * last night. The implementation is `src/whatsapp/transport.ts` over the plugin's own store and
 * socket; nothing behind this seam speaks MCP or opens a loopback port.
 *
 * A read is a store read: it answers with the socket down, and an unpaired account answers an empty
 * list rather than an error (R5). A send needs the socket, and a send or read-receipt failure is
 * the socket's own error — the adapter classifies it (`src/whatsapp/failure.ts`) before the owner
 * reads anything.
 */
export interface WhatsAppTransport {
  /** One page of chats, newest activity first. `cursor` is the row offset the store pages by. */
  listChats(input: { cursor?: string; limit: number }): Promise<{ chats: WhatsAppChatRow[]; cursor?: string }>;
  /** The newest `limit` stored messages of one chat, oldest first. */
  openChat(input: { id: string; limit: number }): Promise<WhatsAppMessageRow[]>;
  /** The stored media descriptor, the cached bytes, or one download when the socket is open. */
  loadMedia(messageId: string): Promise<WhatsAppMediaAnswer>;
  /** Records where reading stopped; a live socket also tells WhatsApp. */
  markRead(input: { id: string; messageId?: string }): Promise<void>;
  /** Sends text over the socket. Rejects when there is no socket to send over. */
  sendText(input: { id: string; text: string }): Promise<void>;
  status(): Promise<WhatsAppTransportStatus>;
}

/**
 * Conversation summary as cached and listed (rpcContract `list` item).
 * The optional fields mirror the fields the shipped item schema already
 * carries: Gmail rows add recipients and attachment names, WhatsApp and
 * LinkedIn rows add an avatar, and group rows add participants.
 */
export interface Conversation {
  account: Account;
  id: string;
  title: string;
  preview: string;
  date: number;
  unread: boolean;
  sender?: string;
  avatarUrl?: string;
  recipients?: string;
  attachments?: string[];
  participants?: string[];
}

/** Attachment media descriptor on a message (rpcContract `media` output input). */
export interface MessageMedia {
  messageId: string;
  kind: MediaKind;
  cached: boolean;
  available: boolean;
  mime?: string;
  filename?: string;
  size?: number;
  /** Where the message points, for a shape that has a link but no thumbnail. */
  url?: string;
}

/** Messages (imsg) attachment slot: index-addressed, may be unavailable. */
export interface ImsgAttachment {
  index: number;
  name: string;
  available: boolean;
}

/** Incoming reaction (Messages and WhatsApp). */
export interface Reaction {
  sender: string;
  label: string;
}

/** Message shape across providers (rpcContract `message` schema). */
export interface Message {
  sender: string;
  text: string;
  date: number;
  fromMe?: boolean;
  /** Gmail HTML body, bounded like messageHtml() in server.ts. */
  html?: string;
  to?: string;
  cc?: string;
  replyTo?: string;
  subject?: string;
  messageId?: string;
  references?: string;
  suggestedTo?: string;
  suggestedCc?: string;
  media?: MessageMedia;
  reactions?: Reaction[];
  /** Gmail attachment filenames (rpcContract `attachments`). */
  attachments?: string[];
  /** Gmail message id, used by a `kind: 'attachment'` media request. */
  gmailId?: string;
  /** Messages attachments (rpcContract `imsgAttachments`). */
  imsgAttachments?: ImsgAttachment[];
  /** Messages edit indicator. */
  edited?: boolean;
  /** Messages thread indicator (context only; full threading is a non-goal). */
  replyContext?: boolean;
  /** Messages stable row id, used by a `kind: 'imsg'` media request. */
  imsgId?: string;
  /** A message that is a link rather than a picture or text (a shared post). */
  link?: string;
}

/**
 * Failure of one provider during a gateway operation; other providers continue
 * (rpcContract `list` returns `errors`). Carries classification text only —
 * never raw provider payloads. Produced exclusively by
 * `toProviderError()` in src/adapters/provider-error.ts, which enforces the
 * redaction rule; the gateway renders `message` to a string at the RPC boundary.
 */
export interface ProviderError {
  account: Account;
  source: 'gmail' | 'whatsapp' | 'imsg' | 'linkedin';
  /** Redacted, single line, at most 300 characters. */
  message: string;
}

/**
 * One media answer for every source: base64 data URLs bounded by IMAGE_LIMIT,
 * VIDEO_LIMIT, IMSG_IMAGE_LIMIT and the 8 MiB RPC frame cap. A Gmail attachment
 * also carries its `size`; a LinkedIn shared post carries its `url` instead of
 * image data. OQ-5 may switch the transport to a handle; only this type changes
 * then.
 */
export interface MediaPayload {
  dataUrl: string;
  mime: string;
  filename?: string;
  size?: number;
  url?: string;
}

/** Draft for a send; only the kinds whose provider implements `send`. */
export type SendDraft = GmailDraft | WhatsAppDraft;

/** Mirrors the rpcContract `send_gmail` input. */
export interface GmailDraft {
  kind: 'gmail';
  account: GmailAccount;
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  text: string;
  threadId?: string;
  inReplyTo?: string;
  references?: string;
  attachments?: { name: string; mimeType: string; size: number; data: string }[];
}

/** WhatsApp reply text for an open conversation (propose → confirm flow). */
export interface WhatsAppDraft {
  kind: 'whatsapp';
  account: 'whatsapp';
  conversationId: string;
  text: string;
}

/**
 * Authorization for a send. WhatsApp's proposal confirmation flows through the
 * proposal id. The owner enabled Messages sending directly on 2026-11-02, so
 * imessage sends carry no approval field; the reserved host-issued approval
 * (docs/plans/2026-10-29-messages-send-approval-proposal.md, GH #6556) remains
 * unset and no adapter may treat its absence as consent for anything else.
 */
export interface SendAuthorization {
  approval?: { id: string; hash: string };
}

/** Mirrors the rpcContract `action` output and `send_gmail` output. */
export interface SendReceipt {
  status: string;
  text?: string;
}

/**
 * Non-send operations (rpcContract `action`). Per-provider support today:
 * - gmail (gmail-personal, gmail-business): read, unread, archive
 * - whatsapp: read, unread, reply (sent over the plugin's own socket)
 * - imessage: read, unread (local state), reply (sends through `imsg send`)
 * - linkedin: read, unread, reply, confirm / reject (an invitation answer)
 * `confirm` and `reject` no longer mean a proposal: the WhatsApp proposal flow is gone,
 * and those two kinds now carry LinkedIn's accept / ignore of an invitation.
 */
export type ActionKind = 'read' | 'unread' | 'archive' | 'reply' | 'confirm' | 'reject';

/** Mirrors the optional fields of the rpcContract `action` input. */
export interface ActionOptions {
  text?: string;
}

export interface ActionResult {
  status: string;
  text?: string;
}

/**
 * What a person knows one source by, and how the panel paces it: declared by the adapter that owns
 * the transport, so a label, an icon or a cadence has exactly one home (`registrySources()`), and
 * nothing outside src/adapters/ keeps a copy. Identity only: what a source can *do* is
 * `capabilities()` and stays there.
 */
export interface SourceDeclaration {
  /** The name a person knows this source by; the panel and the `#`-mention context show it. */
  label: string;
  /** The icon name the panel's filter and the `#` picker draw beside the source. */
  icon: string;
  /** Background refresh cadence for this source's newest rows, in milliseconds. */
  pollIntervalMs: number;
  /**
   * How often the open conversation is re-read, when this source's read is cheap enough to follow
   * a list refresh. Absent for a source the panel does not watch.
   */
  watchIntervalMs?: number;
  /**
   * Rows one "show older" page asks this source for. Absent for a source that cannot page: its
   * `list` answers the newest page and ignores a cursor.
   */
  pageSize?: number;
}

/** Every source's declaration, keyed as the `sources` RPC returns them. */
export type SourceMap = Record<Account, SourceDeclaration>;

/**
 * What an adapter supports; the gateway consults this instead of try/catch.
 * The keys are named once, in `src/adapters/capability.ts`, and documented there;
 * a capability added to that list is required of every declaration.
 */
export interface Capabilities extends Record<CapabilityKey, boolean> {
  /** Annotation-only pending OQ-4 (search ownership). */
  search?: boolean;
}

export interface ListResult {
  items: Conversation[];
  /** Where this source's next older page begins; absent when it has nothing older to show. */
  cursor?: string;
  errors: ProviderError[];
}

/** The conversation limit an RPC call carries (`sync` input, `list` options). */
export interface OpenOptions {
  limit?: number;
}

export interface OpenResult {
  messages: Message[];
  /** The provider failed; these messages were not verified live. */
  cacheFallback?: boolean;
  cursor?: string;
}

/** Mirrors the rpcContract `linkedin_record` input op. */
export type LinkedInRecordOp = 'arm' | 'clear' | 'dump';

/** One observed write, exactly as the page made it. No headers, no cookies, no tokens. */
export interface RecordedWrite {
  method: string;
  url: string;
  body: string;
  capturedAt: number;
}

export interface LinkedInRecordResult {
  /** Present for `arm`: whether the page installed the wrapper. */
  installed?: boolean;
  /** Present for `arm`: whether the recorder is watching. */
  recording?: boolean;
  /** Present for `dump`: what the recorder has seen, newest last. */
  writes?: RecordedWrite[];
  /** Present for `dump`: whether the wrappers were called at all, and why they rejected anything. */
  seen?: LinkedInRecorderStats | null;
}

export interface LinkedInReplayInput {
  write: RecordedWrite;
  conversationId: string;
  /** Replacement text; omitted replays the recorded text unchanged. */
  text?: string;
  /** Explicit approval for this one send. Without it, replay refuses. */
  confirm?: boolean;
}

export interface LinkedInReplayResult {
  /** Whether the page accepted the write; a refusal carries the status it reported. */
  ok: boolean;
  status: number;
}

/** One source's refresh answer: its rows as of now, and why a delta check skipped a live read. Mirrors the rpcContract `sync` output. */
export interface SyncResult {
  items: Conversation[];
  updatedAt: number;
  /** Why the source read or skipped, when it has a delta check. */
  reason?: string;
  /**
   * Where the source's next older page begins, when it can page (`list(cursor)` takes it back).
   * The gateway keeps it, not the panel: a refresh must not restart paging the owner began.
   */
  cursor?: string;
}

/**
 * One provider behind the gateway. The registry (src/adapters/index.ts,
 * state 3) maps Account → adapter; the gateway owns caching, search, audit,
 * error isolation, and the send policy layer (spec goals 1–3). The gateway
 * dispatches `media` through the registry; the request, not the RPC name, says
 * how the file is addressed.
 */
export interface Adapter {
  /** What a person knows this source by, and how the panel paces it. */
  source: SourceDeclaration;
  capabilities(): Capabilities;
  /**
   * Conversation rows for this source. A source that can page takes the `cursor` its previous
   * answer returned and answers with the next older page plus that page's own cursor; a source
   * that cannot ignores it. `opts.limit` is the `sync` limit and defaults to what the
   * whole-inbox `list` asks for.
   */
  list(cursor?: string, opts?: OpenOptions): Promise<ListResult>;
  /**
   * The source's refresh answer: live rows, or cached ones a delta check just
   * proved current. The adapter decides how; the caller never picks by name.
   */
  sync(opts?: OpenOptions): Promise<SyncResult>;
  open(id: string, opts?: OpenOptions): Promise<OpenResult>;
  /**
   * The one media primitive. A `message` slot serves an inline picture or video,
   * an `imsg` slot serves a Messages attachment inside its conversation, and an
   * `attachment` names a bounded Gmail file. The adapter refuses a kind its
   * source cannot serve.
   */
  media(request: MediaRequest): Promise<MediaPayload>;
  action(kind: ActionKind, id: string, opts?: ActionOptions): Promise<ActionResult>;
  send?(draft: SendDraft, authorization: SendAuthorization): Promise<SendReceipt>;

  // The entry points below are the shipped RPC coordinates that `list`, `open`,
  // `media` and `action` cannot express yet. Each is implemented by exactly the
  // adapters whose source has that shape:

  /**
   * Arm, clear, or dump the in-page write recorder (slice D). Arming watches
   * `window.fetch`; nothing is sent by these calls.
   */
  record?(op: LinkedInRecordOp): Promise<LinkedInRecordResult>;
  /**
   * Re-issue one recorded write. It refuses anything that is not a message send
   * to the named conversation, and refuses to run without explicit approval.
   */
  replay?(input: LinkedInReplayInput): Promise<LinkedInReplayResult>;

  /**
   * Cache-only decoration for one row the gateway returns straight from the
   * cache (`cached`, `sync`, `list`). No provider I/O: WhatsApp group
   * rows carry the participants their cached thread remembers.
   */
  decorate?(item: Conversation): Conversation;
  /**
   * Cache-only repair of a thread read straight from the cache (`cached_open`).
   * A thread written by an older build carries legacy senders and noise; the
   * adapter that owns the shape fixes them without reading its source again.
   */
  repairThread?(id: string, messages: Message[]): Promise<Message[]>;
}