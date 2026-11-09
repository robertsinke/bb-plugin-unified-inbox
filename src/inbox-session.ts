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
import { messagesAfterMail, messagesAfterSend } from './sent-message.ts';
import { canMarkRead, canPollVote, canQuoteReply, canReact, canSend, followsList, type CapabilityMap } from './ui-capabilities.ts';
import type { AttentionVerdict } from './attention-label.ts';
import { accounts } from './adapters/types.ts';
import { migrateDraftAccountIds } from './inbox-drafts.ts';
import type { Account, Conversation, GmailAccount, Message, SourceMap } from './adapters/types.ts';
// The seam to the gateway is the contract, not a loose `(name, input)` pair: a renamed
// method or a reshaped input is a compile error here, where the session calls it, and
// again at every fake that claims to be a gateway. Type-only, so a unit test never
// loads the panel runtime.
import type { PluginRpcClient } from '@get-bb/plugin-sdk';
import type { rpcContract } from './rpc-contract.ts';

/** One row of the list, as `cached` and `sync` return it. */
export type InboxItem = Conversation;

/** The list is shown whole, unread only, by attention label, or narrowed to one source. */
export type InboxFilter = 'all' | 'unread' | AttentionVerdict | Account;

/** A Gmail draft. Kept in memory only: mail drafts are deliberately not persisted. */
/** A file the owner attached to a draft. `data` is base64 with no data-url prefix. */
export interface MailAttachment {
  name: string;
  mimeType: string;
  size: number;
  data: string;
}

/** What one draft may carry, and why: Gmail refuses a message over 25 MB once it is encoded. */
const ATTACHMENT_ENCODED_LIMIT_BYTES = 25 * 1024 * 1024;
const ATTACHMENT_LIMIT_COUNT = 20;

/** The room a file takes in the encoded message Gmail measures: base64 spends four bytes on three. */
function encodedBytes(raw: number): number {
  return Math.ceil(raw / 3) * 4;
}

export interface MailDraft {
  account: GmailAccount;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  text: string;
  attachments: MailAttachment[];
  threadId?: string;
  inReplyTo?: string;
  references?: string;
}

export type MailMode = 'new' | 'reply' | 'replyAll' | 'forward';

/**
 * One failure the panel is holding. The account is the identity: it is what clears the line, and
 * what names the source in words. It used to be a prefix of `message`, which meant a label doubled
 * as a join key and editing a label orphaned every line already on screen.
 *
 * A line with an account carries the verb phrase that follows the source's name ("could not
 * refresh. …"), because the panel writes "{source} {message}". A failure no single source owns
 * (`timeout`) is a whole sentence.
 */
export interface InboxError {
  account?: Account;
  /** Which policy produced it: a source's refresh, or a page older than the one on screen. */
  kind: 'refresh' | 'older';
  message: string;
}

export interface InboxSnapshot {
  items: InboxItem[];
  errors: InboxError[];
  capabilities: CapabilityMap | null;
  /** What each source says it is, and how it is paced; null until the gateway has answered. */
  sources: SourceMap | null;
  selected: InboxItem | null;
  messages: Message[];
  status: string;
  text: string;
  /** The message a Reply click aimed the composer at. Empty means today's conversation reply. */
  replyMessageId: string;
  busy: boolean;
  opening: boolean;
  filter: InboxFilter;
  query: string;
  /**
   * The rows the search matched, in rank order, or null when no search is running. Rows rather than
   * ids: a hit can be a conversation this list never loaded, and there is nothing else to draw it
   * from.
   */
  hits: InboxItem[] | null;
  refreshedAt: Partial<Record<Account, number>>;
  refreshingInbox: boolean;
  /** Some source told the panel it still holds rows older than the ones on screen. */
  hasOlder: boolean;
  /** An older page is in flight; the control is disabled until it lands. */
  loadingOlder: boolean;
  mail: MailDraft | null;
  mailStatus: string;
  /** What the send gate decided, newest first — the same rows the CLI prints. */
  audit: SendAuditEntry[];
  /** Whether the panel is showing the decision log instead of the conversation list. */
  auditOpen: boolean;
}

/** One send decision, as the gate recorded it: no message text, ever. `reason` is null
 * in the log when the gate recorded none, which is why it is nullable here too. */
export interface SendAuditEntry {
  at: number;
  account: Account;
  conversationId: string;
  decision: 'allowed' | 'refused';
  reason?: string | null;
}

