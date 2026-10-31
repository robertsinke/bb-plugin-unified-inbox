import { sourceAvatarUrl } from './avatar-url.ts';
import { linkedinCdnUrl } from './linkedin-media.ts';
import type { MessageMedia } from './adapters/types.ts';

export type LinkedInRow = { id: string; title: string; preview: string; date: number; unread: boolean; sender?: string; avatarUrl?: string };

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
export type LinkedInMessage = { id?: string; sender: string; text: string; date: number; fromMe: boolean; media?: LinkedInPhoto; link?: string };
export type LinkedInPayload = { conversations?: unknown; invitations?: unknown };

const PREVIEW_LIMIT = 300;

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
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
  return { id, title, preview: usable, date: Number.isFinite(date) && date > 0 ? date : 0, unread: raw.unread === true, ...(sender ? { sender } : {}), ...(avatarUrl ? { avatarUrl } : {}) };
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
    if (!body && !media && !link) return [];
    const date = Number(raw.date);
    return [{
      ...(id ? { id } : {}),
      sender: text(raw.sender) || 'LinkedIn',
      text: body,
      date: Number.isFinite(date) && date > 0 ? date : 0,
      fromMe: raw.fromMe === true,
      ...(media ? { media } : {}),
      ...(link ? { link } : {}),
    }];
  }).sort((a, b) => a.date - b.date);
}

/** Received invitations awaiting a response; they carry their own urn instead of a conversation urn. */
export function isInvitationId(id: string): boolean {
  return /^urn:li:fs_relInvitation:.+/.test(id) && id.length <= 512;
}

/** Rejects anything that is not a LinkedIn conversation URN before it reaches the page. */
export function isConversationId(id: string): boolean {
  return /^urn:li:msg_conversation:.+/.test(id) && id.length <= 512;
}
