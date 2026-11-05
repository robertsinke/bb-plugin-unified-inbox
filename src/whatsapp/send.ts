// The socket methods a send needs, and nothing else (lifted from WhatsAgent's channels/whatsapp/send.ts).
//
// One adapter in the plugin is allowed to hold this type: the connection hands it out only while the
// socket is open, so a caller cannot send into a socket that has gone away. It is a type, not a
// policy — every send still passes `src/adapters/policy.ts` before it reaches here.
import type { WAMessage, WAMessageKey } from 'baileys';

export class WhatsAppDisconnectedError extends Error {
  constructor() {
    super('WhatsApp is disconnected');
    this.name = 'WhatsAppDisconnectedError';
  }
}

export type WhatsAppSendSocket = {
  sendPresenceUpdate(type: 'composing' | 'unavailable', jid: string): Promise<unknown>;
  sendMessage(
    jid: string,
    content: { text: string },
    options: { messageId: string; quoted?: WAMessage },
  ): Promise<unknown>;
  sendMessage(jid: string, content: { react: { text: string; key: WAMessageKey } }): Promise<unknown>;
  readMessages(keys: WAMessageKey[]): Promise<unknown>;
};

export type WhatsAppSendTransport = {
  setPresence(jid: string, type: 'composing' | 'unavailable'): Promise<void>;
  sendText(jid: string, text: string, messageId: string, quoted?: WAMessage): Promise<void>;
  /** An empty `emoji` removes a prior reaction. */
  sendReaction(jid: string, targetKey: WAMessageKey, emoji: string): Promise<void>;
  markRead(jid: string, messageId: string): Promise<void>;
};

export function createWhatsAppSendTransport(
  getSocket: () => WhatsAppSendSocket | undefined,
): WhatsAppSendTransport {
  function socket(): WhatsAppSendSocket {
    const current = getSocket();
    if (!current) throw new WhatsAppDisconnectedError();
    return current;
  }

  return {
    async setPresence(jid, type) {
      await socket().sendPresenceUpdate(type, jid);
    },
    async sendText(jid, text, messageId, quoted) {
      await socket().sendMessage(jid, { text }, { messageId, ...(quoted ? { quoted } : {}) });
    },
    async sendReaction(jid, targetKey, emoji) {
      await socket().sendMessage(jid, { react: { text: emoji, key: targetKey } });
    },
    async markRead(jid, messageId) {
      await socket().readMessages([{ remoteJid: jid, id: messageId, fromMe: false }]);
    },
  };
}