export interface InboxSessionDeps {
  /** What `useRpc<typeof rpcContract>()` hands the panel: the same contract, both sides. */
  rpc: Pick<PluginRpcClient<typeof rpcContract>, 'call'>;
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  now?: () => number;
}

export interface InboxSession {
  snapshot(): InboxSnapshot;
  /** Run the first load once. Call from an effect; constructing the session calls nothing. */
  start(): void;
  subscribe(fn: () => void): () => void;
  /** The one heartbeat: every due policy runs here. Same `now` twice is a no-op. */
  tick(now: number): void;
  /** Persist drafts still inside their debounce window; call on shutdown. */
  flush(): void;
  open(item: InboxItem): Promise<void>;
  back(): void;
  /** Mark a Needed conversation None, and keep the previous score so it can be put back. */
  clearAttention(item: InboxItem): Promise<void>;
  /** Undo the last clear and restore the score it held. */
  restoreAttention(item: InboxItem): Promise<void>;
  refresh(sources?: Account[]): Promise<void>;
  /** The next older page from every source that still has one. The list calls this as it scrolls. */
  more(): Promise<void>;
  /**
   * Listing rows now on screen, in list order. One Gmail thread is read at a time. A row that
   * leaves the screen is not read. A quota failure leaves the snippet where it is.
   */
  showListed(rows: { account: Account; id: string }[]): void;
  setFilter(f: InboxFilter): void;
  setQuery(q: string): void;
  setDraft(t: string): void;
  /** Aim the open composer at one message. A source that cannot quote ignores it. */
  aimReply(messageId: string): void;
  /** Drop the aimed message. The draft stays. */
  clearReply(): void;
  /** One reaction on one message. `remove` is the caller's decision; this does not send a second time. */
  react(messageId: string, emoji: string, remove?: boolean): Promise<void>;
  /** The owner's next selection on one poll. An empty list clears it. */
  vote(messageId: string, options: string[]): Promise<void>;
  mark(item: InboxItem, action: 'read' | 'unread' | 'archive'): Promise<void>;
  answer(item: InboxItem, action: 'confirm' | 'reject'): Promise<void>;
  showAudit(): Promise<void>;
  hideAudit(): void;
  submit(): Promise<void>;
  startMail(mode: MailMode, account: GmailAccount): void;
  /** Take a file onto the draft, or refuse it and say why in `mailStatus`. */
  attach(file: MailAttachment): boolean;
  detach(index: number): void;
  setMail(patch: Partial<MailDraft>): void;
  discardMail(): void;
  sendMail(): Promise<void>;
  /** Put a line in the notice area the panel shows under the thread. */
  notify(text: string): void;
}

/** Manual refresh includes every source. Automatic provider refresh belongs to the backend. */
const DEFAULT_SOURCES: Account[] = [...accounts];

/** Search waits for the typing to pause; the draft waits for the writer to. */
const SEARCH_DEBOUNCE_MS = 150;
/** The panel's own debounce was 250ms; the session keeps it, now driven by `tick`. */
const DRAFT_DEBOUNCE_MS = 250;

/**
 * How long one round of "show older" may run. A Gmail source reads one thread per row and a
 * WhatsApp page comes from the stored rows in well under a second, so a whole page lands quickly; 15s leaves room for
 * a slow mailbox and still never leaves the control loading with no end. A round that misses it
 * degrades into a line in `errors`.
 */
const OLDER_TIMEOUT_MS = 15_000;

/** Messages' own guidance: it is the one source whose fix is outside the plugin. */
const MESSAGES_REFRESH_HINT = ' Check that imsg is installed and BB has Full Disk Access.';

/** The suffix every refresh failure ends with, so no line claims stale data is fresh. */
const REFRESH_SUFFIX = ' Previously loaded messages may be stale.';

/** A round no source answered in time. No account owns it, so it is a whole sentence. */
const OLDER_TIMEOUT = `Older conversations could not load in time: nothing answered within ${OLDER_TIMEOUT_MS / 1000} seconds, so the wait was given up. The rows already shown are unchanged.`;

/** A row's identity across sources; the same thread can arrive from a refresh and from a page. */
function rowKey(item: { account: Account; id: string }): string {
  return `${item.account}\u0000${item.id}`;
}

