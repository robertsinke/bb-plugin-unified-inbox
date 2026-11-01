// The inbox as a headless session. This is the transcription of the `Inbox`
// component's state machine (app.tsx) without React, the DOM or a browser
// storage object: the panel renders `snapshot()` and calls the intents, and
// every timed policy lives here in one place.
//
// Time is owned by `tick(now)`, never by `setTimeout`/`setInterval`. A session
// is driven by exactly one heartbeat: `tick` is idempotent per instant, so two
// calls with the same `now` do nothing, and subscribers only observe state —
// they never tick. Two independent sessions each ticking their own clock are
// two inboxes, which is correct; the latch lives on the session.
import { inboxDraftKey, readInboxDraft, writeInboxDraft, type InboxDraftStorage } from './inbox-drafts.ts';
import { messagesAfterSend } from './sent-message.ts';
import { canMarkRead, canSend, followsList, type CapabilityMap } from './ui-capabilities.ts';
import type { Account, Conversation, GmailAccount, Message } from './adapters/types.ts';

/** One row of the list, as `cached` and `list_source` return it. */
export type InboxItem = Conversation;

/** The list is shown whole, unread only, or narrowed to one source. */
export type InboxFilter = 'all' | 'unread' | Account;

/** A Gmail draft. Kept in memory only: mail drafts are deliberately not persisted. */
export interface MailDraft {
  account: GmailAccount;
  to: string;
  cc: string;
  subject: string;
  text: string;
  threadId?: string;
  inReplyTo?: string;
  references?: string;
}

export type MailMode = 'new' | 'reply' | 'replyAll' | 'forward';

export interface InboxSnapshot {
  items: InboxItem[];
  errors: string[];
  capabilities: CapabilityMap | null;
  selected: InboxItem | null;
  messages: Message[];
  status: string;
  text: string;
  busy: boolean;
  opening: boolean;
  filter: InboxFilter;
  query: string;
  hits: { account: Account; id: string }[] | null;
  refreshedAt: Partial<Record<Account, number>>;
  refreshingInbox: boolean;
  mail: MailDraft | null;
  mailStatus: string;
}

export interface InboxSessionDeps {
  rpc: { call(name: string, input: unknown): Promise<any> };
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  now?: () => number;
}

export interface InboxSession {
  snapshot(): InboxSnapshot;
  subscribe(fn: () => void): () => void;
  /** The one heartbeat: every due policy runs here. Same `now` twice is a no-op. */
  tick(now: number): void;
  /** Persist drafts still inside their debounce window; call on shutdown. */
  flush(): void;
  open(item: InboxItem): Promise<void>;
  back(): void;
  refresh(sources?: Account[]): Promise<void>;
  setFilter(f: InboxFilter): void;
  setQuery(q: string): void;
  setDraft(t: string): void;
  mark(item: InboxItem, action: 'read' | 'unread' | 'archive'): Promise<void>;
  answer(item: InboxItem, action: 'confirm' | 'reject'): Promise<void>;
  submit(): Promise<void>;
  startMail(mode: MailMode, account: GmailAccount): void;
  setMail(patch: Partial<MailDraft>): void;
  discardMail(): void;
  sendMail(): Promise<void>;
  /** Put a line in the notice area the panel shows under the thread. */
  notify(text: string): void;
}

/** The sources the initial load and the heartbeat refresh; LinkedIn is manual only. */
const DEFAULT_SOURCES: Account[] = ['whatsapp', 'personal', 'business', 'imessage'];

/** How often each source's list is re-read by `tick`. */
const LIST_INTERVAL: Partial<Record<Account, number>> = {
  whatsapp: 8_000,
  imessage: 8_000,
  personal: 45_000,
  business: 45_000,
};

/**
 * How often the open thread is re-read. The component had two copies of this
 * loop (WhatsApp 5s, Messages 8s); one watch in `tick` now serves both.
 */
const WATCH_INTERVAL: Partial<Record<Account, number>> = { whatsapp: 5_000, imessage: 8_000 };

/** Search waits for the typing to pause; the draft waits for the writer to. */
const SEARCH_DEBOUNCE_MS = 150;
const DRAFT_DEBOUNCE_MS = 600;

