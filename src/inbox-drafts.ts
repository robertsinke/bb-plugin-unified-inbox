export type InboxDraftScope = { account: string; id: string };
export type InboxDraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

const STORAGE_PREFIX = 'unified-inbox.reply-draft.v1';
const MAIL_PREFIX = 'unified-inbox.mail-draft.v1';

export type InboxMailDraft = {
  account: string;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  text: string;
  threadId?: string;
  inReplyTo?: string;
  references?: string;
};

/** A mail draft belongs to a Gmail thread, or to a compose that has no thread yet. */
export type InboxMailDraftScope =
  | { account: string; threadId: string }
  | { account: string; newMessageKey: string };

function readStored(storage: InboxDraftStorage | undefined, key: string): string | undefined {
  try {
    return storage?.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}

function writeStored(storage: InboxDraftStorage | undefined, key: string, value: string): boolean {
  try {
    if (!storage) return false;
    storage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function removeStored(storage: InboxDraftStorage | undefined, key: string): boolean {
  try {
    if (!storage) return false;
    storage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

export function inboxDraftKey({ account, id }: InboxDraftScope): string {
  return `${STORAGE_PREFIX}:${encodeURIComponent(account)}:${encodeURIComponent(id)}`;
}

export function readInboxDraft(storage: InboxDraftStorage | undefined, key: string): string | undefined {
  return readStored(storage, key);
}

export function writeInboxDraft(storage: InboxDraftStorage | undefined, key: string, value: string): boolean {
  return value ? writeStored(storage, key, value) : removeStored(storage, key);
}

export function mailDraftKey(scope: InboxMailDraftScope): string {
  const owner = `:${encodeURIComponent(scope.account)}:`;
  return 'threadId' in scope
    ? `${MAIL_PREFIX}${owner}thread:${encodeURIComponent(scope.threadId)}`
    : `${MAIL_PREFIX}${owner}new:${encodeURIComponent(scope.newMessageKey)}`;
}

export function readMailDraft(storage: InboxDraftStorage | undefined, key: string): InboxMailDraft | undefined {
  const raw = readStored(storage, key);
  if (!raw) return undefined;
  try {
    return parseMailDraft(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

export function writeMailDraft(
  storage: InboxDraftStorage | undefined,
  key: string,
  draft: InboxMailDraft,
): boolean {
  let raw: string;
  try {
    // File bytes are never written down: a draft on this machine is the words the owner typed.
    // Restoring one brings the words back and leaves the attachments empty, which the composer says.
    raw = JSON.stringify({ ...draft, attachments: [] });
  } catch {
    return false;
  }
  return writeStored(storage, key, raw);
}

export function clearMailDraft(storage: InboxDraftStorage | undefined, key: string): boolean {
  return removeStored(storage, key);
}

function parseMailDraft(value: unknown): InboxMailDraft | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const draft = value as Record<string, unknown>;
  const { account, to, cc, subject, text } = draft;
  if (![account, to, cc, subject, text].every(field => typeof field === 'string')) return undefined;
  // Drafts written before blind copies existed have no such field; they read as empty rather than vanishing.
  const bcc = draft.bcc === undefined ? '' : optionalText(draft.bcc);
  if (bcc === null) return undefined;
  const threadId = optionalText(draft.threadId);
  const inReplyTo = optionalText(draft.inReplyTo);
  const references = optionalText(draft.references);
  if (threadId === null || inReplyTo === null || references === null) return undefined;
  return {
    account: account as string,
    to: to as string,
    cc: cc as string,
    bcc: bcc as string,
    subject: subject as string,
    text: text as string,
    ...(threadId === undefined ? {} : { threadId }),
    ...(inReplyTo === undefined ? {} : { inReplyTo }),
    ...(references === undefined ? {} : { references }),
  };
}

/** `undefined` when absent, `null` when present but not a string. */
function optionalText(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  return typeof value === 'string' ? value : null;
}
