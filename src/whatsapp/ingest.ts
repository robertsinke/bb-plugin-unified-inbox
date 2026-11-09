// Baileys events → the WhatsApp store (plan D5, unit U2).
//
// Lifted from WhatsAgent's `server/channels/whatsapp/ingest.ts` with its store calls rewired onto
// `./store.ts` and its WhatsAgent-only bookkeeping removed (per-chat unread counting, mute, archive
// and agent state — none of which this plugin stores or shows). Everything that made the lift worth
// doing is unchanged:
//
// - **Containment.** Baileys re-emits a consolidated event map inside one loop, so a handler that
//   throws silently drops every later key of that flush. Every binding here is wrapped, and nothing
//   below may throw into the socket.
// - **Identity first.** A key carrying both `remoteJid` and `remoteJidAlt` *is* a LID/phone mapping,
//   so it is learned before the message row is written and the same person never opens two chats.
// - **The envelope.** `raw` is the full `WAMessage` in `BufferJSON` form: without it Baileys cannot
//   answer `getMessage(key)`, a decryption retry cannot decrypt, and an edit cannot derive its key.
// - **Commit before you announce.** Chat merges are collected inside the transaction and published
//   after it commits: until then the merged-away chat row still exists.
import {
  BufferJSON,
  extractMessageContent,
  getContentType,
  isJidGroup,
  jidNormalizedUser,
  proto,
  type Chat,
  type ChatUpdate,
  type Contact,
  type GroupMetadata,
  type LIDMapping,
  type MessageUpsertType,
  type WAMessage,
  type WAMessageKey,
  type WAMessageUpdate,
} from 'baileys';
import { decryptMessageEdit, messageSecretFromRaw } from './message-edit.ts';
import { decryptPollSelection, isPollUpdateType, pollBytes, pollFacts, pollPartyJid, pollSearchText, POLL_TYPE } from './poll.ts';
import {
  isPhoneShapedLabel,
  usableName,
  type ChatKind,
  type ChatMerge,
  type Message,
  type WhatsAppStore,
} from './store.ts';

export type HistorySetPayload = {
  chats: Chat[];
  contacts: Contact[];
  messages: WAMessage[];
  isLatest?: boolean;
  progress?: number | null;
};

export type MessagesUpsertPayload = { messages: WAMessage[]; type: MessageUpsertType };

export type MessagesUpdatePayload = WAMessageUpdate[];

export type MessagesReactionPayload = Array<{ key: WAMessageKey; reaction: proto.IReaction }>;

export type SyncProgress = {
  /** Baileys' own percentage. Kept for logs; the panel must not render it. */
  progress: number | null;
  isLatest: boolean;
  /** Chats in this batch. Baileys never tells us the total, so counts only. */
  chats: number;
  /** Messages in this batch. */
  messages: number;
};

export type IngestListener = {
  on(event: string, handler: (...args: any[]) => void): unknown;
};

export type AttachIngestOptions = {
  onSyncProgress?: (progress: SyncProgress) => void;
  onMessageIngested?: (message: Message) => void;
  onMessageUpdated?: (message: Message) => void;
  /** Two chat rows turned out to be the same person and were merged; fired after the commit. */
  onChatsMerged?: (merge: ChatMerge) => void;
  /** The linked account's jid, used to decrypt a vote this account cast. Absent in tests that only decrypt other people. */
  meJid?: () => string | undefined;
  /** A handler (or one of its consumer callbacks) threw and was contained. */
  onHandlerError?: (context: { event: string; error: unknown }) => void;
};

type ContactPatch = Partial<Contact> & Pick<Contact, 'id'>;

type LongLike = { toNumber(): number };

