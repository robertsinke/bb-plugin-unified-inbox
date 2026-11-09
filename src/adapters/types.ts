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
 * Chat ids stay a fixed set. A Gmail id is a mailbox address, or a legacy file
 * that has not been renamed yet. The compiler cannot name every mailbox, so
 * `Account` is the id a registry currently holds.
 */
export const legacyGmailAccounts = ['gmail-personal', 'gmail-business'] as const;
export const chatAccounts = ['whatsapp', 'imessage', 'linkedin'] as const;
/** Selectors for the two local gws directories. Not the stored id once a mailbox has an address. */
export const gmailAccounts = legacyGmailAccounts;
export const accounts = [...legacyGmailAccounts, ...chatAccounts] as const;

export type LegacyGmailAccount = (typeof legacyGmailAccounts)[number];
export type ChatAccount = (typeof chatAccounts)[number];

/** The address each legacy file sends as. The accent class keeps this id after the file is renamed. */
export const legacyGmailAddresses: Record<LegacyGmailAccount, string> = {
  'gmail-personal': 'personal@example.com',
  'gmail-business': 'work@example.com',
};

/** A connected source id: chat, legacy Gmail, or a mailbox address. */
export type Account = string;
/** A Gmail credential id: a legacy file name, or the mailbox address. */
export type GmailAccount = string;

const MAILBOX_ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isLegacyGmailAccount(value: string): value is LegacyGmailAccount {
  return (legacyGmailAccounts as readonly string[]).includes(value);
}

export function isChatAccount(value: string): value is ChatAccount {
  return (chatAccounts as readonly string[]).includes(value);
}

/**
 * A CSS-safe accent token. Chat ids and legacy Gmail ids are already safe.
 * A renamed mailbox keeps its legacy token, so the red and blue rules still match.
 * shortcut: a mailbox that was never one of these two files has no color rule, add one when a third mailbox needs its own color.
 */
export function accentToken(account: string): string {
  if (isChatAccount(account) || isLegacyGmailAccount(account)) return account;
  const legacy = legacyGmailAccounts.find(id => legacyGmailAddresses[id] === account.toLowerCase());
  return legacy ?? account;
}

/** A mailbox address. Comparison and storage use the lowercased form. */
export function isMailboxAddress(value: string): boolean {
  return MAILBOX_ADDRESS.test(value);
}

/** An id the RPC schema can name before the registry is asked. */
export function isAccountId(value: string): boolean {
  return isChatAccount(value) || isLegacyGmailAccount(value) || isMailboxAddress(value);
}

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

/** One contact photo as Google answers it: the address it belongs to, and the picture. */
export interface GooglePhoto {
  /** Lowercased: a face is keyed by address, and two spellings of one address are one face. */
  address: string;
  url: string;
}

/** One page of one People listing. `nextPageToken` is absent on the last page. */
export interface GooglePeoplePage {
  photos: GooglePhoto[];
  nextPageToken?: string;
}

/**
 * The People API seam (INBOX-38): two listings, one per grant. Google splits the address book into
 * saved contacts and other contacts, and a consent can cover one and not the other, so they are
 * separate calls and a refusal of one must not cost the other. The implementation is
 * `src/google-people.ts`; nothing behind this seam shells out.
 */
export interface GooglePeopleClient {
  /** The contacts the owner saved. Needs `contacts.readonly`. */
  connections(pageToken?: string): Promise<GooglePeoplePage>;
  /** The people he emailed but never saved. Needs `contacts.other.readonly`. */
  otherContacts(pageToken?: string): Promise<GooglePeoplePage>;
}

/** Which implementation answers a People call is wiring (`server.ts`), as with `GmailTransport`. */
export type GooglePeopleTransport = (account: GmailAccount) => GooglePeopleClient;

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
  /** Stored reactions. A row with an empty sender still carries its emoji. */
  reactions?: Reaction[];
  /** Stored quote columns, when the row has a target, a sender, or text. */
  quote?: Message['quote'];
  /** Question, options, counts, and the owner's ticks. Absent on every other message. */
  poll?: Message['poll'];
}

