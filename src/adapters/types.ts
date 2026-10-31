// Shared adapter contract for the unified inbox gateway.
// Spec: specs/001-unified-inbox-gateway/spec.md — Migration state 3: the
// adapters in this directory and the registry in ./index.ts implement these
// shapes, and server.ts routes through the registry instead of branching on
// the account name.
//
// Shapes mirror the RPC contract in server.ts (item/message zod schemas)
// so the transport rewires routing without any payload conversion.

/**
 * Registry keys: one adapter per account, and the `account` value on every RPC
 * input. The tuple is the canonical list — `server.ts` builds its zod enum from
 * it, so a new source is one entry here plus one adapter.
 */
export const accounts = ['personal', 'business', 'whatsapp', 'imessage', 'linkedin'] as const;

export type Account = (typeof accounts)[number];

/** Gmail accounts are the only ones with a `send_gmail` draft today. */
export type GmailAccount = Extract<Account, 'personal' | 'business'>;

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
  kind: 'image' | 'sticker' | 'video';
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
  /** Gmail message id, used by the `attachment` RPC. */
  gmailId?: string;
  /** Messages attachments (rpcContract `imsgAttachments`). */
  imsgAttachments?: ImsgAttachment[];
  /** Messages edit indicator. */
  edited?: boolean;
  /** Messages thread indicator (context only; full threading is a non-goal). */
  replyContext?: boolean;
  /** Messages stable row id, used by `imsg_media`. */
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
 * Media payload as served today: base64 data URLs bounded by IMAGE_LIMIT,
 * VIDEO_LIMIT, IMSG_IMAGE_LIMIT and the 8 MiB RPC frame cap. OQ-5 may switch
 * the transport to a handle; only this type changes then.
 */
export interface MediaPayload {
  dataUrl: string;
  mime: string;
  filename?: string;
}

/** Draft for a send; only the kinds whose provider implements `send`. */
export type SendDraft = GmailDraft | WhatsAppDraft;

/** Mirrors the rpcContract `send_gmail` input. */
export interface GmailDraft {
  kind: 'gmail';
  account: GmailAccount;
  to: string;
  cc?: string;
  subject: string;
  text: string;
  threadId?: string;
  inReplyTo?: string;
  references?: string;
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
  proposalId?: number;
  approval?: { id: string; hash: string };
}

/** Mirrors the rpcContract `action` output and `send_gmail` output. */
export interface SendReceipt {
  status: string;
  proposalId?: number;
  text?: string;
}

/**
 * Non-send operations (rpcContract `action`). Per-provider support today:
 * - gmail (personal, business): read, unread, archive
 * - whatsapp: read, unread, reply (propose), confirm, reject
 * - imessage: read, unread (local state), reply (sends through `imsg send`);
 *   archive, confirm, and reject are refused.
 */
export type ActionKind = 'read' | 'unread' | 'archive' | 'reply' | 'confirm' | 'reject';

/** Mirrors the optional fields of the rpcContract `action` input. */
export interface ActionOptions {
  text?: string;
  proposalId?: number;
}

export interface ActionResult {
  status: string;
  proposalId?: number;
  text?: string;
}

/** What an adapter supports; the gateway consults this instead of try/catch. */
export interface Capabilities {
  /** gmail, whatsapp, and imessage implement `send`; the policy layer keeps gmail disabled. */
  send: boolean;
  markRead: boolean;
  archive: boolean;
  media: boolean;
  attachments: boolean;
  /** Annotation-only pending OQ-4 (search ownership). */
  search?: boolean;
}

export interface ListResult {
  items: Conversation[];
  /** Providers re-list in full today; kept for state-3 parity with cursored sources. */
  cursor?: string;
  errors: ProviderError[];
}

/** The conversation limit an RPC call carries (`list_source` input, `list` options). */
export interface OpenOptions {
  limit?: number;
}

export interface OpenResult {
  messages: Message[];
  cursor?: string;
}

/** Mirrors the rpcContract `linkedin_sync` output. */
export interface SyncResult {
  items: Conversation[];
  updatedAt: number;
  /** Why the source read or skipped, when it has a delta check. */
  reason?: string;
}

/** Mirrors the rpcContract `attachment` output: a bounded, always-named file. */
export interface AttachmentPayload {
  dataUrl: string;
  mime: string;
  filename: string;
  size: number;
}

/**
 * One provider behind the gateway. The registry (src/adapters/index.ts,
 * state 3) maps Account → adapter; the gateway owns caching, search, audit,
 * error isolation, and the send policy layer (spec goals 1–3). `media` takes
 * the account routing key so the gateway can dispatch and the adapter can
 * verify the registry binding (unifying `media` and `imsg_media` is T9).
 */
export interface Adapter {
  capabilities(): Capabilities;
  /**
   * Conversation rows for this source. `cursor` is unused by every provider
   * today (each re-lists in full); `opts.limit` is the `list_source` limit and
   * defaults to what the whole-inbox `list` asks for.
   */
  list(cursor?: string, opts?: OpenOptions): Promise<ListResult>;
  open(id: string, opts?: OpenOptions): Promise<OpenResult>;
  media(account: Account, id: string, index: number): Promise<MediaPayload>;
  action(kind: ActionKind, id: string, opts?: ActionOptions): Promise<ActionResult>;
  send?(draft: SendDraft, authorization: SendAuthorization): Promise<SendReceipt>;

  // The entry points below are the shipped RPC coordinates that `list`, `open`,
  // `media` and `action` cannot express yet. Each is implemented by exactly the
  // adapters whose source has that shape, and each is a candidate for the
  // toolbox unification (T9):

  /** LinkedIn's live read, behind `linkedin_sync`; `list` answers from the cache. */
  sync?(): Promise<SyncResult>;
  /** Gmail attachment by message id and filename, behind `attachment` (T9 → `media`). */
  gmailAttachment?(gmailId: string, filename: string): Promise<AttachmentPayload>;
  /** Messages attachment by (chat, message, index), behind `imsg_media` (T9 → `media`). */
  imsgMedia?(chatId: string, messageId: string, index: number): Promise<MediaPayload>;

  /**
   * Cache-only decoration for one row the gateway returns straight from the
   * cache (`cached`, `list_source`, `list`). No provider I/O: WhatsApp group
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