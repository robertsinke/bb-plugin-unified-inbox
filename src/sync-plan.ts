export type GmailRevision = { id: string; historyId: string; preview: string };
export const GMAIL_INBOX_SUMMARY_VERSION = 'received-v1';

export function gmailSummaryCursor(historyId: string): string {
  return `${GMAIL_INBOX_SUMMARY_VERSION}:${historyId}`;
}

/** Force one full summary refresh when cached Gmail rows predate the current row semantics. */
export function gmailInboxIdsToFetch(cursor: string | null, known: readonly GmailRevision[], listed: readonly GmailListing[]): string[] {
  if (!cursor?.startsWith(`${GMAIL_INBOX_SUMMARY_VERSION}:`)) return listed.map(row => row.id);
  return gmailIdsToFetch(known, listed);
}
export type GmailListing = { id: string; historyId: string; snippet: string };

/** True when Gmail's mailbox cursor has not moved since the last successful sync. */
export function gmailCursorUnchanged(stored: string | null, historyId: string): boolean {
  return stored !== null && stored === historyId;
}

/** Thread ids whose list row is new or newer than the stored revision. */
export function gmailIdsToFetch(known: readonly GmailRevision[], listed: readonly GmailListing[]): string[] {
  const previous = new Map(known.map(row => [row.id, row]));
  return listed.filter(row => {
    const stored = previous.get(row.id);
    if (!stored) return true;
    if (row.historyId && stored.historyId) return row.historyId !== stored.historyId;
    return row.snippet !== stored.preview;
  }).map(row => row.id);
}

export type ChatStamp = { id: string; date: number; preview: string; unread: boolean };

/** True when a WhatsApp chat list carries the same messages as the one already shown. */
export function whatsappListUnchanged(stored: readonly ChatStamp[], next: readonly ChatStamp[]): boolean {
  if (stored.length !== next.length) return false;
  const previous = new Map(stored.map(chat => [chat.id, chat]));
  return next.every(chat => {
    const old = previous.get(chat.id);
    return !!old && old.date === chat.date && old.preview === chat.preview && old.unread === chat.unread;
  });
}
