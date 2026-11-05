// WhatsApp's secret-encrypted message edits (lifted from WhatsAgent's channels/whatsapp/message-edit.ts).
//
// The edit key is derived from the original message's `messageSecret`, not from the edit event, which
// is why the raw envelope has to be readable after the fact. Deep import survives because Baileys
// declares no `exports` map.
import { hkdfSync } from 'node:crypto';
import { BufferJSON, extractMessageContent, proto } from 'baileys';
import { aesDecryptGCM } from 'baileys/lib/Utils/crypto.js';

export function decryptMessageEdit(input: {
  payload: Uint8Array;
  iv: Uint8Array;
  messageSecret: Uint8Array;
  originalMessageId: string;
  originalSenderJid: string;
  editingSenderJid: string;
}): proto.IMessage {
  const info = Buffer.concat([
    Buffer.from(input.originalMessageId),
    Buffer.from(input.originalSenderJid),
    Buffer.from(input.editingSenderJid),
    Buffer.from('Message Edit'),
  ]);
  const key = Buffer.from(hkdfSync('sha256', input.messageSecret, Buffer.alloc(0), info, 32));
  const plaintext = aesDecryptGCM(input.payload, key, input.iv, new Uint8Array());
  const decoded = proto.Message.decode(plaintext);
  if (!extractMessageContent(decoded)) throw new Error('WhatsApp edit payload contained no message content.');
  return decoded;
}

/** The edit key, or undefined when the stored envelope has no usable message secret. */
export function messageSecretFromRaw(raw: string | null): Uint8Array | undefined {
  if (!raw) return undefined;
  try {
    const message = JSON.parse(raw, BufferJSON.reviver) as {
      messageContextInfo?: { messageSecret?: Uint8Array };
      message?: { messageContextInfo?: { messageSecret?: Uint8Array } };
    };
    const secret = message.message?.messageContextInfo?.messageSecret ?? message.messageContextInfo?.messageSecret;
    return secret instanceof Uint8Array && secret.byteLength === 32 ? secret : undefined;
  } catch {
    return undefined;
  }
}
