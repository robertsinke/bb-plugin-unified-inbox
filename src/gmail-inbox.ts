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
