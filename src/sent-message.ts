export type ChatMessage = { sender: string; text: string; date: number; fromMe?: boolean };

/** Keep a just-sent bubble if the reload has not stored it yet. */
export function messagesAfterSend(fetched: readonly ChatMessage[], sent: string, sentAt: number): ChatMessage[] {
  if (fetched.some(message => message.fromMe && message.text === sent)) return [...fetched];
  return [...fetched, { sender: 'You', text: sent, date: sentAt, fromMe: true }];
}
