import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { Account } from './adapters/types.ts';
import type { AttentionVerdict } from './attention-label.ts';
import type { CacheChange, CachedItem, createInboxCache } from './inbox-cache.ts';
import { isInvitationId } from './linkedin-inbox.ts';

export type { AttentionVerdict } from './attention-label.ts';

/** Needed at this probability or above. Every lower score is None. */
const YES_AT = 0.7;
/** A reply you sent at or below this score closes the conversation. */
const NO_AT = 0.3;
/** Stored score format. A wording change is the `q` field, not a new version. */
const RULES = 4;
/** WhatsApp and Messages pool every new message in this window into one ask per conversation. */
const POOL_MS = 8_000;
/** How many conversations can be asked at once. A reload judges the rows already stored. */
const ASK_AT_ONCE = 4;
/** One question per stored line, capped at what one ask can hold. */
const WINDOW = 32;
/** Scores written before the window grew only covered this many lines. Do not reach further back. */
const SCORED_TAIL = 8;

export function attentionVerdict(noul: number): AttentionVerdict {
  return noul >= YES_AT ? 'yes' : 'no';
}

const PUSH_TITLE = 80;
const PUSH_BODY = 180;

const SOURCE_NAME: Record<string, string> = {
  whatsapp: 'WhatsApp',
  imessage: 'Messages',
  linkedin: 'LinkedIn',
  'gmail-personal': 'Personal Gmail',
  'gmail-business': 'Inhouse Gmail',
};

export type AttentionPush = { title: string; body: string };

/** A push only when a stored verdict changes from a previous non-yes to yes. The first store does not push. */
export function attentionPush(
  previous: AttentionVerdict | null,
  next: AttentionVerdict,
  item: { account: string; title: string; preview: string },
): AttentionPush | null {
  if (previous === null || previous === 'yes' || next !== 'yes') return null;
  const source = SOURCE_NAME[item.account] ?? item.account;
  return {
    title: `${source} ${item.title}`.trim().slice(0, PUSH_TITLE),
    body: item.preview.slice(0, PUSH_BODY),
  };
}

export interface AttentionWording {
  question: string;
  yes: string;
  no: string;
}

/** The sentences used when Decisions has not saved a question, or cannot be reached. */
export const DEFAULT_WORDING: AttentionWording = {
  question: 'Messages are in order. Look only at message {n}. Does that one message still need the reader to act?',
  yes: 'It asks the reader to reply, decide, pay, or fix something, and no later message settles that point.',
  no: 'It does not ask the reader. Their own message does not ask them, unless it leaves a task they have not done. A later message settles it when the other person answers, or when the reader replies. Read or unread is not evidence.',
};

const PREVIEW_INSTRUCTION = 'Look only at the preview. Does that one line still need the reader to act?';

export function wordingId(wording: AttentionWording): string {
  return createHash('sha256').update(JSON.stringify({
    question: wording.question,
    yes: wording.yes,
    no: wording.no,
  })).digest('hex').slice(0, 16);
}

export function normalizeWording(value: Partial<AttentionWording> | null | undefined): AttentionWording {
  return {
    question: sentence(value?.question, DEFAULT_WORDING.question),
    yes: sentence(value?.yes, DEFAULT_WORDING.yes),
    no: sentence(value?.no, DEFAULT_WORDING.no),
  };
}

function sentence(value: string | undefined, fallback: string): string {
  const text = value?.trim() ?? '';
  return text ? text.slice(0, 2_000) : fallback;
}

function sameWording(left: AttentionWording, right: AttentionWording): boolean {
  return left.question === right.question && left.yes === right.yes && left.no === right.no;
}

const lineQuestion = (n: number, preview: boolean, wording: AttentionWording) => ({
  type: 'noul' as const,
  instructions: preview && sameWording(wording, DEFAULT_WORDING)
    ? PREVIEW_INSTRUCTION
    : wording.question.replaceAll('{n}', preview ? 'the preview' : String(n)),
  criteria: { true: wording.yes, false: wording.no },
});

