// Shared adapter contract for the unified inbox gateway.
// Spec: specs/001-unified-inbox-gateway/spec.md — Migration state 1: types only.
// Nothing imports this module yet; adapters (state 2) and the registry
// (state 3) adopt these shapes without redefining them.
//
// Shapes mirror the RPC contract in server.ts (item/message zod schemas)
// so state 3 rewires routing without any payload conversion.

/** Registry keys: one adapter per account. */
export type Account = 'personal' | 'business' | 'whatsapp' | 'imessage';

/** Gmail accounts are the only ones with a `send_gmail` draft today. */
export type GmailAccount = Extract<Account, 'personal' | 'business'>;

/** Conversation summary as cached and listed (rpcContract `list` item). */
export interface Conversation {
  account: Account;
  id: string;
  title: string;
  preview: string;
  date: number;
  unread: boolean;
  sender?: string;
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
  /** Messages attachments (metadata key `imsgAttachments`). */
  attachments?: ImsgAttachment[];
  /** Messages edit indicator. */
  edited?: boolean;
  /** Messages thread indicator (context only; full threading is a non-goal). */
  replyContext?: boolean;
  /** Messages stable row id, used by `imsg_media`. */
  imsgId?: string;
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
  source: 'gmail' | 'whatsapp' | 'imsg';
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
 * Authorization for a send. Today only WhatsApp's proposal confirmation flows
 * through here. The human-approval boundary (see
 * docs/plans/2026-10-29-messages-send-approval-proposal.md and GH #6556)
 * will add a host-issued approval; the field stays reserved and unset until
 * then. No adapter may treat a missing approval as implicit consent.
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
 * - imessage: none — all six variants are rejected server-side; sending stays
 *   disabled until the approval boundary lands.
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
  /** gmail and whatsapp implement `send`; imessage does not. The policy layer keeps gmail disabled. */
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

/** Mirrors the rpcContract `list_source` limit. */
export interface OpenOptions {
  limit?: number;
}

export interface OpenResult {
  messages: Message[];
  cursor?: string;
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
  list(cursor?: string): Promise<ListResult>;
  open(id: string, opts?: OpenOptions): Promise<OpenResult>;
  media(account: Account, id: string, index: number): Promise<MediaPayload>;
  action(kind: ActionKind, id: string, opts?: ActionOptions): Promise<ActionResult>;
  send?(draft: SendDraft, authorization: SendAuthorization): Promise<SendReceipt>;
}