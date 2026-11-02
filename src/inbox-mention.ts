/**
 * Inbox mentions: the `#` picker tags one inbox conversation, and the context
 * below is what the agent receives when the message is sent.
 */
export const sourceAccounts = ['personal', 'business', 'whatsapp', 'imessage', 'linkedin'] as const;

export type MentionAccount = (typeof sourceAccounts)[number];

/** Cached rows can outlive the sources a build understands. */
export function isSourceAccount(value: string): value is MentionAccount {
  return (sourceAccounts as readonly string[]).includes(value);
}

export const MENTION_PROVIDER = 'inbox';

export const mentionLabels: Record<MentionAccount, string> = {
  personal: 'Personal Gmail',
  business: 'Inhouse Gmail',
  whatsapp: 'WhatsApp',
  imessage: 'Messages',
  linkedin: 'LinkedIn',
};

const MAX_MESSAGES = 12;
const MAX_MESSAGE_CHARS = 400;
const MAX_CONTEXT_CHARS = 4000;

export function mentionId(account: string, id: string) {
  return `${account}:${id}`;
}

type ComposerScope = { kind: string; threadId?: string };

/** The composer for the thread beside the inbox, or any on-screen thread composer. */
export function threadComposer<T extends { scope: ComposerScope }>(composers: readonly T[], threadId: string | null): T | undefined {
  const beside = threadId
    ? composers.find(composer => composer.scope.kind === 'thread' && composer.scope.threadId === threadId)
    : undefined;
  return beside ?? composers.find(composer => composer.scope.kind === 'thread');
}

export function parseMentionId(value: string): { account: MentionAccount; id: string } {
  const split = value.indexOf(':');
  const account = value.slice(0, split);
  if (split < 1 || value.length === split + 1 || !isSourceAccount(account)) {
    throw new Error('This inbox mention does not name a known conversation.');
  }
  return { account, id: value.slice(split + 1) };
}

export type MentionMessage = {
  sender: string;
  fromMe?: boolean;
  text: string;
  date: number;
  media?: { kind: string };
};

function stamp(date: number) {
  return new Date(date).toISOString().slice(0, 16).replace('T', ' ');
}

function line(message: MentionMessage) {
  const text = message.text.replace(/\s+/g, ' ').trim() || (message.media ? `[${message.media.kind}]` : '');
  return `[${stamp(message.date)}] ${message.sender}: ${text.slice(0, MAX_MESSAGE_CHARS)}`;
}

/** What the agent needs to answer one tagged conversation. */
export function inboxMentionContext(input: {
  account: MentionAccount;
  id: string;
  title?: string;
  preview?: string;
  messages: MentionMessage[];
}) {
  const name = input.title?.trim() || input.preview?.trim() || 'Untitled conversation';
  const head = [`Inbox conversation: ${name} (${mentionLabels[input.account]})`, `Conversation id: ${input.id}`, 'Latest messages, oldest first:'];
  const footer = input.account === 'whatsapp'
    ? [
        'Reply with an explicit send; it goes out as you, without a second confirmation in the page:',
        `printf '%s' '${JSON.stringify({ account: 'whatsapp', id: input.id, action: 'reply', text: '<reply>', allow: 'send' })}' > /tmp/inbox-reply.json && bb plugin rpc call unified-inbox action --input-file /tmp/inbox-reply.json`,
      ]
    : input.account === 'imessage'
      ? [
          'Reply with an explicit send; it goes out as you, without a second confirmation in the page:',
          `printf '%s' '${JSON.stringify({ account: 'imessage', id: input.id, action: 'reply', text: '<reply>', allow: 'send' })}' > /tmp/inbox-reply.json && bb plugin rpc call unified-inbox action --input-file /tmp/inbox-reply.json`,
        ]
    : input.account === 'linkedin'
      ? [
          'A LinkedIn reply replays the send request the page recorded for this conversation. If none is recorded yet, send once from the page so the plugin can replay it, then:',
          `printf '%s' '${JSON.stringify({ account: 'linkedin', id: input.id, action: 'reply', text: '<reply>', allow: 'send' })}' > /tmp/inbox-reply.json && bb plugin rpc call unified-inbox action --input-file /tmp/inbox-reply.json`,
        ]
      : [
          'A Gmail reply is a new message from your address; write it as a draft with an explicit send:',
          `printf '%s' '${JSON.stringify({ account: input.account, to: '<recipient>', subject: '<subject>', text: '<reply>', allow: 'send' })}' > /tmp/inbox-reply.json && bb plugin rpc call unified-inbox send_gmail --input-file /tmp/inbox-reply.json`,
        ];
  const lines: string[] = [];
  let budget = MAX_CONTEXT_CHARS - head.join('\n').length - footer.join('\n').length - 8;
  for (const message of input.messages.slice(-MAX_MESSAGES).reverse()) {
    const next = line(message);
    if (next.length > budget) break;
    budget -= next.length + 1;
    lines.unshift(next);
  }
  return [...head, ...(lines.length ? lines : ['(no messages cached yet)']), '', ...footer].join('\n');
}