/** One yes/no per line. The inbox keeps the highest score, so one line that needs a reply is enough. */
export function attentionQuestions(
  messageNumbers: number[],
  preview = false,
  wording: AttentionWording = DEFAULT_WORDING,
): Record<string, ReturnType<typeof lineQuestion>> {
  const numbers = preview ? [1] : messageNumbers;
  const questions: Record<string, ReturnType<typeof lineQuestion>> = {};
  for (const n of numbers) questions[`line_${n}`] = lineQuestion(n, preview, wording);
  return questions;
}

type ScoredLine = { n: number; text: string; mine: boolean };

export function lineKey(text: string, mine: boolean): string {
  return createHash('sha256').update(`${mine ? 1 : 0}\0${text}`).digest('hex').slice(0, 16);
}

/** A line that already has a score stays. Only a line with no score is asked. */
export function linesToScore(messages: ScoredLine[], saved: Record<string, number> | null): { ask: number[]; kept: Record<string, number> } {
  if (!saved) return { ask: messages.map(message => message.n), kept: {} };
  const ask: number[] = [];
  const kept: Record<string, number> = {};
  for (const message of messages) {
    const key = lineKey(message.text, message.mine);
    const score = saved[key];
    if (typeof score !== 'number') ask.push(message.n);
    else kept[key] = score;
  }
  return { ask, kept };
}

/**
 * A conversation that already has scores keeps that span. Older lines are not
 * pulled in when the window grows. New lines after the span are included.
 * A score with no anchor is the earlier 8-line span: keep that tail only.
 */
export function focusMessages<T extends { text: string; mine: boolean; n: number }>(
  messages: T[],
  saved: Record<string, number> | null,
  anchor: string | null,
): T[] {
  let chosen = messages;
  if (saved && Object.keys(saved).length > 0) {
    if (anchor) {
      const start = messages.findIndex(message => lineKey(message.text, message.mine) === anchor);
      chosen = start === -1 ? messages : messages.slice(start);
    } else {
      chosen = messages.slice(-SCORED_TAIL);
    }
  }
  return chosen.map((message, index) => ({ ...message, n: index + 1 }));
}

/** The highest open line. A reply of yours that leaves nothing to do closes the conversation. */
export function attentionScore(messages: ScoredLine[], scores: Record<string, number>): number {
  const last = messages.at(-1);
  const lastScore = last ? scores[lineKey(last.text, last.mine)] : undefined;
  if (last?.mine && lastScore !== undefined && lastScore <= NO_AT) return lastScore;
  const values = messages.flatMap(message => {
    const score = scores[lineKey(message.text, message.mine)];
    return typeof score === 'number' ? [score] : [];
  });
  return Math.max(...values);
}

type AttentionLine = { sender: string; text: string; fromMe?: boolean };

export function attentionState(input: {
  account: Account;
  id: string;
  title: string;
  preview: string;
  sender?: string;
  messages: AttentionLine[];
}): Record<string, unknown> {
  // Last 32 stored lines, not the whole thread. A conversation never opened has no lines: the preview
  // is the list snippet only. Read state is omitted on purpose.
  const messages = input.messages
    .filter(message => message.text.trim().length > 0)
    .slice(-WINDOW)
    .map((message, index) => ({
      n: index + 1,
      from: message.sender.slice(0, 200),
      text: message.text.slice(0, 2_000),
      mine: message.fromMe === true,
    }));
  return {
    channel: input.account,
    group: input.account === 'whatsapp' && input.id.endsWith('@g.us'),
    title: input.title.slice(0, 300),
    from: (input.sender ?? '').slice(0, 300),
    preview: input.preview.slice(0, 500),
    messages,
  };
}

function readNoul(answer: unknown): number | undefined {
  if (!answer || typeof answer !== 'object' || !('noul' in answer)) return undefined;
  const noul = (answer as { noul: unknown }).noul;
  return typeof noul === 'number' && Number.isFinite(noul) && noul >= 0 && noul <= 1 ? noul : undefined;
}

export function attentionFromAnswer(answers: Record<string, unknown>): { verdict: AttentionVerdict; noul: number } {
  const scores = Object.values(answers).flatMap(answer => {
    const noul = readNoul(answer);
    return noul === undefined ? [] : [noul];
  });
  if (scores.length === 0) throw new Error('The decision model returned no yes/no answer.');
  const noul = Math.max(...scores);
  return { verdict: attentionVerdict(noul), noul };
}

