export type InboxDraftScope = { account: string; id: string };
export type InboxDraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

const STORAGE_PREFIX = 'unified-inbox.reply-draft.v1';
const MAIL_PREFIX = 'unified-inbox.mail-draft.v1';
const legacyDraftAccounts: Record<string, string> = { personal: 'gmail-personal', business: 'gmail-business' };

type ParsedDraftKey =
  | { kind: 'reply'; account: string; id: string }
  | { kind: 'mail'; account: string; mailKind: 'thread' | 'new'; id: string };

function parseDraftKey(key: string): ParsedDraftKey | null {
  if (key.startsWith(`${STORAGE_PREFIX}:`)) {
    const rest = key.slice(STORAGE_PREFIX.length + 1);
    const split = rest.indexOf(':');
    if (split < 1 || split >= rest.length - 1) return null;
    return { kind: 'reply', account: decodeURIComponent(rest.slice(0, split)), id: decodeURIComponent(rest.slice(split + 1)) };
  }
  if (key.startsWith(`${MAIL_PREFIX}:`)) {
    const rest = key.slice(MAIL_PREFIX.length + 1);
    const match = /^([^:]+):(thread|new):([\s\S]+)$/.exec(rest);
    if (!match || !match[3]) return null;
    return { kind: 'mail', account: decodeURIComponent(match[1]), mailKind: match[2] === 'new' ? 'new' : 'thread', id: decodeURIComponent(match[3]) };
  }
  return null;
}

function renamedAccount(account: string, map: Record<string, string>): string {
  let next = account;
  const seen = new Set<string>();
  while (map[next] && !seen.has(next)) {
    seen.add(next);
    next = map[next];
  }
  return next;
}

/**
 * Drafts saved under an older account id. Keys are rebuilt with the same helpers
 * that write them, so the account stays encoded. The old key is removed only
 * after the new key holds the draft. A destination that already exists stays.
 */
export function migrateDraftAccountIds(
  storage: (InboxDraftStorage & Partial<Pick<Storage, 'key' | 'length'>>) | undefined,
  extra: Record<string, string> = {},
) {
  if (!storage || typeof storage.key !== 'function' || typeof storage.length !== 'number') return;
  const map = { ...legacyDraftAccounts, ...extra };
  let keys: string[] = [];
  try {
    for (let index = 0; index < storage.length; index++) {
      const key = storage.key(index);
      if (key) keys.push(key);
    }
  } catch { return; }
  for (const key of keys) {
    try {
      const parsed = parseDraftKey(key);
      if (!parsed) continue;
      const account = renamedAccount(parsed.account, map);
      if (account === parsed.account) continue;
      const next = parsed.kind === 'reply'
        ? inboxDraftKey({ account, id: parsed.id })
        : parsed.mailKind === 'new'
          ? mailDraftKey({ account, newMessageKey: parsed.id })
          : mailDraftKey({ account, threadId: parsed.id });
      if (next === key) continue;
      const raw = storage.getItem(key);
      if (raw !== null && storage.getItem(next) === null) {
        const value = parsed.kind === 'mail' ? renamedMailDraft(raw, account) : raw;
        storage.setItem(next, value);
        if (storage.getItem(next) !== value) continue;
      }
      storage.removeItem(key);
    } catch { /* a failed copy leaves this draft on its old key */ }
  }
}

function renamedMailDraft(raw: string, account: string) {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return JSON.stringify({ ...parsed, account });
  } catch { /* keep the stored text */ }
  return raw;
}

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