/** Failure text names the source the way the person knows it. */
const SOURCE_LABEL: Record<Account, string> = {
  personal: 'Personal Gmail',
  business: 'Inhouse Gmail',
  whatsapp: 'WhatsApp',
  imessage: 'Messages',
  linkedin: 'LinkedIn',
};

/** Messages' own failure line: it is the one source whose fix is outside the plugin. */
const MESSAGES_REFRESH_FAILURE = 'Messages could not refresh. Check that imsg is installed and BB has Full Disk Access. Previously loaded messages may be stale.';

export function createInboxSession(deps: InboxSessionDeps): InboxSession {
  const clock = deps.now ?? (() => Date.now());
  const storage: InboxDraftStorage | undefined = deps.storage;

  const state: InboxSnapshot = {
    items: [],
    errors: [],
    capabilities: null,
    selected: null,
    messages: [],
    status: '',
    text: '',
    busy: false,
    opening: false,
    filter: 'all',
    query: '',
    hits: null,
    refreshedAt: {},
    refreshingInbox: false,
    mail: null,
    mailStatus: '',
  };

  const listeners = new Set<() => void>();
  function notify(): void {
    for (const listener of listeners) listener();
  }

  // Every late response is compared against this counter. `back`, a new `open`
  // and a list-driven re-read all bump it, so a stale thread can never land.
  let request = 0;
  // Sources whose refresh is in flight: a second tick must not start them twice.
  const refreshing = new Set<Account>();

  // Drafts live in three places: the last value typed (memory), the value not
  // yet written (pending, with its due time) and the storage object. `open`
  // reads them in that order.
  const drafts = new Map<string, string>();
  const pendingDrafts = new Map<string, string>();
  const draftDue = new Map<string, number>();

  const createdAt = clock();
  const listDue = new Map<Account, number>();
  for (const account of DEFAULT_SOURCES) {
    const interval = LIST_INTERVAL[account];
    if (interval !== undefined) listDue.set(account, createdAt + interval);
  }
  let watchDue: number | null = null;
  let watchRunning = false;
  let searchDue: number | null = null;
  let searchRequest = 0;
  let lastTick: number | null = null;

  function readComposerDraft(account: Account, id: string): string {
    const key = inboxDraftKey({ account, id });
    if (pendingDrafts.has(key)) return pendingDrafts.get(key) || '';
    return readInboxDraft(storage, key) ?? drafts.get(key) ?? '';
  }

  function persistDraft(key: string): void {
    draftDue.delete(key);
    const value = pendingDrafts.get(key);
    if (value !== undefined && writeInboxDraft(storage, key, value)) pendingDrafts.delete(key);
  }

  function clearComposerDraft(account: Account, id: string): void {
    const key = inboxDraftKey({ account, id });
    draftDue.delete(key);
    drafts.delete(key);
    pendingDrafts.set(key, '');
    if (writeInboxDraft(storage, key, '')) pendingDrafts.delete(key);
  }

  /**
   * The component's `items` effect: when a refresh changes the row behind the
   * open thread, the row on screen follows it. A source that declares it does
   * not follow the list keeps the thread it already showed.
   */
  function reconcileSelected(): void {
    const selected = state.selected;
    if (!selected) return;
    const current = state.items.find(item => item.account === selected.account && item.id === selected.id);
    if (!current || (current.date === selected.date && current.preview === selected.preview)) return;
    const seq = ++request;
    state.selected = current;
    if (!followsList(state.capabilities, current.account)) return;
    void deps.rpc.call('open', { account: current.account, id: current.id })
      .then((result: { messages: Message[] }) => {
        if (seq !== request) return;
        state.messages = result.messages;
        notify();
      })
      .catch(() => { /* the messages already on screen stay */ });
  }

  function setItems(next: InboxItem[]): void {
    state.items = next;
    reconcileSelected();
  }

  /** Replace one source's rows; the list stays newest first. */
  function mergeSource(account: Account, listed: InboxItem[]): void {
    setItems([...state.items.filter(item => item.account !== account), ...listed].sort((a, b) => b.date - a.date));
  }

  // Capabilities are asked once. A failure leaves the declaration null, which
  // `ui-capabilities` reads as "offer nothing" rather than guessing.
  void deps.rpc.call('capabilities', null)
    .then((declared: CapabilityMap) => { state.capabilities = declared; notify(); })
    .catch(() => { /* the sources stay offerless */ });

  // The initial load: what the cache already holds, then everything refreshed.
  void (async () => {
    try {
      const cached = await deps.rpc.call('cached', null);
      setItems(cached.items);
      notify();
    } catch { /* the next sync still fills the list */ }
    void refresh();
  })();

  async function refresh(sources: Account[] = DEFAULT_SOURCES): Promise<void> {
    const pending = sources.filter(account => !refreshing.has(account));
    if (!pending.length) return;
    for (const account of pending) refreshing.add(account);
    state.refreshingInbox = true;
    notify();
    try {
      await Promise.all(pending.map(async account => {
        try {
          const listed = account === 'linkedin'
            ? await deps.rpc.call('linkedin_sync', null)
            : await deps.rpc.call('list_source', { account });
          mergeSource(account, listed.items);
          state.refreshedAt = { ...state.refreshedAt, [account]: clock() };
          state.errors = state.errors.filter(error => !error.startsWith(SOURCE_LABEL[account]));
          notify();
        } catch (error) {
          const detail = account === 'linkedin' && error instanceof Error ? ` ${error.message}` : '';
          const message = account === 'imessage'
            ? MESSAGES_REFRESH_FAILURE
            : `${SOURCE_LABEL[account]} could not refresh.${detail} Previously loaded messages may be stale.`;
          if (!state.errors.some(error => error.startsWith(SOURCE_LABEL[account]))) {
            state.errors = [...state.errors, message];
          }
          notify();
        }
      }));
    } finally {
      for (const account of pending) refreshing.delete(account);
      state.refreshingInbox = refreshing.size > 0;
      notify();
    }
  }

  async function open(item: InboxItem): Promise<void> {
    const seq = ++request;
    state.selected = item;
    state.status = '';
    state.text = readComposerDraft(item.account, item.id);
    state.opening = true;
    watchDue = null;
    notify();
    reconcileSelected();
    try {
      // Show the cached thread first so a slow source never leaves a blank panel.
      const remembered = await deps.rpc.call('cached_open', { account: item.account, id: item.id });
      if (seq === request) {
        if (remembered.messages.length) {
          state.messages = remembered.messages;
          state.opening = false;
        } else {
          state.messages = [];
        }
        notify();
      }
      const result = await deps.rpc.call('open', { account: item.account, id: item.id });
      if (seq !== request) return;
      state.messages = result.messages;
      state.opening = false;
      notify();
      // Opening a conversation is what marks it read. The row clears only once
      // the source accepted it, and only if no other open has taken over.
      if (canMarkRead(state.capabilities, item.account) && item.unread) {
        try {
          await deps.rpc.call('action', { account: item.account, id: item.id, action: 'read' });
          if (seq !== request) return;
          state.items = state.items.map(row => row.account === item.account && row.id === item.id
            ? { ...row, unread: false }
            : row);
          state.selected = state.selected && state.selected.account === item.account && state.selected.id === item.id
            ? { ...state.selected, unread: false }
            : state.selected;
          notify();
        } catch { /* the conversation stays unread if the source rejects the update */ }
      }
    } catch (error) {
      if (seq === request) {
        state.status = error instanceof Error ? error.message : 'Could not load this conversation.';
        notify();
      }
    } finally {
      if (seq === request) {
        state.opening = false;
        notify();
      }
    }
  }

  function back(): void {
    ++request;
    state.selected = null;
    state.status = '';
    state.opening = false;
    watchDue = null;
    notify();
  }

  async function mark(item: InboxItem, action: 'read' | 'unread' | 'archive'): Promise<void> {
    if (state.busy) return;
    const unread = action === 'unread';
    // A failed update puts the row back exactly as it stood, including a row
    // archive removed from the list and the thread it had open.
    const previousItems = state.items;
    const previousSelected = state.selected;
    state.items = action === 'archive'
      ? state.items.filter(row => !(row.account === item.account && row.id === item.id))
      : state.items.map(row => row.account === item.account && row.id === item.id ? { ...row, unread } : row);
    state.selected = state.selected && state.selected.account === item.account && state.selected.id === item.id
      ? action === 'archive' ? null : { ...state.selected, unread }
      : state.selected;
    notify();
    try {
      await deps.rpc.call('action', { account: item.account, id: item.id, action });
    } catch (error) {
      state.items = previousItems;
      state.selected = previousSelected;
      state.status = error instanceof Error ? error.message : 'Could not update this conversation.';
      notify();
    }
  }

  async function answer(item: InboxItem, action: 'confirm' | 'reject'): Promise<void> {
    if (state.busy || !state.selected) return;
    state.busy = true;
    state.status = '';
    notify();
    try {
      const result = await deps.rpc.call('action', { account: item.account, id: item.id, action });
      state.status = result.status;
      notify();
      try {
        const listed = await deps.rpc.call('list_source', { account: item.account });
        mergeSource(item.account, listed.items);
        notify();
      } catch { /* the status already says what happened */ }
    } catch (error) {
      state.status = error instanceof Error ? error.message : 'The invitation was not answered.';
      notify();
    } finally {
      state.busy = false;
      notify();
    }
  }

  async function submit(): Promise<void> {
    const selected = state.selected;
    if (!selected || state.busy) return;
    const draft = state.text.trim();
    // Without a send capability the box only keeps a draft: nothing reaches the source.
    if (!canSend(state.capabilities, selected.account) || !draft) return;
    const account = selected.account;
    const id = selected.id;
    state.busy = true;
    state.status = '';
    notify();
    try {
      const result = await deps.rpc.call('action', { account, id, action: 'reply', text: draft });
      clearComposerDraft(account, id);
      state.text = '';
      const sentAt = clock();
      state.messages = messagesAfterSend(state.messages, draft, sentAt);
      state.status = result.status;
      notify();
      // Reconcile: the source's thread if it stored the message, otherwise the
      // optimistic bubble already on screen stays.
      try {
        const opened = await deps.rpc.call('open', { account, id });
        state.messages = messagesAfterSend(opened.messages, draft, sentAt);
        notify();
      } catch { /* the bubble already on screen stays */ }
      try {
        const listed = await deps.rpc.call('list_source', { account });
        mergeSource(account, listed.items);
        notify();
      } catch { /* the open chat does not depend on the list */ }
    } catch (error) {
      state.text = draft;
      state.status = error instanceof Error ? error.message : 'The message was not sent.';
      notify();
    } finally {
      state.busy = false;
      notify();
    }
  }

  function startMail(mode: MailMode, account: GmailAccount): void {
    const last = state.messages.at(-1);
    const subject = last?.subject || state.selected?.title || '';
    const replyTo = last?.suggestedTo || '';
    const cc = mode === 'replyAll' ? last?.suggestedCc || '' : '';
    state.mail = {
      account,
      to: mode === 'reply' || mode === 'replyAll' ? replyTo : '',
      cc,
      subject: mode === 'new' ? '' : mode === 'forward' ? `Fwd: ${subject.replace(/^fwd:\s*/i, '')}` : `Re: ${subject.replace(/^re:\s*/i, '')}`,
      text: mode === 'forward' ? `\n\n---------- Forwarded message ----------\nFrom: ${last?.sender || ''}\n\n${last?.text || ''}` : '',
      ...(mode === 'reply' || mode === 'replyAll'
        ? { threadId: state.selected?.id, inReplyTo: last?.messageId, references: [last?.references, last?.messageId].filter(Boolean).join(' ') }
        : {}),
    };
    state.mailStatus = '';
    notify();
  }

  function setMail(patch: Partial<MailDraft>): void {
    if (!state.mail) return;
    state.mail = { ...state.mail, ...patch };
    notify();
  }

  function discardMail(): void {
    state.mail = null;
    notify();
  }

  async function sendMail(): Promise<void> {
    const mail = state.mail;
    if (!mail || state.busy || !mail.to.trim() || !mail.text.trim()) return;
    state.busy = true;
    state.mailStatus = 'Sending…';
    notify();
    try {
      const result = await deps.rpc.call('send_gmail', mail);
      state.mailStatus = result.status;
      state.mail = null;
      state.status = result.status;
      notify();
    } catch (error) {
      state.mailStatus = error instanceof Error ? error.message : 'Send outcome unknown. Check Gmail Sent before retrying.';
      notify();
    } finally {
      state.busy = false;
      notify();
    }
  }

  function tick(now: number): void {
    // One heartbeat per instant. A second reader ticking the same session must
    // not run a second round of due calls.
    if (lastTick === now) return;
    lastTick = now;

    for (const [key, due] of draftDue) {
      if (now >= due) persistDraft(key);
    }

    // List refresh: each scheduled source has its own due time, and a source
    // already in flight is skipped by `refresh` itself.
    const dueSources = DEFAULT_SOURCES.filter(account => {
      const due = listDue.get(account);
      return due !== undefined && now >= due;
    });
    if (dueSources.length) {
      for (const account of dueSources) {
        const interval = LIST_INTERVAL[account];
        if (interval !== undefined) listDue.set(account, now + interval);
      }
      void refresh(dueSources);
    }

    // Thread watch: one loop for every source that has one, keyed by its own
    // interval. The due time is armed on the first tick after a selection, so
    // the first read lands one interval later, as the component's interval did.
    const interval = state.selected ? WATCH_INTERVAL[state.selected.account] ?? null : null;
    if (interval === null) {
      watchDue = null;
    } else if (watchDue === null) {
      watchDue = now + interval;
    } else if (now >= watchDue) {
      watchDue = now + interval;
      const selected = state.selected;
      if (selected && !watchRunning) {
        watchRunning = true;
        const seq = request;
        void deps.rpc.call('open', { account: selected.account, id: selected.id })
          .then((result: { messages: Message[] }) => {
            if (seq !== request) return;
            state.messages = result.messages;
            notify();
          })
          .catch(() => { /* a missed watch tick is retried next interval */ })
          .finally(() => { watchRunning = false; });
      }
    }

    // Search: run the query once the typing has paused.
    if (searchDue !== null && now >= searchDue) {
      searchDue = null;
      const query = state.query.trim();
      if (!query) {
        state.hits = null;
        notify();
      } else {
        const seq = ++searchRequest;
        void deps.rpc.call('search', { query })
          .then((result: { ids: { account: Account; id: string }[] }) => {
            if (seq !== searchRequest) return;
            state.hits = result.ids;
            notify();
          })
          .catch(() => {
            if (seq !== searchRequest) return;
            state.hits = [];
            notify();
          });
      }
    }
  }

  function flush(): void {
    for (const key of [...pendingDrafts.keys()]) persistDraft(key);
  }

  return {
    snapshot() {
      return {
        ...state,
        items: [...state.items],
        errors: [...state.errors],
        messages: [...state.messages],
        hits: state.hits ? [...state.hits] : null,
        refreshedAt: { ...state.refreshedAt },
        mail: state.mail ? { ...state.mail } : null,
      };
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
    tick,
    flush,
    open,
    back,
    refresh,
    setFilter(f) {
      if (state.filter === f) return;
      state.filter = f;
      notify();
    },
    setQuery(query) {
      state.query = query;
      const trimmed = query.trim();
      if (!trimmed) {
        searchDue = null;
        searchRequest++;
        state.hits = null;
        notify();
        return;
      }
      searchDue = clock() + SEARCH_DEBOUNCE_MS;
      notify();
    },
    setDraft(text) {
      const selected = state.selected;
      if (!selected) return;
      state.text = text;
      const key = inboxDraftKey(selected);
      if (text) drafts.set(key, text);
      else drafts.delete(key);
      pendingDrafts.set(key, text);
      draftDue.set(key, clock() + DRAFT_DEBOUNCE_MS);
      notify();
    },
    mark,
    answer,
    submit,
    startMail,
    setMail,
    discardMail,
    sendMail,
    notify(text) {
      state.status = text;
      notify();
    },
  };
}