export interface AttentionRecord {
  verdict: AttentionVerdict;
  noul: number;
  stateHash: string;
  /** Scores already given to lines, keyed by line text. Null when this row has no stored lines. */
  lines: Record<string, number> | null;
  /** Oldest line in the scored span. Null means the span is still the earlier tail of 8. */
  anchor: string | null;
  /** The owner marked Needed as None, and the previous score is still here to restore. */
  dismissed?: boolean;
  /** Wording these scores were asked with. Missing means the original sentences. */
  wordingId?: string | null;
}

export interface AttentionStore {
  get(account: Account, id: string): AttentionRecord | null;
  put(account: Account, id: string, record: AttentionRecord): void;
  /** Mark a Needed conversation None and keep that until a new line arrives. */
  dismiss(account: Account, id: string): boolean;
  /** Put back the Needed label from the clear just made. */
  restore(account: Account, id: string): boolean;
  clear(): void;
}

function readScores(value: unknown): Record<string, number> | null {
  if (!value || typeof value !== 'object') return null;
  const scores: Record<string, number> = {};
  for (const [key, noul] of Object.entries(value)) {
    if (typeof noul === 'number' && noul >= 0 && noul <= 1) scores[key] = noul;
  }
  return scores;
}

function parseLines(raw: string | null): { scores: Record<string, number>; anchor: string | null; held: { noul: number; scores: Record<string, number> } | null; q: string | null } | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { v?: unknown; scores?: unknown; anchor?: unknown; held?: unknown; q?: unknown };
    if (parsed.v !== RULES) return null;
    const scores = readScores(parsed.scores) ?? {};
    const anchor = typeof parsed.anchor === 'string' && parsed.anchor.length > 0 ? parsed.anchor : null;
    const heldRecord = parsed.held && typeof parsed.held === 'object' ? parsed.held as { noul?: unknown; scores?: unknown } : null;
    const held = heldRecord && typeof heldRecord.noul === 'number' && heldRecord.noul >= 0 && heldRecord.noul <= 1
      ? { noul: heldRecord.noul, scores: readScores(heldRecord.scores) ?? {} }
      : null;
    if (!parsed.scores && !held) return null;
    const q = typeof parsed.q === 'string' && parsed.q.length > 0 ? parsed.q : null;
    return { scores, anchor, held, q };
  } catch {
    return null;
  }
}

function packLines(scores: Record<string, number>, anchor: string | null, q: string | null, held?: { noul: number; scores: Record<string, number> }): string | null {
  if (Object.keys(scores).length === 0 && !held) return null;
  return JSON.stringify({
    v: RULES,
    anchor,
    scores,
    ...(q ? { q } : {}),
    ...(held ? { held } : {}),
  });
}

