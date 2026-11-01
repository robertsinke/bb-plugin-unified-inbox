/**
 * The owner's composer endpoint, as WhatsAgent exposes it over loopback.
 *
 * `POST /api/chats/:jid/messages` dispatches WhatsAgent's `send` action with
 * `caller: 'frontend'` — the owner's own composer — which enqueues the text to
 * the one paced outbox. That is the path a group chat needs: the agent's
 * `propose-send` tool refuses `chat.kind !== '1:1'` by design (WhatsAgent R8
 * keeps the *drafting agent* out of groups, while AE4 keeps groups writable by
 * the owner). The inbox types for the owner, so it belongs on this path.
 */

/** Path segment safety: the JID carries `@` and `-`, and the route decodes it back. */
const CHAT_PATH = '/api/chats/';

export interface ComposerSendRequest {
  url: string;
  origin: string;
  body: { text: string };
}

/** The request the owner's composer makes. Nothing here decides whether the text is sent. */
export function composerSendRequest(port: number, chatJid: string, text: string): ComposerSendRequest {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid WhatsAgent connection');
  const jid = chatJid.trim();
  if (!jid) throw new Error('Invalid WhatsApp chat');
  const draft = text.trim();
  if (!draft) throw new Error('Expected text to send');
  const origin = `http://127.0.0.1:${port}`;
  return { url: `${origin}${CHAT_PATH}${encodeURIComponent(jid)}/messages`, origin, body: { text: draft } };
}
