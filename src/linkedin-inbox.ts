import { isConversationUrn } from './linkedin-conversation.ts';
import { sourceAvatarUrl } from './avatar-url.ts';
import { linkedinCdnUrl } from './linkedin-media.ts';
import type { MessageMedia } from './adapters/types.ts';

export type LinkedInRow = { id: string; title: string; preview: string; date: number; unread: boolean; sender?: string; avatarUrl?: string; sentSnippet?: string };

/**
 * A message photo: the marker the inbox renders, plus the CDN URL `media` fetches
 * with. The URL is a read-side detail — the message RPC drops it — so it never
 * leaves this machine.
 */
export type LinkedInPhoto = MessageMedia & { url: string };

/**
 * A LinkedIn message. A photo has no text and carries `media`; a shared post has
 * no text and no thumbnail, so it carries the link to the post instead.
 */
/** The card a shared post draws. The CDN URL stays beside it, not on this object. */
export type LinkedInShare = { title: string; author?: string; hasImage: boolean };

export type LinkedInMessage = {
  id?: string;
  messageId?: string;
  sender: string;
  /** The profile urn a reply names as the original sender. The message RPC drops it. */
  senderUrn?: string;
  text: string;
  date: number;
  fromMe: boolean;
  media?: LinkedInPhoto;
  link?: string;
  share?: LinkedInShare;
  /** Read-side only. The message RPC drops it. `media` fetches with it. */
  imageUrl?: string;
  /** When a post read failed. A later open skips that activity until this is old. */
  shareMissAt?: number;
};
export type LinkedInPayload = { conversations?: unknown; invitations?: unknown };

const PREVIEW_LIMIT = 300;

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** A card already stored on a cached message. A page payload has none, so this only round-trips the cache. */
function shareOf(value: unknown): LinkedInShare | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as { title?: unknown; author?: unknown; hasImage?: unknown };
  if (typeof raw.title !== 'string' || typeof raw.hasImage !== 'boolean') return undefined;
  const title = raw.title.trim().slice(0, 300);
  const author = typeof raw.author === 'string' ? raw.author.trim().slice(0, 200) : '';
  return { title, ...(author ? { author } : {}), hasImage: raw.hasImage };
}

function row(value: unknown): LinkedInRow | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const id = text(raw.id);
  if (!id) return null;
  const title = text(raw.title) || 'LinkedIn conversation';
  const preview = text(raw.preview);
  // A boolean "has a note" flag once shipped where the note text belongs; never render "true".
  const usable = preview === 'true' || preview === 'false' ? '' : preview.slice(0, PREVIEW_LIMIT);
  const date = Number(raw.date);
  const sender = text(raw.sender);
  const avatarUrl = sourceAvatarUrl(raw.avatarUrl, 'linkedin');
  const mine = raw.fromMe === true && usable.length > 0;
  return { id, title, preview: usable, date: Number.isFinite(date) && date > 0 ? date : 0, unread: raw.unread === true, ...(sender ? { sender } : {}), ...(avatarUrl ? { avatarUrl } : {}), ...(mine ? { sentSnippet: usable } : {}) };
}

/** Inbox rows for LinkedIn conversations and invitations that carry a note, newest first, one row per id. */
export function linkedinItems(payload: LinkedInPayload): LinkedInRow[] {
  const rows = [...(Array.isArray(payload?.conversations) ? payload.conversations : []), ...(Array.isArray(payload?.invitations) ? payload.invitations : [])];
  const seen = new Set<string>();
  const items: LinkedInRow[] = [];
  for (const value of rows) {
    const item = row(value);
    if (!item || seen.has(item.id)) continue;
    // A bare connection request carries no message, so it is not an inbox row.
    if (isInvitationId(item.id) && !item.preview) continue;
    seen.add(item.id);
    items.push(item);
  }
  return items.sort((a, b) => b.date - a.date);
}

/** Conversation messages in reading order. An empty body is dropped unless it carries a photo or a shared post. */
export function linkedinMessages(payload: { messages?: unknown }): LinkedInMessage[] {
  const rows = Array.isArray(payload?.messages) ? payload.messages : [];
  return rows.flatMap(value => {
    if (!value || typeof value !== 'object') return [];
    const raw = value as Record<string, unknown>;
    const body = text(raw.text);
    const id = text(raw.id);
    const photoUrl = linkedinCdnUrl(raw.mediaUrl);
    const activity = text(raw.activityUrn);
    // A shared post points at an activity; its thumbnail is not in the message payload, so the inbox links instead.
    const link = /^urn:li:activity:\d+$/.test(activity) ? `https://www.linkedin.com/feed/update/${activity}/` : '';
    const media: LinkedInPhoto | undefined = id && photoUrl ? { messageId: id, kind: 'image', cached: false, available: true, url: photoUrl } : undefined;
    const share = shareOf(raw.share);
    const imageUrl = linkedinCdnUrl(raw.imageUrl);
    const shareMissAt = Number(raw.shareMissAt);
    const missed = Number.isFinite(shareMissAt) && shareMissAt > 0 ? shareMissAt : 0;
    if (!body && !media && !link && !share && !missed) return [];
    const date = Number(raw.date);
    const senderUrn = text(raw.senderUrn);
    return [{
      // The page expression already parsed this urn. Copy it; do not invent one, and do not read a reaction from a path the payload does not have.
      ...(id ? { id, messageId: id } : {}),
      sender: text(raw.sender) || 'LinkedIn',
      ...( /^urn:li:fsd_(?:profile|company):[^,()\s]+$/.test(senderUrn) ? { senderUrn } : {}),
      text: body,
      date: Number.isFinite(date) && date > 0 ? date : 0,
      fromMe: raw.fromMe === true,
      ...(media ? { media } : {}),
      ...(link ? { link } : {}),
      ...(share ? { share } : {}),
      ...(imageUrl ? { imageUrl } : {}),
      ...(missed ? { shareMissAt: missed } : {}),
    }];
  }).sort((a, b) => a.date - b.date);
}

/** Received invitations awaiting a response; they carry their own urn instead of a conversation urn. */
export function isInvitationId(id: string): boolean {
  return /^urn:li:fs_relInvitation:.+/.test(id) && id.length <= 512;
}

/** Rejects anything that is not a LinkedIn conversation URN before it reaches the page. */
export function isConversationId(id: string): boolean {
  return isConversationUrn(id);
}