/** One media answer: the stored descriptor, the cached bytes when there are any, and why there are none. */
export interface WhatsAppMediaAnswer {
  info?: WhatsAppMedia;
  bytes?: Uint8Array;
  /**
   * The bytes are askable but no socket could be opened to fetch them: a state the owner can act on,
   * not a verdict on the message. Absent means the answer is about the message itself.
   */
  notConnected?: boolean;
}

/**
 * One chat with every stored message, as the search corpus reads it: what a conversation search
 * can reach without a page, a socket or a network call.
 */
export interface WhatsAppCorpusChat extends WhatsAppChatRow {
  /** Every stored message of the chat, oldest first. */
  messages: WhatsAppMessageRow[];
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
  /**
   * Every stored chat with every stored message — the corpus a search reads once, not a page. A
   * store read like `listChats`: no socket, and nothing here opens one.
   */
  listCorpus(): Promise<WhatsAppCorpusChat[]>;
  /** The stored media descriptor, the cached bytes, or one download when the socket is open. */
  loadMedia(messageId: string): Promise<WhatsAppMediaAnswer>;
  /**
   * The chat picture the store already knows, or nothing. Synchronous by design: the row is being
   * drawn, so a list never waits on WhatsApp. A jid with no picture stored, or one fetched longer
   * ago than the URL can be trusted, is asked of the open socket in the background — the next draw
   * has it, and with no socket to ask the row keeps drawing initials.
   */
  avatarUrl(jid: string): string | undefined;
  /**
   * What the panel can know about a message's media before it asks for bytes — including a
   * document's declared size, which is what lets a caller refuse an oversized file without
   * downloading it.
   */
  mediaFacts(messageId: string): Promise<WhatsAppMedia | undefined>;
  /** Take back cached bytes that will never be shown, so a refusal leaves no file behind. */
  discardMedia(messageId: string): Promise<void>;
  /** Records where reading stopped; a live socket also tells WhatsApp. */
  markRead(input: { id: string; messageId?: string }): Promise<void>;
  /**
   * The stored envelope for one message id, for a quote reply. Undefined when the row is missing
   * or its envelope will not parse. A store read: it does not open a socket.
   */
  storedEnvelope(messageId: string): Promise<unknown>;
  /** Sends text over the socket. `quoted` is a stored envelope. Rejects when there is no socket. */
  sendText(input: { id: string; text: string; quoted?: unknown }): Promise<void>;
  /**
   * The chat id for these digits. A stored contact answers without opening a socket. An open socket
   * confirms the number. No confirmation means nothing is sent.
   */
  resolvePhone(digits: string): Promise<string>;
  /**
   * Sends one reaction for a message id. An empty emoji removes it. Rejects when there is no
   * socket. This call does not write a reaction row; ingest does that when the echo arrives.
   */
  sendReaction(input: { id: string; messageId: string; emoji: string }): Promise<void>;
  /** The poll a vote would change, from the store. Undefined when the row is not a poll. */
  pollChoices(messageId: string): { options: string[]; selectableCount: number } | undefined;
  /** Sends one vote. An empty list clears it. Rejects when there is no socket. Does not write the vote row. */
  sendVote(input: { id: string; messageId: string; options: string[] }): Promise<void>;
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
  /** A sent reply newer than the received message. `preview` shows it too. The classifier reads this so the line is yours. */
  sentSnippet?: string;
  date: number;
  unread: boolean;
  sender?: string;
  avatarUrl?: string;
  /**
   * The address `sender` displays, lowercased; empty when the header names none. It is what a face
   * is keyed on (`src/gmail-faces.ts`), so it is carried on the row: a cached row that kept only the
   * display name could never be given the picture that arrived after it was cached. Gmail rows only.
   */
  senderAddress?: string;
  recipients?: string;
  attachments?: string[];
  participants?: string[];
  /** The decision model's yes/no for this conversation. Absent until a new message has been judged. */
  needsAttention?: 'yes' | 'no';
  /** The owner cleared Needed, and that clear can still be undone. */
  attentionDismissed?: boolean;
  /**
   * The row is the listing snippet. Sender, subject, date and unread arrive when the row is on
   * screen. Gmail older pages only.
   */
  listedOnly?: boolean;
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
  /** Gmail image parts addressed by content id. Filenames only; the HTML stays free of the bytes. */
  inline?: { contentId: string; filename: string }[];
  /** Gmail message id, used by a `kind: 'attachment'` media request. */
  gmailId?: string;
  /** Messages attachments (rpcContract `imsgAttachments`). */
  imsgAttachments?: ImsgAttachment[];
  /** Messages edit indicator. */
  edited?: boolean;
  /** Messages thread indicator (context only; full threading is a non-goal). */
  replyContext?: boolean;
  /** The earlier message this one quotes, when the source stored a target, a sender, or text. */
  quote?: {
    targetId?: string;
    sender?: string;
    text?: string;
  };
  /** A WhatsApp poll. Counts only. `selected` is the owner's own choice. */
  poll?: {
    question: string;
    selectableCount: number;
    options: { name: string; count: number; selected: boolean }[];
  };
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
  /** Absent when the file was too large to hand to the browser and was saved to disk instead. */
  dataUrl?: string;
  /** Where a file over the inline ceiling landed; the panel reports it rather than downloading twice. */
  savedPath?: string;
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
 * - imessage: read (inbox dot only; Messages keeps its own unread count), unread (a local mark), reply (sends through `imsg send`)
 * - linkedin: read, unread, reply, confirm / reject (an invitation answer)
 * `confirm` and `reject` no longer mean a proposal: the WhatsApp proposal flow is gone,
 * and those two kinds now carry LinkedIn's accept / ignore of an invitation.
 */
export type ActionKind = 'read' | 'unread' | 'archive' | 'reply' | 'confirm' | 'reject' | 'react' | 'vote';

/** Mirrors the optional fields of the rpcContract `action` input. */
export interface ActionOptions {
  text?: string;
  /** The message a reaction or a targeted reply names. Absent on a conversation reply. */
  messageId?: string;
  /** One of the four shared reactions. Required when `kind` is `react`. */
  emoji?: string;
  /** Remove the named reaction. Refused while the source declares `reactRemove` false. */
  remove?: boolean;
  /** The full next selection on a poll. An empty list clears the owner's vote. */
  options?: string[];
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
  /** Declared glyph name. The `#` picker draws `<pluginId>/<icon>` and does not repeat the source name. */
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
 * One conversation the search index should hold, with the body text its source already has. A
 * source that keeps its own corpus answers `item` plus the messages it stores; one that does not
 * answers the row alone and the index reads the cached thread.
 */
export interface SearchRow {
  item: Conversation;
  messages?: Message[];
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
  /** The stored poll a vote names. A store read. Absent on sources that cannot vote. */
  pollOf?(messageId: string): { options: string[]; selectableCount: number } | undefined;
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
   * Fill one listing row. Gmail reads that one thread as metadata. A source whose rows are already
   * complete does not implement it.
   */
  disclose?(id: string): Promise<Conversation>;
  /**
   * Cache-only repair of a thread read straight from the cache (`cached_open`).
   * A thread written by an older build carries legacy senders and noise; the
   * adapter that owns the shape fixes them without reading its source again.
   */
  repairThread?(id: string, messages: Message[]): Promise<Message[]>;
  /**
   * The conversations this source can answer for, past the newest page, without a network call or
   * a socket: a source whose data is already on this disk says so, and search reaches all of it.
   * Absent means the cache's listing is the corpus, which is what every networked source has.
   */
  searchCorpus?(): SearchRow[] | Promise<SearchRow[]>;
}
