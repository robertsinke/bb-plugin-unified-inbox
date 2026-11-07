type GmailMessageDate = { internalDate?: string | number | null; labelIds?: readonly string[] };

/** Choose the newest received message to represent an Inbox thread. */
export function latestReceivedMessage<T extends GmailMessageDate>(messages: readonly T[]): T | undefined {
  let latest: T | undefined;
  let latestDate = Number.NEGATIVE_INFINITY;
  for (const message of messages) {
    if (message.labelIds?.includes('SENT')) continue;
    const date = Number(message.internalDate);
    const timestamp = Number.isFinite(date) ? date : Number.NEGATIVE_INFINITY;
    if (!latest || timestamp >= latestDate) {
      latest = message;
      latestDate = timestamp;
    }
  }
  return latest ?? messages.at(-1);
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
};

/**
 * Gmail's snippet is HTML-escaped text. The inbox draws it as text, so `&#39;` would show
 * as those six characters. One pass: `&amp;amp;` stays `&amp;`, which is what the message contained.
 */
export function gmailSnippet(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (entity, body: string) => {
    if (body.startsWith('#')) {
      const code = body[1] === 'x' ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      if (!Number.isInteger(code) || code < 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return entity;
      return String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[body] ?? entity;
  });
}

/** The snippet of a sent message that is newer than every received one. The row still shows the received message. */
export function sentReplySnippet<T extends GmailMessageDate & { snippet?: string | null }>(messages: readonly T[]): string | undefined {
  let sent: T | undefined;
  let sentAt = Number.NEGATIVE_INFINITY;
  let receivedAt = Number.NEGATIVE_INFINITY;
  for (const message of messages) {
    const date = Number(message.internalDate);
    const timestamp = Number.isFinite(date) ? date : Number.NEGATIVE_INFINITY;
    if (message.labelIds?.includes('SENT')) {
      if (!sent || timestamp >= sentAt) {
        sent = message;
        sentAt = timestamp;
      }
    } else if (timestamp >= receivedAt) {
      receivedAt = timestamp;
    }
  }
  if (!sent || sentAt < receivedAt) return undefined;
  const snippet = typeof sent.snippet === 'string' ? gmailSnippet(sent.snippet).trim() : '';
  return snippet || undefined;
}