export function createAttentionStore(db: Database.Database): AttentionStore {
  db.exec(`CREATE TABLE IF NOT EXISTS inbox_attention (
    account TEXT NOT NULL,
    id TEXT NOT NULL,
    verdict TEXT NOT NULL,
    noul REAL NOT NULL,
    state_hash TEXT NOT NULL,
    lines TEXT,
    PRIMARY KEY (account, id)
  )`);
  const columns = db.prepare('PRAGMA table_info(inbox_attention)').all() as Array<{ name: string }>;
  if (!columns.some(column => column.name === 'lines')) db.exec('ALTER TABLE inbox_attention ADD COLUMN lines TEXT');
  const read = db.prepare('SELECT verdict, noul, state_hash AS stateHash, lines FROM inbox_attention WHERE account = ? AND id = ?');
  const write = db.prepare('INSERT INTO inbox_attention (account, id, verdict, noul, state_hash, lines) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(account, id) DO UPDATE SET verdict = excluded.verdict, noul = excluded.noul, state_hash = excluded.state_hash, lines = excluded.lines');
  return {
    get(account, id) {
      if (account === 'linkedin' && isInvitationId(id)) return null;
      const row = read.get(account, id) as { verdict: string; noul: number; stateHash: string; lines: string | null } | undefined;
      if (!row || (row.verdict !== 'yes' && row.verdict !== 'no' && row.verdict !== 'unsettled')) return null;
      const parsed = parseLines(row.lines);
      return { verdict: attentionVerdict(row.noul), noul: row.noul, stateHash: row.stateHash, lines: parsed?.scores ?? null, anchor: parsed?.anchor ?? null, dismissed: parsed?.held != null, wordingId: parsed?.q ?? null };
    },
    put(account, id, record) {
      const lines = record.lines && Object.keys(record.lines).length > 0
        ? packLines(record.lines, record.anchor, record.wordingId ?? null)
        : null;
      write.run(account, id, record.verdict, record.noul, record.stateHash, lines);
    },
    dismiss(account, id) {
      const row = read.get(account, id) as { verdict: AttentionVerdict; noul: number; stateHash: string; lines: string | null } | undefined;
      if (!row || row.verdict !== 'yes') return false;
      const parsed = parseLines(row.lines);
      const scores = parsed?.scores ?? {};
      const lines = packLines(
        Object.fromEntries(Object.keys(scores).map(key => [key, NO_AT])),
        parsed?.anchor ?? null,
        parsed?.q ?? null,
        { noul: row.noul, scores },
      );
      write.run(account, id, 'no', NO_AT, row.stateHash, lines);
      return true;
    },
    restore(account, id) {
      const row = read.get(account, id) as { verdict: AttentionVerdict; noul: number; stateHash: string; lines: string | null } | undefined;
      const parsed = row ? parseLines(row.lines) : null;
      if (!row || !parsed?.held) return false;
      const scores = parsed.held.scores;
      const lines = packLines(scores, parsed.anchor, parsed.q);
      write.run(account, id, attentionVerdict(parsed.held.noul), parsed.held.noul, row.stateHash, lines);
      return true;
    },
    clear() {
      db.prepare('DELETE FROM inbox_attention').run();
    },
  };
}

type Cache = Pick<ReturnType<typeof createInboxCache>, 'list' | 'readThread' | 'onChange'>;

export interface AttentionAsk {
  (input: { state: Record<string, unknown>; questions: ReturnType<typeof attentionQuestions> }): Promise<{ answers: Record<string, unknown> }>;
}

/**
 * Classifies each conversation already in the cache, then each one that receives a new message.
 * Opening a conversation saves a thread and is not a new message.
 * WhatsApp and Messages hold new messages for one conversation in an 8 second window, then send
 * one ask. Other sources ask as soon as the conversation changes.
 */