function toNumber(value: number | LongLike | null | undefined): number | null {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'object' && typeof value.toNumber === 'function') {
    const n = value.toNumber();
    return Number.isFinite(n) ? n : null;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function chatKindFromJid(jid: string): ChatKind {
  return isJidGroup(jid) ? 'group' : '1:1';
}

export function classifyMessageType(msg: WAMessage): string {
  if (msg.messageStubType != null) {
    const stub = Number(msg.messageStubType);
    // Call stubs; anything else is still a typed placeholder rather than an empty bubble.
    if (stub === 40 || stub === 41 || stub === 42 || stub === 46 || stub === 50) return 'call';
    return 'system';
  }

  const content = extractMessageContent(msg.message);
  const key = getContentType(content);
  if (!key) return 'unknown';

  switch (key) {
    case 'conversation':
    case 'extendedTextMessage':
      return 'text';
    case 'imageMessage':
      return 'image';
    case 'videoMessage':
      return 'video';
    case 'audioMessage':
      return 'audio';
    case 'documentMessage':
      return 'document';
    case 'stickerMessage':
      return 'sticker';
    case 'reactionMessage':
      return 'reaction';
    case 'contactMessage':
    case 'contactsArrayMessage':
      return 'contact';
    case 'locationMessage':
    case 'liveLocationMessage':
      return 'location';
    case 'pollCreationMessage':
    case 'pollCreationMessageV2':
    case 'pollCreationMessageV3':
    case 'pollCreationMessageV5':
      return POLL_TYPE;
    case 'pollUpdateMessage':
      return 'pollUpdate';
    default:
      return key.replace(/Message$/, '') || 'unknown';
  }
}

export function extractMessageText(msg: WAMessage): string | null {
  const content = extractMessageContent(msg.message);
  if (!content) return null;

  if (typeof content.conversation === 'string' && content.conversation.length > 0) return content.conversation;
  if (content.extendedTextMessage?.text) return content.extendedTextMessage.text;
  if (content.imageMessage?.caption) return content.imageMessage.caption;
  if (content.videoMessage?.caption) return content.videoMessage.caption;
  if (content.documentMessage?.caption) return content.documentMessage.caption;
  if (content.reactionMessage?.text) return content.reactionMessage.text;
  return null;
}

type QuoteSnapshot = { targetId: string; sender: string | null; type: string; text: string | null };

/**
 * Quote-preview text. Richer than {@link extractMessageText}: a quote inset must describe subtypes
 * that have no caption (location, contact, sticker, audio). Quote-only — the main message `text`
 * column keeps the caption-only contract so a media bubble does not render a location name as body.
 */
function extractQuoteText(quoted: WAMessage): string | null {
  const content = extractMessageContent(quoted.message);
  if (!content) return null;

  const caption =
    (typeof content.conversation === 'string' && content.conversation.length > 0 ? content.conversation : null) ??
    content.extendedTextMessage?.text ??
    content.imageMessage?.caption ??
    content.videoMessage?.caption ??
    content.documentMessage?.caption ??
    content.reactionMessage?.text ??
    null;
  if (caption) return caption;

  if (content.locationMessage) {
    const name = content.locationMessage.name?.trim();
    if (name) return name;
    const address = content.locationMessage.address?.trim();
    if (address) return address;
    return null;
  }
  if (content.liveLocationMessage) {
    const live = content.liveLocationMessage.caption?.trim();
    return live ? live : null;
  }
  if (content.contactMessage) {
    const name = content.contactMessage.displayName?.trim();
    return name ? name : null;
  }
  if (content.contactsArrayMessage) {
    const name = content.contactsArrayMessage.displayName?.trim();
    return name ? name : null;
  }
  if (content.documentMessage) {
    const title = content.documentMessage.title?.trim();
    if (title) return title;
    const fileName = content.documentMessage.fileName?.trim();
    if (fileName) return fileName;
    return null;
  }
  return null;
}

function messageContextInfo(message: proto.IMessage | null | undefined): proto.IContextInfo | undefined {
  const content = extractMessageContent(message);
  const type = getContentType(content);
  if (!content || !type) return undefined;
  const value = (content as Record<string, unknown>)[type];
  if (!value || typeof value !== 'object' || !('contextInfo' in value)) return undefined;
  return (value as { contextInfo?: proto.IContextInfo | null }).contextInfo ?? undefined;
}

function quoteSnapshot(msg: WAMessage): QuoteSnapshot | null {
  const context = messageContextInfo(msg.message);
  if (!context?.stanzaId || !context.quotedMessage) return null;
  const quoted = { message: context.quotedMessage } as WAMessage;
  return {
    targetId: context.stanzaId,
    sender: context.participant ?? null,
    type: classifyMessageType(quoted),
    text: extractQuoteText(quoted),
  };
}

/** A JID WhatsApp actually sent. An empty string is how a 1:1 key says "no participant". */
function blankableJid(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function chatJidFromMessage(msg: WAMessage): string | undefined {
  const key = msg.key;
  if (!key) return undefined;
  // Group messages: remoteJid is the group; 1:1 uses remoteJid (or remoteJidAlt).
  return key.remoteJid ?? key.remoteJidAlt ?? undefined;
}

function lidPhonePair(
  first: string | null | undefined,
  second: string | null | undefined,
): LIDMapping | undefined {
  if (!first || !second || first === second) return undefined;
  if (first.endsWith('@lid') && second.endsWith('@s.whatsapp.net')) return { lid: first, pn: second };
  if (second.endsWith('@lid') && first.endsWith('@s.whatsapp.net')) return { lid: second, pn: first };
  return undefined;
}

/**
 * Learn a LID/phone pair. Returns the chat merge it caused, if any: the mapping may arrive long after
 * both chats already exist, and the two must converge then rather than staying split for ever.
 */
export function handleLidMappingUpdate(store: WhatsAppStore, mapping: LIDMapping): ChatMerge | null {
  const pair = lidPhonePair(mapping.lid, mapping.pn);
  if (!pair) return null;
  return store.linkIdentityAndMergeChats({ lidJid: pair.lid, phoneJid: pair.pn });
}

/**
 * Upsert a chat while preserving whatever a previous sync set and this event did not mention. Always
 * runs before the message writes (the message row references the chat row).
 */
export function upsertChatMerged(
  store: WhatsAppStore,
  input: {
    jid: string;
    name?: string | null;
    kind?: ChatKind;
    last_msg_at?: number | null;
  },
): void {
  const existing = store.getChat(input.jid);
  store.upsertChat({
    jid: input.jid,
    name: input.name !== undefined ? input.name : (existing?.name ?? null),
    kind: input.kind ?? existing?.kind ?? chatKindFromJid(input.jid),
    last_msg_at: input.last_msg_at !== undefined ? input.last_msg_at : (existing?.last_msg_at ?? null),
  });
}

export function ingestBaileysChat(store: WhatsAppStore, chat: Chat): void {
  // Canonical identity before any chat write — a `chats.upsert` keyed by LID must land on the phone
  // chat, not recreate the row a merge just removed.
  const jid = chat.id ? store.canonicalChatJid(chat.id) : undefined;
  if (!jid) return;

  const ts =
    toNumber(chat.conversationTimestamp) ??
    toNumber(chat.lastMsgTimestamp) ??
    toNumber(chat.lastMessageRecvTimestamp);

  // Stop storing masks: a phone-shaped `chat.name` / `chat.displayName` (the "+31 [dots] 85" privacy
  // mask, or a raw number) is stored as null so the next history sync cannot re-poison the column. A
  // reader falls through to the contact name, push name or number instead.
  const rawName = chat.name ?? chat.displayName ?? null;
  const storedName = isPhoneShapedLabel(rawName) ? null : (rawName ?? undefined);

  upsertChatMerged(store, { jid, name: storedName, kind: chatKindFromJid(jid), last_msg_at: ts ?? undefined });
}

export function ingestBaileysChatUpdate(store: WhatsAppStore, update: ChatUpdate): void {
  const jid = update.id ? store.canonicalChatJid(update.id) : undefined;
  if (!jid) return;

  // Ensure the chat row exists before applying a partial update.
  upsertChatMerged(store, { jid, kind: chatKindFromJid(jid) });

  const patch: Parameters<typeof upsertChatMerged>[1] = { jid };
  if (update.name !== undefined || update.displayName !== undefined) {
    // Same mask-stripping rule as `ingestBaileysChat`: a phone-shaped label is not a name.
    const rawUpdateName = update.name ?? update.displayName ?? null;
    patch.name = isPhoneShapedLabel(rawUpdateName) ? null : rawUpdateName;
  }
  if (update.conversationTimestamp !== undefined || update.lastMsgTimestamp !== undefined) {
    patch.last_msg_at = toNumber(update.conversationTimestamp) ?? toNumber(update.lastMsgTimestamp);
  }
  upsertChatMerged(store, patch);
}

export function ingestBaileysContact(store: WhatsAppStore, contact: ContactPatch): ChatMerge | null {
  if (!contact.id) return null;
  const name = contact.name ?? contact.verifiedName ?? null;
  const pushName = contact.notify ?? null;
  const lidJid = contact.lid ?? (contact.id.endsWith('@lid') ? contact.id : undefined);
  const phoneJid = contact.phoneNumber ?? (contact.id.endsWith('@s.whatsapp.net') ? contact.id : undefined);

  if (lidJid && phoneJid) {
    // A contact carrying both aliases is the same signal as a `lid-mapping.update`.
    return store.linkIdentityAndMergeChats({ lidJid, phoneJid, name, pushName });
  }

  const existing = store.getContact(contact.id);
  store.upsertContact({
    jid: contact.id,
    name,
    push_name: pushName,
    lid_jid: lidJid ?? existing?.lid_jid ?? null,
    phone_jid: phoneJid ?? existing?.phone_jid ?? null,
  });
  return null;
}

/**
 * Record the names WhatsApp hands over with a group's participant list. A group's participants carry
 * a `name` (the address-book entry the owner's contacts hold) and a `notify` (the name someone chose
 * themselves), and neither arrives any other way: history sync omits `pushName`, and a contact is
 * only pushed when it changes. Without this the sender of a synced message is a LID with no name and
 * the bubble reads "Unknown".
 *
 * A participant with no usable name is skipped rather than written, because a row of two nulls only
 * makes the next lookup slower.
 */
export function ingestBaileysGroup(store: WhatsAppStore, group: GroupMetadata): ChatMerge[] {
  const merges: ChatMerge[] = [];
  for (const participant of group.participants ?? []) {
    if (!usableName(participant.name) && !usableName(participant.notify)) continue;
    const merge = ingestBaileysContact(store, participant);
    if (merge) merges.push(merge);
  }
  return merges;
}

/**
 * Record a push name observed on a live message envelope. `upsertContact` COALESCEs, so an existing
 * address-book `name` is never overwritten by a self-chosen push name; `name: null` is deliberate.
 */
function harvestPushName(store: WhatsAppStore, senderJid: string, pushName: string): void {
  const existing = store.getContact(senderJid);
  store.upsertContact({
    jid: senderJid,
    name: null,
    push_name: pushName,
    lid_jid: existing?.lid_jid ?? null,
    phone_jid: existing?.phone_jid ?? null,
  });
}

export function ingestBaileysMessage(
  store: WhatsAppStore,
  msg: WAMessage,
  options: { onChatsMerged?: (merge: ChatMerge) => void; meJid?: string } = {},
): void {
  const id = msg.key?.id;
  const rawChatJid = chatJidFromMessage(msg);
  if (!id || !rawChatJid) return;

  // Identity first: a key carrying both `remoteJid` and `remoteJidAlt` IS the mapping, so learning it
  // here lets this very message canonicalise instead of opening a second chat for a known person.
  const chatIdentity = lidPhonePair(msg.key?.remoteJid, msg.key?.remoteJidAlt);
  if (chatIdentity) {
    const merge = handleLidMappingUpdate(store, chatIdentity);
    if (merge) options.onChatsMerged?.(merge);
  }
  const senderIdentity = lidPhonePair(msg.key?.participant, msg.key?.participantAlt);
  if (senderIdentity) {
    const merge = handleLidMappingUpdate(store, senderIdentity);
    if (merge) options.onChatsMerged?.(merge);
  }

  const chatJid = store.canonicalChatJid(rawChatJid);
  const fromMe = Boolean(msg.key?.fromMe);
  const ts = toNumber(msg.messageTimestamp) ?? Date.now();
  const type = classifyMessageType(msg);
  const text = extractMessageText(msg);
  // A live 1:1 key carries `participant: ""`. `??` treats that as a sender, so the row is stored
  // with no one on it and the bubble reads "Unknown" even when the chat's contact is named.
  const participant = blankableJid(msg.key?.participant) ?? blankableJid(msg.participant);
  const sender = fromMe ? null : (participant ?? chatJid);

  // Harvest the sender's push name from the live envelope: history sync omits `pushName`, so a
  // stranger who messages you stays a number for ever without this.
  const pushName = usableName(msg.pushName);
  if (!fromMe && sender && pushName) harvestPushName(store, sender, pushName);

  if (type === 'reaction') {
    const reaction = extractMessageContent(msg.message)?.reactionMessage;
    const targetId = reaction?.key?.id;
    if (!targetId) return;
    upsertChatMerged(store, { jid: chatJid, kind: chatKindFromJid(chatJid) });
    store.upsertMessageReaction({
      chat_jid: chatJid,
      target_msg_id: targetId,
      actor: reactionActor(msg.key, chatJid),
      emoji: reaction.text ?? '',
      updated_at: toNumber(reaction.senderTimestampMs) ?? ts,
    });
    return;
  }

  if (isPollUpdateType(type)) {
    recordPollUpdate(store, msg, chatJid, ts, options.meJid);
    return;
  }

  // The chat row must exist before the message row (foreign keys are on).
  const existing = store.getChat(chatJid);
  const nextLast = existing?.last_msg_at == null ? ts : Math.max(existing.last_msg_at, ts);
  upsertChatMerged(store, { jid: chatJid, kind: chatKindFromJid(chatJid), last_msg_at: nextLast });

  const quote = quoteSnapshot(msg);
  const facts = type === POLL_TYPE ? pollFacts(msg.message) : undefined;
  store.upsertMessage({
    id,
    chat_jid: chatJid,
    from_me: fromMe,
    sender,
    ts,
    type,
    text: facts ? pollSearchText(facts) : text,
    quote_target_id: quote?.targetId ?? null,
    quote_sender: quote?.sender ?? null,
    quote_type: quote?.type ?? null,
    quote_text: quote?.text ?? null,
    // The full WAMessage envelope — required for `getMessage(key)`, media downloads and edits.
    raw: JSON.stringify(msg, BufferJSON.replacer),
  });
  if (facts) settlePendingPollVotes(store, id, facts);
}

function reactionActor(key: WAMessageKey | null | undefined, chatJid: string): string {
  return key?.participant ?? key?.participantAlt ?? (key?.fromMe ? 'me' : chatJid);
}

function recordPollUpdate(store: WhatsAppStore, msg: WAMessage, chatJid: string, ts: number, meJid: string | undefined): void {
  const update = extractMessageContent(msg.message)?.pollUpdateMessage;
  const pollId = update?.pollCreationMessageKey?.id;
  if (!pollId) return;
  upsertChatMerged(store, { jid: chatJid, kind: chatKindFromJid(chatJid) });
  const voterJid = pollPartyJid(msg.key, meJid);
  const creatorJid = pollPartyJid(update.pollCreationMessageKey, meJid);
  const actor = msg.key?.fromMe ? 'me' : store.canonicalChatJid(reactionActor(msg.key, chatJid));
  const updatedAt = toNumber(update.senderTimestampMs) ?? ts;
  const payload = pollBytes(update.vote?.encPayload);
  const iv = pollBytes(update.vote?.encIv);
  if (!payload || !iv || !voterJid || !creatorJid) {
    if (!payload && !iv) store.upsertPollVote({ chat_jid: chatJid, poll_msg_id: pollId, actor, options: [], updated_at: updatedAt });
    return;
  }
  const creation = store.getMessage(pollId);
  const facts = creation ? pollFactsFromStored(creation.raw) : undefined;
  const names = facts
    ? decryptPollSelection({
      encPayload: payload,
      encIv: iv,
      facts,
      pollMsgId: pollId,
      pollCreatorJid: creatorJid,
      voterJid,
    })
    : undefined;
  if (!creation) {
    store.upsertPollVote({
      chat_jid: chatJid,
      poll_msg_id: pollId,
      actor,
      pending: {
        encPayload: Buffer.from(payload).toString('base64'),
        encIv: Buffer.from(iv).toString('base64'),
        voterJid,
        pollCreatorJid: creatorJid,
      },
      updated_at: updatedAt,
    });
    return;
  }
  if (!names) return;
  store.upsertPollVote({ chat_jid: chatJid, poll_msg_id: pollId, actor, options: names, updated_at: updatedAt });
}

/** Votes stored as their own rows before they were folded. Opening a chat applies them once per read. */
export function replayStoredPollUpdates(store: WhatsAppStore, chatJid: string, meJid?: string): void {
  for (const row of store.listMessagesByType(chatJid, 'pollUpdate')) {
    if (!row.raw) continue;
    try {
      recordPollUpdate(store, JSON.parse(row.raw, BufferJSON.reviver) as WAMessage, chatJid, row.ts, meJid);
    } catch {
      // One bad envelope does not hide the poll or the votes that did open.
    }
  }
}

function pollFactsFromStored(raw: string | null): ReturnType<typeof pollFacts> {
  if (!raw) return undefined;
  try {
    return pollFacts((JSON.parse(raw, BufferJSON.reviver) as WAMessage).message);
  } catch {
    return undefined;
  }
}

function settlePendingPollVotes(store: WhatsAppStore, pollId: string, facts: NonNullable<ReturnType<typeof pollFacts>>): void {
  for (const row of store.listPendingPollVotes(pollId)) {
    if (!row.pending) continue;
    const names = decryptPollSelection({
      encPayload: new Uint8Array(Buffer.from(row.pending.encPayload, 'base64')),
      encIv: new Uint8Array(Buffer.from(row.pending.encIv, 'base64')),
      facts,
      pollMsgId: pollId,
      pollCreatorJid: row.pending.pollCreatorJid,
      voterJid: row.pending.voterJid,
    });
    store.upsertPollVote({
      chat_jid: row.chat_jid,
      poll_msg_id: pollId,
      actor: row.actor,
      options: names ?? [],
      updated_at: row.updated_at,
    });
  }
}

function applyReaction(store: WhatsAppStore, targetKey: WAMessageKey, reaction: proto.IReaction): string | undefined {
  const rawChatJid = targetKey.remoteJid ?? targetKey.remoteJidAlt ?? undefined;
  const targetId = targetKey.id ?? undefined;
  if (!rawChatJid || !targetId) return undefined;
  const chatJid = store.canonicalChatJid(rawChatJid);
  upsertChatMerged(store, { jid: chatJid, kind: chatKindFromJid(chatJid) });
  store.upsertMessageReaction({
    chat_jid: chatJid,
    target_msg_id: targetId,
    actor: reactionActor(reaction.key, chatJid),
    emoji: reaction.text ?? '',
    updated_at: toNumber(reaction.senderTimestampMs) ?? Date.now(),
  });
  return targetId;
}

/**
 * WhatsApp's secret-encrypted edit: the key derives from the *original* message's `messageSecret`,
 * which is only reachable through the stored envelope — which is why the envelope is not optional.
 * An edit that cannot be decrypted keeps the previous content rather than blanking the row.
 */
function applySecretMessageEdit(
  store: WhatsAppStore,
  key: WAMessageKey,
  update: WAMessageUpdate['update'],
): string | undefined {
  const encrypted = update.message?.editedMessage?.message?.secretEncryptedMessage;
  if (!encrypted || encrypted.secretEncType !== proto.Message.SecretEncryptedMessage.SecretEncType.MESSAGE_EDIT) return;
  const targetKey = encrypted.targetMessageKey;
  const id = targetKey?.id;
  if (!id || (key.id && key.id !== id)) return;
  const original = store.getMessage(id);
  if (!original?.raw) return;
  const messageSecret = messageSecretFromRaw(original.raw);
  if (!messageSecret) return;
  let rawOriginal: WAMessage;
  try {
    rawOriginal = JSON.parse(original.raw, BufferJSON.reviver) as WAMessage;
  } catch {
    return;
  }
  const originalKey = rawOriginal.key;
  if (!originalKey) return;
  const originalSenderJid = originalKey.participant ?? (original.from_me ? undefined : originalKey.remoteJid);
  const editingSenderJid = key.participant ?? (key.fromMe ? originalSenderJid : key.remoteJid);
  if (!originalSenderJid || !editingSenderJid) return;
  let editedContent: proto.IMessage;
  try {
    editedContent = decryptMessageEdit({
      payload: encrypted.encPayload ?? new Uint8Array(),
      iv: encrypted.encIv ?? new Uint8Array(),
      messageSecret,
      originalMessageId: id,
      originalSenderJid: jidNormalizedUser(originalSenderJid),
      editingSenderJid: jidNormalizedUser(editingSenderJid),
    });
  } catch {
    // Keep the previous content; the edit is not worth losing the message over.
    return;
  }
  const editedMessage = { ...rawOriginal, message: editedContent };
  const editedAt = toNumber(update.messageTimestamp) ?? Math.floor(Date.now() / 1000);
  const changed = store.updateEditedMessage({
    id,
    chat_jid: original.chat_jid,
    type: classifyMessageType(editedMessage),
    text: extractMessageText(editedMessage),
    raw: JSON.stringify(editedMessage, BufferJSON.replacer),
    edited_at: editedAt,
  });
  return changed ? id : undefined;
}

export function handleMessagesUpdate(store: WhatsAppStore, updates: MessagesUpdatePayload): string[] {
  const targetIds = new Set<string>();
  store.transaction(() => {
    for (const { key, update } of updates) {
      const editedId = applySecretMessageEdit(store, key, update);
      if (editedId) targetIds.add(editedId);
      for (const reaction of update.reactions ?? []) {
        const id = applyReaction(store, key, reaction);
        if (id) targetIds.add(id);
      }
    }
  });
  return [...targetIds];
}

export function handleMessagesReaction(store: WhatsAppStore, updates: MessagesReactionPayload): string[] {
  const targetIds = new Set<string>();
  store.transaction(() => {
    for (const { key, reaction } of updates) {
      const id = applyReaction(store, key, reaction);
      if (id) targetIds.add(id);
    }
  });
  return [...targetIds];
}

/**
 * Chat merges are collected inside the transaction and returned to the caller, never announced from
 * within it: until the transaction commits, `merge.from` still exists.
 */
export function handleHistorySet(
  store: WhatsAppStore,
  payload: HistorySetPayload,
  options: { onChatsMerged?: (merge: ChatMerge) => void; meJid?: string } = {},
): SyncProgress {
  const merges: ChatMerge[] = [];
  const collect = (merge: ChatMerge | null) => {
    if (merge) merges.push(merge);
  };
  store.transaction(() => {
    for (const chat of payload.chats) ingestBaileysChat(store, chat);
    for (const contact of payload.contacts) collect(ingestBaileysContact(store, contact));
    for (const message of payload.messages) ingestBaileysMessage(store, message, { onChatsMerged: collect, meJid: options.meJid });
    // History that was synced is not news. A chat the owner has never read here gets its read
    // cursor on the newest stored row, so a first pairing — which syncs everything — does not open
    // with every conversation marked unread. A cursor that already exists is left alone: a history
    // batch may append rows newer than it, and those really are unread.
    const touched: string[] = [];
    for (const chat of payload.chats) {
      if (chat.id) touched.push(store.canonicalChatJid(chat.id));
    }
    for (const message of payload.messages) {
      const jid = chatJidFromMessage(message);
      if (jid) touched.push(store.canonicalChatJid(jid));
    }
    store.markChatsRead(touched);
  });
  for (const merge of merges) options.onChatsMerged?.(merge);

  return {
    progress: payload.progress ?? null,
    isLatest: Boolean(payload.isLatest),
    chats: payload.chats.length,
    messages: payload.messages.length,
  };
}

export function handleMessagesUpsert(
  store: WhatsAppStore,
  payload: MessagesUpsertPayload,
  options: { meJid?: string } = {},
): ChatMerge[] {
  const merges: ChatMerge[] = [];
  store.transaction(() => {
    for (const message of payload.messages) {
      ingestBaileysMessage(store, message, { onChatsMerged: (merge) => merges.push(merge), meJid: options.meJid });
    }
  });
  return merges;
}

export function handleChatsUpsert(store: WhatsAppStore, chats: Chat[]): void {
  store.transaction(() => {
    for (const chat of chats) ingestBaileysChat(store, chat);
  });
}

export function handleChatsUpdate(store: WhatsAppStore, updates: ChatUpdate[]): void {
  store.transaction(() => {
    for (const update of updates) ingestBaileysChatUpdate(store, update);
  });
}

export function handleContactsUpsert(store: WhatsAppStore, contacts: Contact[]): ChatMerge[] {
  return ingestContacts(store, contacts);
}

export function handleContactsUpdate(store: WhatsAppStore, contacts: ContactPatch[]): ChatMerge[] {
  return ingestContacts(store, contacts);
}

function ingestContacts(store: WhatsAppStore, contacts: ContactPatch[]): ChatMerge[] {
  const merges: ChatMerge[] = [];
  store.transaction(() => {
    for (const contact of contacts) {
      const merge = ingestBaileysContact(store, contact);
      if (merge) merges.push(merge);
    }
  });
  return merges;
}

/**
 * Bind Baileys socket events → the store. Every handler is wrapped in {@link contain}: Baileys
 * re-emits a consolidated event map inside one loop, so a handler that throws aborts that loop and
 * every *later* key in the same flush is dropped with no trace. The map is ordered — history set,
 * chats, then messages — so one constraint error on an early key would silently swallow the messages
 * behind it. Nothing below may throw into Baileys.
 */
export function attachIngest(
  ev: IngestListener,
  store: WhatsAppStore,
  options: AttachIngestOptions = {},
): () => void {
  /**
   * Run `fn`, absorbing any throw. Loud on purpose: this failure mode is invisible by construction,
   * so the log is the only thing that makes a dropped event findable after the fact.
   */
  const contain = <A extends unknown[]>(event: string, fn: (...args: A) => void) => {
    return (...args: A): void => {
      try {
        fn(...args);
      } catch (error) {
        console.error(`[ingest] ${event} handler failed; event dropped`, error);
        try {
          options.onHandlerError?.({ event, error });
        } catch (hookError) {
          console.error('[ingest] onHandlerError itself threw', hookError);
        }
      }
    };
  };

  /**
   * Same containment one level down: these handlers fan a committed batch out over consumer
   * callbacks in a loop, and a throw on the first message would drop the notifications behind it.
   */
  const notify = (event: string, fn: () => void) => contain(event, fn)();

  const publishMerges = (merges: ChatMerge[]) => {
    for (const merge of merges) notify('onChatsMerged', () => options.onChatsMerged?.(merge));
  };
  const publishUpdated = (ids: string[]) => {
    for (const id of ids) {
      const stored = store.getMessage(id);
      if (stored) notify('onMessageUpdated', () => options.onMessageUpdated?.(stored));
    }
  };
  const onHistory = (payload: HistorySetPayload) => {
    const progress = handleHistorySet(store, payload, {
      meJid: options.meJid?.(),
      onChatsMerged: (merge) => publishMerges([merge]),
    });
    options.onSyncProgress?.(progress);
  };
  const onMessages = (payload: MessagesUpsertPayload) => {
    const existingIds = new Set(
      payload.messages
        .map((message) => message.key?.id)
        .filter((id): id is string => Boolean(id && store.getMessage(id))),
    );
    const reactionTargetIds = new Set(
      payload.messages
        .map((message) => extractMessageContent(message.message)?.reactionMessage?.key?.id)
        .filter((id): id is string => Boolean(id)),
    );
    const pollIds = payload.messages
      .map(message => extractMessageContent(message.message)?.pollUpdateMessage?.pollCreationMessageKey?.id)
      .filter((id): id is string => Boolean(id));
    publishMerges(handleMessagesUpsert(store, payload, { meJid: options.meJid?.() }));
    // The transaction above has committed. Consumers may classify against the complete stored state.
    for (const incoming of payload.messages) {
      const id = incoming.key?.id;
      if (!id || existingIds.has(id) || classifyMessageType(incoming) === 'reaction') continue;
      const stored = store.getMessage(id);
      if (stored) notify('messages.upsert → onMessageIngested', () => options.onMessageIngested?.(stored));
    }
    publishUpdated([...reactionTargetIds, ...pollIds]);
  };
  const onMessageUpdates = (updates: MessagesUpdatePayload) => publishUpdated(handleMessagesUpdate(store, updates));
  const onMessageReactions = (updates: MessagesReactionPayload) =>
    publishUpdated(handleMessagesReaction(store, updates));
  const onChats = (chats: Chat[]) => handleChatsUpsert(store, chats);
  const onChatUpdates = (updates: ChatUpdate[]) => handleChatsUpdate(store, updates);
  const onContacts = (contacts: Contact[]) => publishMerges(handleContactsUpsert(store, contacts));
  const onContactUpdates = (contacts: ContactPatch[]) => publishMerges(handleContactsUpdate(store, contacts));
  // `groups.update` is also how `groupFetchAllParticipating()` answers, so binding it is what lets
  // the connection backfill every group's names once per open.
  const onGroups = (groups: GroupMetadata[]) => {
    for (const group of groups) publishMerges(ingestBaileysGroup(store, group));
  };
  const onLidMapping = (mapping: LIDMapping) => {
    const merge = handleLidMappingUpdate(store, mapping);
    if (merge) publishMerges([merge]);
  };

  // Bound as [event, contained handler] pairs so nothing is bound to Baileys unwrapped and detaching
  // removes the identical function object.
  const bindings: Array<[string, (...args: any[]) => void]> = (
    [
      ['messaging-history.set', onHistory],
      ['messages.upsert', onMessages],
      ['messages.update', onMessageUpdates],
      ['messages.reaction', onMessageReactions],
      ['chats.upsert', onChats],
      ['chats.update', onChatUpdates],
      ['contacts.upsert', onContacts],
      ['contacts.update', onContactUpdates],
      ['groups.upsert', onGroups],
      ['groups.update', onGroups],
      ['lid-mapping.update', onLidMapping],
    ] as Array<[string, (...args: any[]) => void]>
  ).map(([event, handler]) => [event, contain(event, handler)]);

  for (const [event, handler] of bindings) ev.on(event, handler);

  return () => {
    // Baileys' EventEmitter has `.off`; a test fake may not — best effort.
    const off = (ev as { off?: (event: string, handler: (...args: any[]) => void) => void }).off;
    for (const [event, handler] of bindings) off?.(event, handler);
  };
}
