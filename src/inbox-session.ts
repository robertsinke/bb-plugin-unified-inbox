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
import { accounts } from './adapters/types.ts';
import type { Account, Conversation, GmailAccount, Message, SourceMap } from './adapters/types.ts';
// The seam to the gateway is the contract, not a loose `(name, input)` pair: a renamed
// method or a reshaped input is a compile error here, where the session calls it, and
// again at every fake that claims to be a gateway. Type-only, so a unit test never
// loads the panel runtime.
import type { PluginRpcClient } from '@get-bb/plugin-sdk';
import type { rpcContract, WhatsAppPairingRequest, WhatsAppPairingSnapshot } from './rpc-contract.ts';

/** One row of the list, as `cached` and `sync` return it. */
export type InboxItem = Conversation;

/** The list is shown whole, unread only, or narrowed to one source. */
export type InboxFilter = 'all' | 'unread' | Account;

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
  /**
   * Where the WhatsApp pairing stands, or null until the gateway has answered. It is a state, not a
   * failure: an unpaired source draws a card and puts nothing in `errors`.
   */
  pairing: WhatsAppPairingSnapshot | null;
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
  refresh(sources?: Account[]): Promise<void>;
  /** The one control that extends the list: the next older page from every source that has one. */
  more(): Promise<void>;
  setFilter(f: InboxFilter): void;
  setQuery(q: string): void;
  setDraft(t: string): void;
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
  /** The pairing card's acts. `pairWhatsApp` is the QR path, which is the default one. */
  pairWhatsApp(): Promise<void>;
  /** The fallback: a code typed on the phone, instead of a QR the phone scans. */
  codeWhatsApp(phone: string): Promise<void>;
  /** Replace a linked device. Deliberate, because re-pairing is the ban lever. */
  rePairWhatsApp(): Promise<void>;
  /** Reopen the socket for an account that is already linked: the retry after a start that failed. */
  reconnectWhatsApp(): Promise<void>;
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

/**
 * How often the card asks where pairing stands. A QR rotates every 20 s and its payload dies with it,
 * so the poll has to be quicker than that; a paired or an unpaired source changes only when the owner
 * acts, so it stops asking.
 */
const PAIRING_POLL_MS = 2_000;

/** A row's identity across sources; the same thread can arrive from a refresh and from a page. */
function rowKey(item: InboxItem): string {
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
    pairing: null,
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

  /** Per source: whether it told the gateway it still holds rows older than the newest page. */
  const olderLeft = new Map<Account, boolean>();
  /** When the round in flight must have answered by; null when no round is running. */
  let olderDue: number | null = null;
  /** Bumped when a round is given up, so the answers it was still waiting for are dropped. */
  let olderSeq = 0;

  let cacheDue: number | null = null;
  let cacheReading = false;
  async function readCache(): Promise<void> {
    if (cacheReading) return;
    cacheReading = true;
    try {
      const cached = await deps.rpc.call('cached', null);
      for (const account of accounts) {
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

  /** Replace one source's rows; the list stays newest first. */
  function mergeSource(account: Account, listed: InboxItem[]): void {
    // A row that has moved back into the newest page (new mail pushed the page down) is served
    // by `listed`; keeping the older copy too would render the same row twice.
    const listedIds = new Set(listed.map(item => item.id));
    const kept = (olderRows.get(account) ?? []).filter(item => !listedIds.has(item.id));
    olderRows.set(account, kept);
    setItems([...state.items.filter(item => item.account !== account), ...listed, ...kept].sort((a, b) => b.date - a.date));
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
      await readCache();
      void loadAudit();
    })();
    void refreshPairing();
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

  /** The pairing card's clock; null when nothing is in progress and there is nothing to watch. */
  let pairingDue: number | null = null;

  /** The last answer as one comparable string: a poll that says the same thing must not re-render. */
  function pairingKey(snapshot: WhatsAppPairingSnapshot | null): string {
    if (!snapshot) return '';
    return [snapshot.state, snapshot.qr ?? '', snapshot.code ?? '', snapshot.expiresAt ?? 0, snapshot.message ?? ''].join('\u0000');
  }

  function schedulePairing(): void {
    const name = state.pairing?.state;
    pairingDue = name === 'connecting' || name === 'qr' || name === 'code' ? clock() + PAIRING_POLL_MS : null;
  }

  /** Where the pairing stands. A failure here leaves the card as it was: it is not the source's error. */
  async function refreshPairing(): Promise<void> {
    try {
      const answer = await deps.rpc.call('whatsapp_pairing', null);
      if (!answer) return;
      const changed = pairingKey(answer) !== pairingKey(state.pairing);
      state.pairing = answer;
      schedulePairing();
      if (changed) notify();
    } catch { /* the card keeps the answer it already had */ }
  }

  /** One pairing act: the card names it, the gateway answers the state it left behind. */
  async function actWhatsApp(request: WhatsAppPairingRequest): Promise<void> {
    try {
      const answer = await deps.rpc.call('whatsapp_pairing', request);
      if (!answer) return;
      state.pairing = answer;
      schedulePairing();
      notify();
    } catch (error) {
      // A refusal is not the source failing: it is the act that did not happen, said in one line.
      state.status = error instanceof Error ? error.message : 'WhatsApp pairing did not answer.';
      notify();
    }
  }

  /** Forget every failure the predicate names; the one way a line leaves the list. */
  function dropErrors(matches: (error: InboxError) => boolean): void {
    const kept = state.errors.filter(error => !matches(error));
    if (kept.length !== state.errors.length) state.errors = kept;
  }

  async function refresh(sources: Account[] = DEFAULT_SOURCES): Promise<void> {
    const pending = sources.filter(account => !refreshing.has(account));
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
   * The next older page: one source at a time and merged as each answers, so WhatsApp rows land in
   * a second while Gmail is still reading its twenty threads. One round at a time, no side effect
   * from rendering, a source failure in `errors` with the shown rows untouched — and a round that
   * misses OLDER_TIMEOUT_MS is given up rather than left waiting forever.
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
          const page = await deps.rpc.call('list', { older: true, account });
          // A round the ceiling gave up on has already told the owner; its late rows are dropped
          // rather than appearing under a message that says they did not.
          if (seq !== olderSeq) return;
          const seen = new Set(state.items.map(rowKey));
          const fresh: InboxItem[] = page.items.filter((item: InboxItem) => !seen.has(rowKey(item)));
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
      // The owner pressing Send is the statement the transport can carry: the gate refuses and
      // records a reply that arrives without it.
      await deps.rpc.call('action', { account, id, action: 'reply', text: draft, allow: 'send' });
      clearComposerDraft(account, id);
      state.text = '';
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
      notify();
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

    // A pairing in progress is the only thing the card watches: its QR rotates and its code dies with
    // the socket, and both are facts the gateway reports rather than the panel guessing at.
    if (pairingDue !== null && now >= pairingDue) {
      pairingDue = null;
      void refreshPairing();
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
    refresh,
    more,
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
    attach,
    detach,
    setMail,
    discardMail,
    sendMail,
    pairWhatsApp: () => actWhatsApp({ op: 'pair' }),
    codeWhatsApp: phone => actWhatsApp({ op: 'request-code', phone }),
    async rePairWhatsApp() {
      await actWhatsApp({ op: 'unpair' });
      await actWhatsApp({ op: 'pair' });
    },
    reconnectWhatsApp: () => actWhatsApp({ op: 'reconnect' }),
    notify(text) {
      state.status = text;
      notify();
    },
  };
}