export function createInboxSession(deps: InboxSessionDeps): InboxSession {
  const clock = deps.now ?? (() => Date.now());
  const storage: InboxDraftStorage | undefined = deps.storage;

  const state: InboxSnapshot = {
    items: [],
    errors: [],
    capabilities: null,
    sources: null,
    selected: null,
    messages: [],
    status: '',
    text: '',
    replyMessageId: '',
    busy: false,
    opening: false,
    filter: 'all',
    query: '',
    hits: null,
    refreshedAt: {},
    refreshingInbox: false,
    hasOlder: false,
    loadingOlder: false,
    mail: null,
    audit: [],
    auditOpen: false,
    mailStatus: '',
  };

  const listeners = new Set<() => void>();
  /**
   * The snapshot the panel renders. A store read through `useSyncExternalStore` compares
   * snapshot identity between renders, so this must be the same object until something
   * actually changed; publishing a fresh object every call would re-render forever.
   */
  let published: InboxSnapshot | null = null;
  function notify(): void {
    published = null;
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

  /**
   * The rows "show older" loaded, per source — the one record of what the owner asked to see
   * beyond the newest page. A refresh replaces a source's newest page, so `mergeSource` puts
   * these back instead of letting a 45-second poll silently shorten the list. Archiving a row
   * removes it from here, so it does not come back on the next refresh.
   */
  const olderRows = new Map<Account, InboxItem[]>();
  /** A reply just sent. A cache read from before Gmail stored it must not move the row back down. */
  const sentRows = new Map<string, { date: number; preview: string; sentSnippet: string }>();

  /** Per source: whether it told the gateway it still holds rows older than the newest page. */
  const olderLeft = new Map<Account, boolean>();
  /** When the round in flight must have answered by; null when no round is running. */
  let olderDue: number | null = null;
  /** Bumped when a round is given up, so the answers it was still waiting for are dropped. */
  let olderSeq = 0;
  /** Listing rows the panel can see, in list order. One read at a time. */
  let listedWanted: { account: Account; id: string }[] = [];
  let disclosing = false;
  /** A row that failed while it stayed on screen. Scrolling it away allows one more try. */
  const discloseFailed = new Set<string>();

  let cacheDue: number | null = null;
  let cacheReading = false;
  async function readCache(): Promise<void> {
    if (cacheReading) return;
    cacheReading = true;
    try {
      const cached = await deps.rpc.call('cached', null);
      const live = state.sources ? Object.keys(state.sources) : [...accounts];
      for (const account of live) {
        mergeSource(account, cached.items.filter(item => item.account === account));
        const status = cached.freshness?.[account];
        if (status) {
          if (status.lastSuccessAt !== null) state.refreshedAt[account] = status.lastSuccessAt;
          else delete state.refreshedAt[account];
          dropErrors(error => error.account === account && error.kind === 'refresh');
          if (status.lastError) state.errors.push({ account, kind: 'refresh', message: `${status.lastError}${REFRESH_SUFFIX}` });
        }
        if (cached.more) olderLeft.set(account, cached.more[account]);
      }
      state.hasOlder = [...olderLeft.values()].some(Boolean);
      notify();
    } catch { /* a disconnected panel keeps its last snapshot, without advancing freshness */ }
    finally { cacheReading = false; }
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
   * open thread, the row on screen follows it. A label change updates the
   * header chip and does not open the thread again. A source that declares it
   * does not follow the list keeps the thread it already showed.
   */
  function reconcileSelected(): void {
    const selected = state.selected;
    if (!selected) return;
    const current = state.items.find(item => item.account === selected.account && item.id === selected.id);
    if (!current) return;
    const rowChanged = current.date !== selected.date || current.preview !== selected.preview;
    const labelChanged = current.needsAttention !== selected.needsAttention || current.attentionDismissed !== selected.attentionDismissed;
    if (!rowChanged && !labelChanged) return;
    state.selected = current;
    if (!rowChanged || !followsList(state.capabilities, current.account)) return;
    const seq = ++request;
    void deps.rpc.call('open', { account: current.account, id: current.id })
      .then(result => {
        if (seq !== request) return;
        showMessages(result);
        notify();
      })
      .catch(() => { /* the messages already on screen stay */ });
  }

  function showMessages(result: { messages: Message[]; cacheFallback?: boolean }): void {
    state.messages = result.messages;
    const stale = 'Could not verify this conversation. Showing cached messages; they may be stale.';
    if (result.cacheFallback) state.status = stale;
    else if (state.status === stale) state.status = '';
  }

  function setItems(next: InboxItem[]): void {
    state.items = next;
    reconcileSelected();
  }

  /** A reply the cache has not caught up with keeps its place. A row at least as new drops the hold. */
  function applySent(items: InboxItem[]): InboxItem[] {
    if (sentRows.size === 0) return items;
    return items.map(item => {
      const sent = sentRows.get(rowKey(item));
      if (!sent) return item;
      if (item.date >= sent.date) {
        sentRows.delete(rowKey(item));
        return item;
      }
      return { ...item, date: sent.date, preview: sent.preview, sentSnippet: sent.sentSnippet };
    });
  }

  function noteSentReply(account: Account, id: string, preview: string, date: number): void {
    const text = preview.trim();
    if (!text) return;
    sentRows.set(rowKey({ account, id }), { date, preview: text, sentSnippet: text });
    const next = applySent(state.items).sort((a, b) => b.date - a.date);
    state.items = next;
    if (state.selected?.account === account && state.selected.id === id) {
      state.selected = next.find(item => item.account === account && item.id === id)
        ?? { ...state.selected, date, preview: text, sentSnippet: text };
    }
  }

  /** Replace one source's rows; the list stays newest first. */
  function mergeSource(account: Account, listed: InboxItem[]): void {
    // A row that has moved back into the newest page (new mail pushed the page down) is served
    // by `listed`; keeping the older copy too would render the same row twice.
    const listedIds = new Set(listed.map(item => item.id));
    const kept = (olderRows.get(account) ?? []).filter(item => !listedIds.has(item.id));
    olderRows.set(account, kept);
    setItems(applySent([...state.items.filter(item => item.account !== account), ...listed, ...kept]).sort((a, b) => b.date - a.date));
  }

  // Capabilities are asked once. A failure leaves the declaration null, which
  // `ui-capabilities` reads as "offer nothing" rather than guessing.
  /**
   * The first load: the declarations, what the cache already holds, then every source
   * refreshed. Idempotent, and never run from the constructor — the panel builds the
   * session while rendering, and an RPC must not start there.
   *
   * The two declarations are asked before the rows, so the first row the panel paints already
   * carries the name its source gave it rather than a placeholder.
   */
  let started = false;
  function start(): void {
    if (started) return;
    started = true;
    void deps.rpc.call('capabilities', null)
      .then((declared: CapabilityMap) => { state.capabilities = declared; notify(); })
      .catch(() => { /* the sources stay offerless */ });
    void (async () => {
      try {
        state.sources = await deps.rpc.call('sources', null);
        notify();
      } catch { /* a source with no declaration is named by its account key and polled not at all */ }
      try {
        const status = await deps.rpc.call('mailbox_status', null);
        migrateDraftAccountIds(storage, status?.legacy ?? {});
      } catch { /* drafts stay on the key they were saved under */ }
      await readCache();
      void loadAudit();
    })();
  }

  /** The last few send decisions, so a refusal is visible where it happened. */
  async function loadAudit(limit = 5): Promise<void> {
    try {
      const { rows } = await deps.rpc.call('send_audit', { limit });
      state.audit = rows;
      notify();
    } catch { /* the CLI still has the full log */ }
  }

  /** The log is a view behind the inbox menu, not chrome above the list. */
  async function showAudit(): Promise<void> {
    if (!state.auditOpen) {
      state.auditOpen = true;
      notify();
    }
    await loadAudit(20);
  }

  function hideAudit(): void {
    if (!state.auditOpen) return;
    state.auditOpen = false;
    notify();
  }

  /** Forget every failure the predicate names; the one way a line leaves the list. */
  function dropErrors(matches: (error: InboxError) => boolean): void {
    const kept = state.errors.filter(error => !matches(error));
    if (kept.length !== state.errors.length) state.errors = kept;
  }

  async function refresh(sources?: Account[]): Promise<void> {
    const named = sources ?? (state.sources ? Object.keys(state.sources) : DEFAULT_SOURCES);
    const pending = named.filter(account => !refreshing.has(account));
    if (!pending.length) return;
    for (const account of pending) refreshing.add(account);
    state.refreshingInbox = true;
    notify();
    try {
      await Promise.all(pending.map(async account => {
        try {
          const listed = await deps.rpc.call('sync', { account });
          mergeSource(account, listed.items);
          state.refreshedAt = { ...state.refreshedAt, [account]: listed.updatedAt };
          // Clearing is a lookup on the account, not a match on the text: a failure line and the
          // source that owns it are the same pair whoever phrased it.
          dropErrors(error => error.account === account && error.kind === 'refresh');
          olderLeft.set(account, listed.more === true);
          state.hasOlder = [...olderLeft.values()].some(Boolean);
          notify();
        } catch (error) {
          const detail = account === 'imessage' ? MESSAGES_REFRESH_HINT : error instanceof Error ? ` ${error.message}` : '';
          const message = `could not refresh.${detail}${REFRESH_SUFFIX}`;
          if (!state.errors.some(line => line.account === account && line.kind === 'refresh')) {
            state.errors = [...state.errors, { account, kind: 'refresh', message }];
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

  /**
   * A listing row has no date yet. Sit it just under the oldest row this account already shows,
   * so the page keeps Gmail's order until the real date arrives.
   */
  function placeListed(account: Account, items: InboxItem[]): InboxItem[] {
    const known = state.items.filter(item => item.account === account && item.date > 0).map(item => item.date);
    let floor = known.length ? Math.min(...known) : clock();
    return items.map(item => {
      if (!item.listedOnly || item.date > 0) return item;
      floor -= 1;
      return { ...item, date: floor };
    });
  }

  function showListed(rows: { account: Account; id: string }[]): void {
    const visible = new Set(rows.map(rowKey));
    for (const key of discloseFailed) if (!visible.has(key)) discloseFailed.delete(key);
    listedWanted = rows;
    void discloseNext();
  }

  async function discloseNext(): Promise<void> {
    if (disclosing) return;
    const next = listedWanted.find(row => {
      const item = state.items.find(current => current.account === row.account && current.id === row.id);
      return item?.listedOnly === true && !discloseFailed.has(rowKey(row));
    });
    if (!next) return;
    disclosing = true;
    const key = rowKey(next);
    try {
      const filled = await deps.rpc.call('disclose', { account: next.account, id: next.id });
      const current = state.items.find(item => rowKey(item) === key);
      if (current?.listedOnly) {
        const { listedOnly: _listed, ...rest } = filled;
        const row: InboxItem = { ...rest, date: rest.date > 0 ? rest.date : current.date };
        const kept = olderRows.get(next.account);
        if (kept) olderRows.set(next.account, kept.map(item => item.id === next.id ? row : item));
        setItems(state.items.map(item => rowKey(item) === key ? row : item).sort((a, b) => b.date - a.date));
        notify();
      }
    } catch {
      discloseFailed.add(key);
    } finally {
      disclosing = false;
      void discloseNext();
    }
  }

  /**
   * The next older page: one source at a time and merged as each answers. One round at a time, no
   * side effect from rendering, a source failure in `errors` with the shown rows untouched — and a
   * round that misses OLDER_TIMEOUT_MS is given up rather than left waiting forever.
   */
  async function more(): Promise<void> {
    if (state.loadingOlder) return;
    const sources = [...olderLeft].filter(([, left]) => left).map(([account]) => account);
    if (!sources.length) return;
    const seq = ++olderSeq;
    let failed = false;
    state.loadingOlder = true;
    olderDue = clock() + OLDER_TIMEOUT_MS;
    notify();
    try {
      await Promise.all(sources.map(async account => {
        try {
          let page = await deps.rpc.call('list', { older: true, account });
          // A round the ceiling gave up on has already told the owner; its late rows are dropped
          // rather than appearing under a message that says they did not.
          if (seq !== olderSeq) return;
          // The first primary page can be the rows already shown. One more ask reaches the page
          // behind them. A second page of the same rows is the line below.
          const shown = new Set(state.items.map(rowKey));
          if (!page.errors.length && page.more === true && page.items.every(item => shown.has(rowKey(item)))) {
            page = await deps.rpc.call('list', { older: true, account });
            if (seq !== olderSeq) return;
          }
          // An empty item list with `more` still set is a read that failed, not a page of rows the
          // list already has. Saying "already on screen" there sends the owner after a page that
          // never arrived.
          if (page.errors.length) {
            failed = true;
            const detail = page.errors.join(' ');
            dropErrors(line => line.kind === 'older');
            state.errors = [...state.errors, { account, kind: 'older', message: `could not load older conversations. ${detail} The rows already shown are unchanged.` }];
            olderLeft.set(account, page.more === true);
            state.hasOlder = [...olderLeft.values()].some(Boolean);
            notify();
            return;
          }
          const seen = new Set(state.items.map(rowKey));
          const fresh = placeListed(account, page.items.filter((item: InboxItem) => !seen.has(rowKey(item))));
          const rows = olderRows.get(account) ?? [];
          const added = fresh.filter(item => !rows.some(row => row.id === item.id));
          if (added.length) olderRows.set(account, [...rows, ...added]);
          // The source promised more and answered with rows already on screen: a press that adds
          // nothing must say so, or the owner is left clicking a control that is indistinguishable
          // from a broken one.
          if (!fresh.length && page.more === true) {
            failed = true;
            // One older line at a time: the control the owner is looking at is the one that failed.
            dropErrors(line => line.kind === 'older');
            state.errors = [...state.errors, { account, kind: 'older', message: 'could not load older conversations: it answered with rows already on screen, so there was nothing new to add.' }];
          }
          setItems([...state.items, ...fresh].sort((a, b) => b.date - a.date));
          olderLeft.set(account, page.more === true);
          state.hasOlder = [...olderLeft.values()].some(Boolean);
          notify();
        } catch (error) {
          if (seq !== olderSeq) return;
          failed = true;
          const detail = error instanceof Error ? ` ${error.message}` : '';
          dropErrors(line => line.kind === 'older');
          state.errors = [...state.errors, { account, kind: 'older', message: `could not load older conversations.${detail} The rows already shown are unchanged.` }];
          notify();
        }
      }));
    } finally {
      if (seq === olderSeq) {
        if (!failed) dropErrors(line => line.kind === 'older');
        state.loadingOlder = false;
        olderDue = null;
        notify();
      }
    }
  }

  async function open(item: InboxItem): Promise<void> {
    const seq = ++request;
    state.selected = item;
    state.status = '';
    state.replyMessageId = '';
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
      showMessages(result);
      state.opening = false;
      notify();
      // Opening a conversation is what marks it read. The row clears when that
      // read is accepted, including a Gmail read held until the minute allows it.
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
    state.replyMessageId = '';
    state.opening = false;
    watchDue = null;
    notify();
  }

  function paintAttention(rows: InboxItem[], account: Account, id: string, patch: Pick<InboxItem, 'needsAttention' | 'attentionDismissed'>): InboxItem[] {
    return rows.map(row => row.account === account && row.id === id ? { ...row, ...patch } : row);
  }

  async function clearAttention(item: InboxItem): Promise<void> {
    if (item.needsAttention !== 'yes') return;
    const previousItems = state.items;
    const previousHits = state.hits;
    const previousSelected = state.selected;
    const patch = { needsAttention: 'no' as const, attentionDismissed: true };
    state.items = paintAttention(state.items, item.account, item.id, patch);
    if (state.hits) state.hits = paintAttention(state.hits, item.account, item.id, patch);
    if (state.selected?.account === item.account && state.selected.id === item.id) state.selected = { ...state.selected, ...patch };
    notify();
    try {
      await deps.rpc.call('clear_attention', { account: item.account, id: item.id });
    } catch {
      state.items = previousItems;
      state.hits = previousHits;
      state.selected = previousSelected;
      notify();
    }
  }

  async function restoreAttention(item: InboxItem): Promise<void> {
    if (item.attentionDismissed !== true) return;
    const previousItems = state.items;
    const previousHits = state.hits;
    const previousSelected = state.selected;
    const patch = { needsAttention: 'yes' as const, attentionDismissed: false };
    state.items = paintAttention(state.items, item.account, item.id, patch);
    if (state.hits) state.hits = paintAttention(state.hits, item.account, item.id, patch);
    if (state.selected?.account === item.account && state.selected.id === item.id) state.selected = { ...state.selected, ...patch };
    notify();
    try {
      await deps.rpc.call('restore_attention', { account: item.account, id: item.id });
    } catch {
      state.items = previousItems;
      state.hits = previousHits;
      state.selected = previousSelected;
      notify();
    }
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
    // An archived row must not return when a refresh merges the older pages back in.
    if (action === 'archive') olderRows.set(item.account, (olderRows.get(item.account) ?? []).filter(row => row.id !== item.id));
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
        const listed = await deps.rpc.call('sync', { account: item.account });
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

  function aimReply(messageId: string): void {
    const selected = state.selected;
    const id = messageId.trim();
    if (!selected || !id || !canQuoteReply(state.capabilities, selected.account)) return;
    if (state.replyMessageId === id) return;
    state.replyMessageId = id;
    notify();
  }

  function clearReply(): void {
    if (!state.replyMessageId) return;
    state.replyMessageId = '';
    notify();
  }

  async function vote(messageId: string, options: string[]): Promise<void> {
    const selected = state.selected;
    const id = messageId.trim();
    if (!selected || state.busy || !id || !canPollVote(state.capabilities, selected.account)) return;
    state.busy = true;
    state.status = '';
    notify();
    try {
      await deps.rpc.call('action', {
        account: selected.account,
        id: selected.id,
        action: 'vote',
        messageId: id,
        options,
        allow: 'send',
      });
      state.status = '';
      notify();
    } catch (error) {
      state.status = error instanceof Error ? error.message : 'The vote was not sent.';
      notify();
    } finally {
      void loadAudit();
      state.busy = false;
      notify();
    }
  }

  async function react(messageId: string, emoji: string, remove?: boolean): Promise<void> {
    const selected = state.selected;
    const id = messageId.trim();
    if (!selected || state.busy || !id || !canReact(state.capabilities, selected.account)) return;
    state.busy = true;
    state.status = '';
    notify();
    try {
      await deps.rpc.call('action', {
        account: selected.account,
        id: selected.id,
        action: 'react',
        messageId: id,
        emoji,
        allow: 'send',
        ...(remove ? { remove: true } : {}),
      });
      state.status = '';
      notify();
    } catch (error) {
      state.status = error instanceof Error ? error.message : 'The reaction was not sent.';
      notify();
    } finally {
      void loadAudit();
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
    const messageId = canQuoteReply(state.capabilities, account) ? state.replyMessageId : '';
    state.busy = true;
    state.status = '';
    notify();
    try {
      // The owner pressing Send is the statement the transport can carry: the gate refuses and
      // records a reply that arrives without it. A message id is present only while Reply is aimed.
      await deps.rpc.call('action', {
        account,
        id,
        action: 'reply',
        text: draft,
        allow: 'send',
        ...(messageId ? { messageId } : {}),
      });
      clearComposerDraft(account, id);
      state.text = '';
      state.replyMessageId = '';
      const sentAt = clock();
      state.messages = messagesAfterSend(state.messages, draft, sentAt);
      // A send that worked says nothing: the bubble in the thread is the receipt. Only a failure or an
      // unknown outcome has something to add, and it lands in the same notice, from the catch below.
      state.status = '';
      notify();
      // Reconcile: the source's thread if it stored the message, otherwise the
      // optimistic bubble already on screen stays.
      try {
        const opened = await deps.rpc.call('open', { account, id });
        state.messages = messagesAfterSend(opened.messages, draft, sentAt);
        notify();
      } catch { /* the bubble already on screen stays */ }
      try {
        const listed = await deps.rpc.call('sync', { account });
        mergeSource(account, listed.items);
        notify();
      } catch { /* the open chat does not depend on the list */ }
    } catch (error) {
      state.text = draft;
      state.status = error instanceof Error ? error.message : 'The message was not sent.';
      notify();
    } finally {
      void loadAudit();
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
      bcc: '',
      attachments: [],
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

  function attach(file: MailAttachment): boolean {
    const mail = state.mail;
    if (!mail) return false;
    if (mail.attachments.length >= ATTACHMENT_LIMIT_COUNT) {
      state.mailStatus = `A draft carries at most ${ATTACHMENT_LIMIT_COUNT} attachments.`;
      notify();
      return false;
    }
    // The words are encoded into the same message, so a long body leaves less room for files.
    const body = encodedBytes(new TextEncoder().encode(mail.text).length);
    const encoded = body + [...mail.attachments, file].reduce((total, one) => total + encodedBytes(one.size), 0);
    if (encoded > ATTACHMENT_ENCODED_LIMIT_BYTES) {
      state.mailStatus = `That attachment is too large: a draft carries up to ${Math.round(ATTACHMENT_ENCODED_LIMIT_BYTES / (1024 * 1024))} MB once its files are encoded for Gmail.`;
      notify();
      return false;
    }
    state.mail = { ...mail, attachments: [...mail.attachments, file] };
    state.mailStatus = '';
    notify();
    return true;
  }

  function detach(index: number): void {
    const mail = state.mail;
    if (!mail) return;
    state.mail = { ...mail, attachments: mail.attachments.filter((_, at) => at !== index) };
    notify();
  }

  function discardMail(): void {
    state.mail = null;
    notify();
  }

  async function sendMail(): Promise<void> {
    const mail = state.mail;
    if (!mail || state.busy || !mail.to.trim() || (!mail.text.trim() && mail.attachments.length === 0)) return;
    const account = mail.account;
    const threadId = mail.threadId;
    const sent = { text: mail.text, attachmentNames: mail.attachments.map(file => file.name) };
    const before = state.messages;
    const stillHere = () => Boolean(threadId && state.selected?.account === account && state.selected.id === threadId);
    state.busy = true;
    // In flight and after success the composer says nothing; the busiest-looking control on it is
    // already disabled, and the draft leaving the panel is the receipt.
    state.mailStatus = '';
    notify();
    try {
      // The same statement a chat reply carries: the owner pressed send on this draft.
      await deps.rpc.call('send_gmail', { ...mail, allow: 'send' });
      state.mailStatus = '';
      state.mail = null;
      state.status = '';
      const sentAt = clock();
      const preview = sent.text.replace(/\s+/g, ' ').trim().slice(0, 500)
        || sent.attachmentNames.map(name => name.trim()).filter(Boolean).join(', ').slice(0, 500);
      // The thread has no watch. Without this line the reply stays missing until the owner leaves and opens it again.
      if (threadId) noteSentReply(account, threadId, preview, sentAt);
      if (stillHere()) state.messages = messagesAfterMail(before, before, sent, sentAt);
      notify();
      if (stillHere() && threadId) {
        try {
          const opened = await deps.rpc.call('open', { account, id: threadId });
          if (stillHere()) {
            state.messages = messagesAfterMail(before, opened.messages, sent, sentAt);
            notify();
          }
        } catch { /* the line already on screen stays */ }
      }
    } catch (error) {
      state.mailStatus = error instanceof Error ? error.message : 'Send outcome unknown. Check Gmail Sent before retrying.';
      notify();
    } finally {
      void loadAudit();
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

    // This only reads the backend snapshot; panel visibility never drives source sync.
    if (cacheDue === null) cacheDue = now + 5_000;
    else if (now >= cacheDue) {
      cacheDue = now + 5_000;
      void readCache();
    }

    // Thread watch: one loop for every source that has one, keyed by its own
    // interval. The due time is armed on the first tick after a selection, so
    // the first read lands one interval later, as the component's interval did.
    const interval = state.selected ? state.sources?.[state.selected.account]?.watchIntervalMs ?? null : null;
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
          .then(result => {
            if (seq !== request) return;
            showMessages(result);
            notify();
          })
          .catch(() => { /* a missed watch tick is retried next interval */ })
          .finally(() => { watchRunning = false; });
      }
    }

    // An older page that has not answered by its ceiling is given up: a slow source becomes a line
    // the owner can read, never a control that never stops loading.
    if (olderDue !== null && now >= olderDue) {
      olderDue = null;
      olderSeq += 1;
      state.loadingOlder = false;
      // No account owns a round that never answered, so this one line is a sentence of its own.
      dropErrors(line => line.kind === 'older');
      state.errors = [...state.errors, { kind: 'older', message: OLDER_TIMEOUT }];
      notify();
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
          .then((result: { items: InboxItem[] }) => {
            if (seq !== searchRequest) return;
            state.hits = result.items;
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
      if (published) return published;
      published = {
        ...state,
        items: [...state.items],
        errors: [...state.errors],
        messages: [...state.messages],
        hits: state.hits ? [...state.hits] : null,
        refreshedAt: { ...state.refreshedAt },
        mail: state.mail ? { ...state.mail } : null,
      };
      return published;
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
    start,
    tick,
    flush,
    showAudit,
    hideAudit,
    open,
    back,
    clearAttention,
    restoreAttention,
    refresh,
    more,
    showListed,
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
    aimReply,
    clearReply,
    react,
    vote,
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
    attach,
    detach,
    setMail,
    discardMail,
    sendMail,
    notify(text) {
      state.status = text;
      notify();
    },
  };
}
