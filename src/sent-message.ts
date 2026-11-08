export type ChatMessage = { sender: string; text: string; date: number; fromMe?: boolean };

/** Keep a just-sent bubble if the reload has not stored it yet. */
export function messagesAfterSend(fetched: readonly ChatMessage[], sent: string, sentAt: number): ChatMessage[] {
  if (fetched.some(message => message.fromMe && message.text === sent)) return [...fetched];
  return [...fetched, { sender: 'You', text: sent, date: sentAt, fromMe: true }];
}

type ShownMail = { sender: string; text: string; date: number; fromMe?: boolean; attachments?: string[]; gmailId?: string };

/** The line the thread shows until Gmail returns the stored copy. */
function sentLabel(sent: { text: string; attachmentNames: readonly string[] }): string {
  const body = sent.text.trim();
  const names = sent.attachmentNames.filter(name => name.trim() !== '');
  return body || (names.length ? `Sent ${names.join(', ')}` : '(sent)');
}

function mailKey(message: ShownMail): string {
  return message.gmailId ? `id:${message.gmailId}` : `${message.date}\0${message.sender}\0${message.text}`;
}

/** A stored row is this send when its text is the draft, or the draft plus the quoted thread. */
function looksLikeSent(message: ShownMail, sent: { text: string; attachmentNames: readonly string[] }): boolean {
  const body = sent.text.replace(/\r\n/g, '\n').trim();
  const text = message.text.replace(/\r\n/g, '\n').trim();
  if (body && (text === body || text.startsWith(`${body}\n`) || text.includes(body))) return true;
  const names = sent.attachmentNames.filter(name => name.trim() !== '');
  return !body && names.length > 0 && names.every(name => message.attachments?.includes(name));
}

/**
 * Keep a just-sent Gmail line if the reload has not stored it yet.
 * `before` is the thread as it was when Send was pressed.
 * shortcut: one new row is this send; two new rows need the text to match, upgrade if a send can land beside another new message and not match it.
 */
export function messagesAfterMail<T extends ShownMail>(
  before: readonly T[],
  fetched: readonly T[],
  sent: { text: string; attachmentNames: readonly string[] },
  sentAt: number,
): T[] {
  const shown = sentLabel(sent);
  const prior = new Set(before.map(mailKey));
  const fresh = fetched.filter(message => !prior.has(mailKey(message)));
  if (fresh.length === 1 || fresh.some(message => looksLikeSent(message, sent))) return [...fetched];
  if (fetched.some(message => message.fromMe === true && message.text === shown && message.date === sentAt)) return [...fetched];
  const names = sent.attachmentNames.filter(name => name.trim() !== '');
  return [...fetched, { sender: 'You', text: shown, date: sentAt, fromMe: true, ...(names.length ? { attachments: [...names] } : {}) } as T];
}
