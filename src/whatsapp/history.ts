// Older history on demand (plan D5, unit U2 — lifted from WhatsAgent's `channels/whatsapp/history.ts`).
//
// Baileys' `fetchMessageHistory` asks the phone for messages older than a key it has never seen. The
// request needs that key, and the key comes from a stored envelope — so this is one more reader of
// `wa_messages.raw`. The answers arrive later as `messaging-history.set` and are ingested normally,
// which is why this module requests and never writes.
import { BufferJSON, type WAMessage, type WAMessageKey } from 'baileys';
import type { WhatsAppStore } from './store.ts';

export type FetchMessageHistoryFn = (
  count: number,
  oldestMsgKey: WAMessageKey,
  oldestMsgTimestamp: number,
) => Promise<string>;

export type DeepenHistoryResult =
  | { requested: true; sessionId: string; oldestMsgId: string }
  | { requested: false; reason: 'no-messages' | 'missing-raw-key' };

/** Ask the phone for older messages in one chat. Returns what was asked, never the messages. */
export async function deepenChatHistory(
  store: WhatsAppStore,
  fetchMessageHistory: FetchMessageHistoryFn,
  chatJid: string,
  count = 50,
): Promise<DeepenHistoryResult> {
  const messages = store.listMessages(chatJid);
  if (messages.length === 0) return { requested: false, reason: 'no-messages' };

  const oldest = messages[0]!;
  let key: WAMessageKey | undefined;
  let timestamp = oldest.ts;

  if (oldest.raw) {
    try {
      const envelope = JSON.parse(oldest.raw, BufferJSON.reviver) as WAMessage;
      key = envelope.key;
      const ts = envelope.messageTimestamp;
      if (typeof ts === 'number') timestamp = ts;
      else if (ts && typeof (ts as { toNumber?: () => number }).toNumber === 'function') {
        timestamp = (ts as { toNumber: () => number }).toNumber();
      }
    } catch {
      key = undefined;
    }
  }

  // A row whose envelope is gone still names its own identity, and that is enough to ask.
  if (!key?.id || !key.remoteJid) {
    key = { id: oldest.id, remoteJid: chatJid, fromMe: oldest.from_me };
  }
  if (!key.id || !key.remoteJid) return { requested: false, reason: 'missing-raw-key' };

  const sessionId = await fetchMessageHistory(count, key, timestamp);
  return { requested: true, sessionId, oldestMsgId: key.id };
}
