export type InboxDraftScope = { account: string; id: string };
export type InboxDraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

const STORAGE_PREFIX = 'unified-inbox.reply-draft.v1';

export function inboxDraftKey({ account, id }: InboxDraftScope): string {
  return `${STORAGE_PREFIX}:${encodeURIComponent(account)}:${encodeURIComponent(id)}`;
}

export function readInboxDraft(storage: InboxDraftStorage | undefined, key: string): string | undefined {
  try {
    return storage?.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}

export function writeInboxDraft(storage: InboxDraftStorage | undefined, key: string, value: string): boolean {
  try {
    if (!storage) return false;
    if (value) storage.setItem(key, value);
    else storage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}