export function watchNewConversations(options: {
  cache: Cache;
  store: AttentionStore;
  ask: AttentionAsk;
  log?: (line: string) => void;
  /** Quiet window for WhatsApp and Messages. `0` asks at once. Default is 8 seconds. */
  debounceMs?: number;
  /**
   * The lines already stored for this conversation, when the cache thread can lag.
   * WhatsApp uses this so a reply you sent is part of the ask before the thread is opened again.
   */
  recentLines?: (account: Account, id: string) => AttentionLine[] | null;
  /** The question Decisions has saved. A failure keeps the original sentences. */
  wording?: () => Promise<AttentionWording>;
  /** A Needed transition. A throw or an empty channel list is logged once and does not change the verdict. */
  notify?: (input: AttentionPush) => Promise<{ channels?: string[] } | void>;
}): { arrived: (account: Account, id: string, message?: AttentionLine) => void; stop: () => void } {
  const seen = new Map<string, string>();
  const extras = new Map<string, AttentionLine[]>();
  let active = 0;
  const waiting: Array<() => void> = [];

  function takeSlot(): Promise<void> {
    if (active < ASK_AT_ONCE) {
      active += 1;
      return Promise.resolve();
    }
    return new Promise(resolve => {
      waiting.push(() => {
        active += 1;
        resolve();
      });
    });
  }

  function releaseSlot(): void {
    active -= 1;
    waiting.shift()?.();
  }
  const inflight = new Map<string, Promise<void>>();
  const pooled = new Map<string, ReturnType<typeof setTimeout>>();
  let stopped = false;
  let pushNoted = false;
  const poolMs = options.debounceMs ?? POOL_MS;

  async function loadWording(): Promise<AttentionWording> {
    if (!options.wording) return DEFAULT_WORDING;
    try {
      return normalizeWording(await options.wording());
    } catch (error) {
      options.log?.(`Question wording unavailable, using the original. ${error instanceof Error ? error.message : ''}`);
      return DEFAULT_WORDING;
    }
  }

  const keyOf = (account: Account, id: string) => `${account}\0${id}`;
  const stampOf = (row: CachedItem) => `${row.date}\0${row.preview}\0${row.sentSnippet ?? ''}`;

  async function classify(account: Account, id: string): Promise<void> {
    if (stopped) return;
    await takeSlot();
    try {
      if (stopped) return;
      await classifyHeld(account, id);
    } finally {
      releaseSlot();
    }
  }

  async function classifyHeld(account: Account, id: string): Promise<void> {
    const key = keyOf(account, id);
    const extra = extras.get(key) ?? [];
    extras.set(key, []);
    const row = options.cache.list().find(item => item.account === account && item.id === id);
    const raw = options.cache.readThread(account, id) ?? [];
    const live = options.recentLines?.(account, id);
    const fromStore = Array.isArray(live) && live.length > 0;
    const stored = fromStore ? live : raw.flatMap(entry => {
      if (!entry || typeof entry !== 'object') return [];
      const message = entry as { sender?: unknown; text?: unknown; fromMe?: unknown };
      if (typeof message.text !== 'string' || message.text.trim() === '') return [];
      return [{ sender: typeof message.sender === 'string' ? message.sender : '', text: message.text, fromMe: message.fromMe === true }];
    });
    const messages = fromStore ? [...stored] : [...stored, ...extra];
    const reply = row?.sentSnippet?.trim();
    if (reply && messages.at(-1)?.text !== reply) messages.push({ sender: 'You', text: reply, fromMe: true });
    const state = attentionState({
      account,
      id,
      title: row?.title ?? '',
      preview: row?.preview ?? extra.at(-1)?.text ?? '',
      sender: row?.sender,
      messages,
    });
    const lines = state.messages as Array<ScoredLine & { from?: string }>;
    if (!state.preview && lines.length === 0) return;
    const prior = options.store.get(account, id);
    const saved = prior?.lines ?? null;
    const wording = await loadWording();
    const currentId = wordingId(wording);
    const custom = currentId !== wordingId(DEFAULT_WORDING);
    const changed = prior != null && saved != null && (prior.wordingId ?? wordingId(DEFAULT_WORDING)) !== currentId;
    const focused = focusMessages(lines, saved, prior?.anchor ?? null);
    state.messages = focused;
    const stateHash = createHash('sha256').update(JSON.stringify(custom
      ? { rules: RULES, agg: 3, q: currentId, state }
      : { rules: RULES, agg: 3, state })).digest('hex');
    if (prior?.stateHash === stateHash && !changed) return;
    const anchor = focused.length === 0
      ? null
      : prior?.anchor && focused.some(line => lineKey(line.text, line.mine) === prior.anchor)
        ? prior.anchor
        : lineKey(focused[0].text, focused[0].mine);
    const covered = !changed && focused.length > 0 && !!saved && focused.every(line => typeof saved[lineKey(line.text, line.mine)] === 'number');
    if (covered && saved) {
      const noul = attentionScore(focused, saved);
      const scores: Record<string, number> = {};
      for (const line of focused) scores[lineKey(line.text, line.mine)] = saved[lineKey(line.text, line.mine)] as number;
      publish(account, id, prior?.verdict ?? null, { verdict: attentionVerdict(noul), noul, stateHash, lines: scores, anchor, wordingId: custom ? currentId : null }, row);
      return;
    }
    const { ask, kept } = focused.length === 0 ? { ask: [] as number[], kept: {} } : linesToScore(focused, changed ? null : saved);
    const answers = lines.length === 0 || ask.length > 0
      ? (await options.ask({ state, questions: attentionQuestions(ask, lines.length === 0, wording) })).answers
      : {};
    if (stopped) return;
    const scores = { ...kept };
    if (lines.length === 0) {
      const result = attentionFromAnswer(answers);
      publish(account, id, prior?.verdict ?? null, { ...result, stateHash, lines: null, anchor: null }, row);
      return;
    }
    for (const message of focused) {
      if (!ask.includes(message.n)) continue;
      const score = readNoul(answers[`line_${message.n}`]);
      if (score === undefined) throw new Error('The decision model returned no yes/no answer.');
      scores[lineKey(message.text, message.mine)] = score;
    }
    const scored = Object.values(scores);
    if (scored.length === 0) throw new Error('The decision model returned no yes/no answer.');
    const noul = attentionScore(focused, scores);
    publish(account, id, prior?.verdict ?? null, { verdict: attentionVerdict(noul), noul, stateHash, lines: scores, anchor, wordingId: custom ? currentId : null }, row);
  }

  function publish(account: Account, id: string, previous: AttentionVerdict | null, record: AttentionRecord, item: { title?: string; preview?: string } | undefined): void {
    options.store.put(account, id, record);
    const notice = attentionPush(previous, record.verdict, {
      account,
      title: item?.title ?? '',
      preview: item?.preview ?? '',
    });
    if (!notice || !options.notify) return;
    void Promise.resolve(options.notify(notice)).then(result => {
      if (result && result.channels?.length === 0) notePush('Push was not delivered.');
    }).catch(error => {
      notePush(`Push was not delivered. ${error instanceof Error ? error.message : ''}`.trim());
    });
  }

  function notePush(line: string): void {
    if (pushNoted) return;
    pushNoted = true;
    options.log?.(line);
  }

  function enqueue(account: Account, id: string): void {
    if (stopped) return;
    const key = keyOf(account, id);
    const previous = inflight.get(key) ?? Promise.resolve();
    const run = previous
      .then(() => classify(account, id))
      .catch(error => {
        options.log?.(`attention ${account} ${id}: ${error instanceof Error ? error.message : 'the ask failed'}`);
      });
    inflight.set(key, run);
    void run.finally(() => { if (inflight.get(key) === run) inflight.delete(key); });
  }

  function noteItems(account: Account): void {
    const rows = options.cache.list().filter(row => row.account === account);
    const live = new Set<string>();
    for (const row of rows) {
      const key = keyOf(account, row.id);
      live.add(key);
      const stamp = stampOf(row);
      const previous = seen.get(key);
      seen.set(key, stamp);
      if (previous !== stamp) schedule(account, row.id);
    }
    for (const key of seen.keys()) {
      if (key.startsWith(`${account}\0`) && !live.has(key)) seen.delete(key);
    }
  }

  const onChange = (change: CacheChange) => {
    if (change.kind === 'clear') {
      for (const timer of pooled.values()) clearTimeout(timer);
      pooled.clear();
      seen.clear();
      extras.clear();
      options.store.clear();
      return;
    }
    if (change.kind === 'items') noteItems(change.account);
  };
  options.cache.onChange(onChange);

  for (const row of options.cache.list()) {
    seen.set(keyOf(row.account, row.id), stampOf(row));
    schedule(row.account, row.id);
  }

  function schedule(account: Account, id: string): void {
    if (account === 'linkedin' && isInvitationId(id)) return;
    const delay = account === 'whatsapp' || account === 'imessage' ? poolMs : 0;
    if (delay === 0) {
      enqueue(account, id);
      return;
    }
    const key = keyOf(account, id);
    if (pooled.has(key)) return;
    pooled.set(key, setTimeout(() => {
      pooled.delete(key);
      enqueue(account, id);
    }, delay));
  }

  let appliedWording: string | null = null;
  const wordingTimer = setInterval(() => {
    void loadWording().then(wording => {
      const id = wordingId(wording);
      if (appliedWording === null) {
        appliedWording = id;
        return;
      }
      if (id === appliedWording) return;
      appliedWording = id;
      for (const key of seen.keys()) {
        const split = key.indexOf('\0');
        schedule(key.slice(0, split) as Account, key.slice(split + 1));
      }
    });
  }, 5_000);
  wordingTimer.unref();

  return {
    arrived(account, id, message) {
      if (stopped) return;
      if (message && message.text.trim()) {
        const key = keyOf(account, id);
        const waiting = extras.get(key) ?? [];
        waiting.push(message);
        extras.set(key, waiting);
      }
      schedule(account, id);
    },
    stop() {
      stopped = true;
      clearInterval(wordingTimer);
      for (const timer of pooled.values()) clearTimeout(timer);
      pooled.clear();
    },
  };
}
