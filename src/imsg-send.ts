import { imsgChatId } from './imsg-mapping.ts';
import { REACTION_SET, isReactionEmoji } from './reaction-set.ts';

/** One Messages message is text; this bound matches the RPC input schema. */
export const IMSG_TEXT_LIMIT = 20_000;

/** The text a send carries: present, trimmed, and bounded before anything reaches the backend. */
export function imsgText(text: string): string {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) throw new Error('A message needs text.');
  if (trimmed.length > IMSG_TEXT_LIMIT) throw new Error(`A Messages message is limited to ${IMSG_TEXT_LIMIT} characters.`);
  return trimmed;
}

/**
 * `send` reports `{ ok, guid, message_id }`. An unconfirmed outcome must never be retried
 * blindly, because the message may already be on its way.
 */
export function imsgSendStatus(result: unknown): string {
  const value = (result ?? {}) as { ok?: unknown; guid?: unknown; message_id?: unknown };
  if (value.ok === false) throw new Error('Messages did not send. Check the conversation before trying again.');
  return value.guid || value.message_id ? 'Sent.' : 'Messages accepted the message but reported no delivery id.';
}

export interface ImsgSender {
  request(method: string, params?: Record<string, unknown>): Promise<unknown>;
}

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : '';
}

function needsBridge(cause: unknown): boolean {
  return /bridge/i.test(errorText(cause));
}

/** A second tapback can remove the first, so a timeout or an unconfirmed result stays unknown. */
function uncertainTapback(cause: unknown): boolean {
  const message = errorText(cause);
  return /timed out/i.test(message) || message.includes('-32001');
}

/**
 * Send one text into an existing Messages chat. A reply target goes on this same `send`.
 * Throws rather than reporting a false success, and never sends again without the target.
 */
export async function sendImsgText(client: ImsgSender, chatId: string, text: string, replyTo?: string): Promise<string> {
  const chat = imsgChatId(chatId);
  const body = imsgText(text);
  const params: Record<string, unknown> = { chat_id: chat, text: body };
  if (replyTo !== undefined) {
    const target = replyTo.trim();
    if (!target) throw new Error('A reply to one message needs that message. Nothing was sent.');
    params.reply_to = target;
  }
  try {
    return imsgSendStatus(await client.request('send', params));
  } catch (cause) {
    const message = errorText(cause);
    if (replyTo !== undefined && needsBridge(cause)) throw new Error('Messages cannot target that message without its bridge. Nothing was sent.');
    if (message.includes('-32001')) throw new Error('Messages could not confirm the send. Check the conversation before trying again.');
    throw cause instanceof Error ? cause : new Error('Messages did not send.');
  }
}

/**
 * One classic tapback on the message guid. The kind is the shared reaction's label.
 * Emphasis and question are not kinds here: a send of either is refused.
 */
export async function sendImsgTapback(client: ImsgSender, messageId: string, emoji: string, remove = false): Promise<string> {
  if (!isReactionEmoji(emoji)) throw new Error('That emoji is not one of the four reactions. Nothing was sent.');
  const guid = messageId.trim();
  if (!guid) throw new Error('A reaction needs the message it reacts to. Nothing was sent.');
  const kind = REACTION_SET.find(item => item.emoji === emoji)!.label;
  try {
    const result = await client.request('tapback', {
      message_guid: guid,
      kind,
      ...(remove ? { remove: true } : {}),
    });
    const value = (result ?? {}) as { ok?: unknown };
    if (value.ok === false) throw new Error('Messages did not send the reaction. Nothing was sent.');
    return 'Sent.';
  } catch (cause) {
    if (uncertainTapback(cause)) throw new Error('The reaction outcome is unknown. Check Messages before trying again.');
    if (needsBridge(cause)) throw new Error('Messages cannot target that message without its bridge. Nothing was sent.');
    throw cause instanceof Error ? cause : new Error('Messages did not send the reaction.');
  }
}
