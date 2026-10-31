import { imsgChatId } from './imsg-mapping.ts';

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

/** Send one text into an existing Messages chat. Throws rather than reporting a false success. */
export async function sendImsgText(client: ImsgSender, chatId: string, text: string): Promise<string> {
  const chat = imsgChatId(chatId);
  const body = imsgText(text);
  try {
    return imsgSendStatus(await client.request('send', { chat_id: chat, text: body }));
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : '';
    if (message.includes('-32001')) throw new Error('Messages could not confirm the send. Check the conversation before trying again.');
    throw cause instanceof Error ? cause : new Error('Messages did not send.');
  }
}
