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
  const snippet = typeof sent.snippet === 'string' ? sent.snippet.trim() : '';
  return snippet || undefined;
}
