// The WhatsApp transport's own durable store (plan D5, unit U2).
//
// A message that arrived must still be readable after a restart with the socket down, and Baileys
// asks `getMessage(key)` for envelopes it has already seen. So the transport writes its own rows,
// and the raw envelope is kept beside them: that is what makes a replay idempotent (a re-ingested
// history batch replaces the row, never adds one) and what makes a decryption retry possible.
//
// The panel's `inbox_cache` / `inbox_thread` stay what they are — the panel's projection, rewritten
// wholesale on open, with no envelope — and are not this store. It lives in the same plugin database
// so `clear_cache` can cover both (see `src/inbox-cache.ts`), with `wa_`-prefixed tables so it cannot
// collide with them.
//
// Lifted from WhatsAgent's `server/store/{messages,chats,contacts,identity}.ts`, with three
// deliberate differences:
//   - columns that served WhatsAgent's own UI and nothing here are gone: `channel` (this database is
//     WhatsApp only) and `chats.unread/muted/archived/agent_state` (WhatsApp's own counter, mute and
//     archive are not things this plugin shows). `contacts.avatar_url` is gone as a contact column but
//     comes back as its own table: a picture URL expires, so what the plugin needs to keep is an
//     answer *and* when it was learned (`wa_avatars`, INBOX-29). `chats.last_read_msg_id` comes back
//     in U3: it is the only place a read mark can live, because the panel's `inbox_unread_mark`
//     records a deliberate mark, not where reading stopped, so unread would otherwise have no source
//     at all.
//
// The cursor is a message id, not a timestamp: WhatsApp message ids are not ordered, so "read up to
// here" has to name a row. It moves forward only (`markRead`), and a chat with no cursor counts no
// unread — history that was just synced is not news.
//   - the LID merge moves only the children this database has (messages, reactions). WhatsAgent also
//     moved drafts, outbox rows and proposals, which live in its schema and not in ours.
//   - one module owns the shape, as `src/inbox-cache.ts` does, instead of one file per table.
//
// Schema shape. The plugin has no migration runner: `CREATE TABLE IF NOT EXISTS` on every start is
// the idiom `src/inbox-cache.ts` already uses, and it is what an existing install sees the first time
// this code runs — its cached rows are untouched and five empty `wa_*` tables appear. A future column
// follows the same module's rule rather than a second mechanism: `PRAGMA table_info(<table>)` finds
// the column missing and `ALTER TABLE <table> ADD COLUMN …` adds it, in this constructor, once.
import type Database from 'better-sqlite3';
import type { proto, WAMessageKey } from 'baileys';
import type { StoredMessageLoader } from './connection.ts';

/**
 * Baileys is 7.9 MB of bundle and this module is constructed on every plugin start, so its codec is
 * loaded the first time a socket actually asks for a stored message (the same reason `server.ts`
 * imports the connection lazily). Without the reviver a stored envelope comes back as plain objects
 * instead of typed arrays — not a message Baileys can resend.
 */
let bufferJson: Promise<typeof import('baileys').BufferJSON> | undefined;
const bufferJsonCodec = () => (bufferJson ??= import('baileys').then((module) => module.BufferJSON));

/** Persisted media viewer state; never inferred by a reader (plan D2 of the media work). */
export type MediaState = 'placeholder' | 'downloading' | 'ready' | 'failed';
/** `unavailable` is terminal (WhatsApp-side expiry / reupload refused); `transient` is retriable. */
export type MediaFailureReason = 'unavailable' | 'transient';

export type Message = {
  id: string;
  chat_jid: string;
  from_me: boolean;
  sender: string | null;
  ts: number;
  type: string;
  text: string | null;
  media_ref: string | null;
  media_state: MediaState;
  media_error: MediaFailureReason | null;
  quote_target_id: string | null;
  quote_sender: string | null;
  quote_type: string | null;
  quote_text: string | null;
  /** The full WAMessage envelope, `BufferJSON`-encoded. Kept for `getMessage(key)`. */
  raw: string | null;
  edited_at: number | null;
};

export type MessageInput = {
  id: string;
  chat_jid: string;
  from_me: boolean;
  sender?: string | null;
  ts: number;
  type?: string;
  text?: string | null;
  media_ref?: string | null;
  quote_target_id?: string | null;
  quote_sender?: string | null;
  quote_type?: string | null;
  quote_text?: string | null;
  raw?: string | null;
};

export type ChatKind = '1:1' | 'group';

export type Chat = {
  jid: string;
  name: string | null;
  kind: ChatKind;
  last_msg_at: number | null;
  /** The newest message the owner has read here; null until something is read. */
  last_read_msg_id: string | null;
};

export type ChatInput = {
  jid: string;
  name?: string | null;
  kind: ChatKind;
  last_msg_at?: number | null;
};

/**
 * Where a chat's picture stands, in the same vocabulary as media: `ready` carries the URL, `failed`
 * means asked and answered "none" — a normal answer, kept so a redraw does not ask again. A row that
 * does not exist has never been asked, which is the placeholder state; there is no third value to
 * keep in step.
 */
export type AvatarState = 'ready' | 'failed';

export type Avatar = {
  jid: string;
  url: string | null;
  state: AvatarState;
  /** Unix milliseconds when this answer was learned; the URL itself expires, so it is re-asked later. */
  fetched_at: number | null;
  /**
   * Why the ask came back empty, in the provider's own words and bounded. A privacy setting, a
   * timeout, and a rate limit all look like `failed` in the row, and without this line there is no
   * way to tell a picture that will never come from one that was refused for the moment.
   */
  reason?: string | null;
};

export type Contact = {
  jid: string;
  name: string | null;
  push_name: string | null;
  lid_jid: string | null;
  phone_jid: string | null;
};

export type ContactInput = {
  jid: string;
  name?: string | null;
  push_name?: string | null;
  lid_jid?: string | null;
  phone_jid?: string | null;
};

export type ContactIdentity = {
  lidJid: string;
  phoneJid: string;
  name?: string | null;
  pushName?: string | null;
};

export type MessageReaction = {
  chat_jid: string;
  target_msg_id: string;
  actor: string;
  emoji: string;
  updated_at: number;
};

export type MessageReactionInput = MessageReaction;

/** A vote that cannot be decrypted until its poll creation row exists. */
export type PendingPollVote = {
  encPayload: string;
  encIv: string;
  voterJid: string;
  pollCreatorJid: string;
};

/** One actor's latest selection on one poll. `options` is absent while the vote is still ciphertext. */
export type PollVote = {
  chat_jid: string;
  poll_msg_id: string;
  actor: string;
  options: string[] | null;
  pending: PendingPollVote | null;
  updated_at: number;
};

export type PollVoteInput = {
  chat_jid: string;
  poll_msg_id: string;
  actor: string;
  updated_at: number;
  options?: string[];
  pending?: PendingPollVote;
};

/** The chat jid that no longer exists after a merge, and the one that survives. */
export type ChatMerge = { from: string; to: string };

/**
 * Characters WhatsApp uses in privacy masks plus the usual phone separators: a label made only of
 * these is a number or a mask of one, not a person's name. Matched positively — "no A–Z letters"
 * would strip a Chinese, Cyrillic or Arabic name the chat already displays correctly.
 */
const PHONE_CHAR_CLASS = '0-9\\s().\\-/+\u2219\u2022\u00b7';

export function isPhoneShapedLabel(value: string | null | undefined): boolean {
  if (value == null) return false;
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  return new RegExp(`^[${PHONE_CHAR_CLASS}]+$`).test(trimmed);
}

/** A non-empty trimmed name that is not phone-shaped, else `null` — so a caller falls through. */
export function usableName(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || isPhoneShapedLabel(trimmed)) return null;
  return trimmed;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS wa_chats (
    jid TEXT PRIMARY KEY NOT NULL,
    name TEXT,
    kind TEXT NOT NULL CHECK (kind IN ('1:1', 'group')),
    last_msg_at INTEGER,
    last_read_msg_id TEXT
  );
  CREATE TABLE IF NOT EXISTS wa_messages (
    id TEXT PRIMARY KEY NOT NULL,
    chat_jid TEXT NOT NULL REFERENCES wa_chats(jid),
    from_me INTEGER NOT NULL DEFAULT 0,
    sender TEXT,
    ts INTEGER NOT NULL,
    type TEXT NOT NULL DEFAULT 'text',
    text TEXT,
    media_ref TEXT,
    media_state TEXT NOT NULL DEFAULT 'placeholder',
    media_error TEXT,
    quote_target_id TEXT,
    quote_sender TEXT,
    quote_type TEXT,
    quote_text TEXT,
    raw TEXT,
    edited_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS wa_messages_chat_ts_id ON wa_messages(chat_jid, ts, id);
  CREATE TABLE IF NOT EXISTS wa_contacts (
    jid TEXT PRIMARY KEY NOT NULL,
    name TEXT,
    push_name TEXT,
    lid_jid TEXT,
    phone_jid TEXT
  );
  CREATE INDEX IF NOT EXISTS wa_contacts_lid_jid ON wa_contacts(lid_jid);
  CREATE INDEX IF NOT EXISTS wa_contacts_phone_jid ON wa_contacts(phone_jid);
  CREATE TABLE IF NOT EXISTS wa_avatars (
    jid TEXT PRIMARY KEY NOT NULL,
    url TEXT,
    state TEXT NOT NULL CHECK (state IN ('ready', 'failed')),
    fetched_at INTEGER,
    reason TEXT
  );
  CREATE TABLE IF NOT EXISTS wa_message_reactions (
    chat_jid TEXT NOT NULL REFERENCES wa_chats(jid),
    target_msg_id TEXT NOT NULL,
    actor TEXT NOT NULL,
    emoji TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (chat_jid, target_msg_id, actor)
  );
  CREATE INDEX IF NOT EXISTS wa_message_reactions_target ON wa_message_reactions(chat_jid, target_msg_id);
  CREATE TABLE IF NOT EXISTS wa_poll_votes (
    chat_jid TEXT NOT NULL REFERENCES wa_chats(jid),
    poll_msg_id TEXT NOT NULL,
    actor TEXT NOT NULL,
    options_json TEXT,
    pending_json TEXT,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (chat_jid, poll_msg_id, actor)
  );
  CREATE INDEX IF NOT EXISTS wa_poll_votes_poll ON wa_poll_votes(poll_msg_id);
`;

type MessageRow = Omit<Message, 'from_me'> & { from_me: number };
type ChatRow = Chat;
type PollVoteRow = {
  chat_jid: string;
  poll_msg_id: string;
  actor: string;
  options_json: string | null;
  pending_json: string | null;
  updated_at: number;
};

function mapMessage(row: MessageRow): Message {
  return { ...row, from_me: row.from_me !== 0 };
}

function mapPollVote(row: PollVoteRow): PollVote {
  let options: string[] | null = null;
  let pending: PendingPollVote | null = null;
  if (row.options_json) {
    try {
      const parsed = JSON.parse(row.options_json) as unknown;
      options = Array.isArray(parsed) ? parsed.filter((name): name is string => typeof name === 'string') : null;
    } catch {
      options = null;
    }
  }
  if (row.pending_json) {
    try {
      const parsed = JSON.parse(row.pending_json) as PendingPollVote;
      if (parsed?.encPayload && parsed.encIv && parsed.voterJid && parsed.pollCreatorJid) pending = parsed;
    } catch {
      pending = null;
    }
  }
  return {
    chat_jid: row.chat_jid,
    poll_msg_id: row.poll_msg_id,
    actor: row.actor,
    options,
    pending,
    updated_at: row.updated_at,
  };
}

/** One chat with what a list row needs: its newest message and how much of it is unread. */
export type ChatPageRow = { chat: Chat; last: Message | null; unread: number };

/**
 * One stored message as the search corpus reads it: the text and who wrote it, without the envelope,
 * the media descriptor or the quote — a corpus is read for its words, and the 6,186 envelopes in this
 * store are what makes reading them all expensive.
 */
export type CorpusMessage = {
  id: string;
  chatJid: string;
  fromMe: boolean;
  /** The sending jid, exactly as stored; the transport turns it into a name. */
  sender: string | null;
  ts: number;
  type: string;
  text: string;
  edited: boolean;
};

/** One chat with every message it stores — one row of the corpus search reads. */
export type CorpusChatRow = { chat: Chat; unread: number; messages: CorpusMessage[] };

type CorpusRow = { id: string; chat_jid: string; from_me: number; sender: string | null; ts: number; type: string; text: string | null; edited_at: number | null };

/**
 * A column added after the tables first shipped. `CREATE TABLE IF NOT EXISTS` leaves an existing
 * table alone, so this is the one place that notices — the plugin has no migration runner.
 */
function ensureColumn(db: Database.Database, table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((row) => row.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

/** Where a message sits in its chat: timestamps collide, so the id is the tie-break. */
function comparePosition(a: { ts: number; id: string }, b: { ts: number; id: string }): number {
  return a.ts === b.ts ? a.id.localeCompare(b.id) : a.ts - b.ts;
}

/**
 * One store per plugin database. Every statement is prepared once here, and the store — not its
 * callers — owns the write ordering (a chat row before the message that references it).
 */
export function createWhatsAppStore(db: Database.Database) {
  db.exec(SCHEMA);
  ensureColumn(db, 'wa_chats', 'last_read_msg_id', 'TEXT');
  ensureColumn(db, 'wa_avatars', 'reason', 'TEXT');

  const insertMessage = db.prepare(
    `INSERT INTO wa_messages (
       id, chat_jid, from_me, sender, ts, type, text, media_ref,
       quote_target_id, quote_sender, quote_type, quote_text, raw
     ) VALUES (
       @id, @chat_jid, @from_me, @sender, @ts, @type, @text, @media_ref,
       @quote_target_id, @quote_sender, @quote_type, @quote_text, @raw
     )
     ON CONFLICT(id) DO UPDATE SET
       chat_jid = excluded.chat_jid,
       from_me = excluded.from_me,
       sender = excluded.sender,
       ts = excluded.ts,
       type = excluded.type,
       text = excluded.text,
       media_ref = COALESCE(excluded.media_ref, wa_messages.media_ref),
       quote_target_id = excluded.quote_target_id,
       quote_sender = excluded.quote_sender,
       quote_type = excluded.quote_type,
       quote_text = excluded.quote_text,
       raw = excluded.raw`,
  );
  const updateEditedMessage = db.prepare(
    'UPDATE wa_messages SET type = ?, text = ?, raw = ?, edited_at = ? WHERE id = ? AND chat_jid = ?',
  );
  const setMediaState = db.prepare('UPDATE wa_messages SET media_state = ?, media_error = ? WHERE id = ?');
  const setMediaRef = db.prepare(
    "UPDATE wa_messages SET media_ref = ?, media_state = 'ready', media_error = NULL WHERE id = ?",
  );
  const forgetMediaRef = db.prepare(
    "UPDATE wa_messages SET media_ref = NULL, media_state = 'placeholder' WHERE id = ?",
  );
  const readMessage = db.prepare('SELECT * FROM wa_messages WHERE id = ?');
  const readMessages = db.prepare('SELECT * FROM wa_messages WHERE chat_jid = ? ORDER BY ts ASC, id ASC');
  const countMessages = db.prepare('SELECT COUNT(*) AS c FROM wa_messages');
  const insertReaction = db.prepare(
    `INSERT INTO wa_message_reactions (chat_jid, target_msg_id, actor, emoji, updated_at)
     VALUES (@chat_jid, @target_msg_id, @actor, @emoji, @updated_at)
     ON CONFLICT(chat_jid, target_msg_id, actor) DO UPDATE SET
       emoji = excluded.emoji,
       updated_at = excluded.updated_at`,
  );
  const deleteReaction = db.prepare(
    'DELETE FROM wa_message_reactions WHERE chat_jid = ? AND target_msg_id = ? AND actor = ?',
  );
  const readReactions = db.prepare(
    'SELECT * FROM wa_message_reactions WHERE chat_jid = ? AND target_msg_id = ? ORDER BY updated_at ASC, actor ASC',
  );
  const insertChat = db.prepare(
    `INSERT INTO wa_chats (jid, name, kind, last_msg_at)
     VALUES (@jid, @name, @kind, @last_msg_at)
     ON CONFLICT(jid) DO UPDATE SET
       name = excluded.name,
       kind = excluded.kind,
       last_msg_at = excluded.last_msg_at`,
  );
  const readChat = db.prepare('SELECT * FROM wa_chats WHERE jid = ?');
  const readAllChats = db.prepare(
    'SELECT * FROM wa_chats ORDER BY last_msg_at IS NULL, last_msg_at DESC, jid ASC',
  );
  // Every message in the store, grouped by chat in the order a thread reads: the corpus is read
  // once, so this is one statement rather than 699.
  const readCorpusMessages = db.prepare(
    `SELECT id, chat_jid, from_me, sender, ts, type, text, edited_at
       FROM wa_messages ORDER BY chat_jid, ts ASC, id ASC`,
  );
  const readChatPage = db.prepare(
    `SELECT * FROM wa_chats
      ORDER BY last_msg_at IS NULL, last_msg_at DESC, jid ASC
      LIMIT ? OFFSET ?`,
  );
  const readLastMessage = db.prepare(
    'SELECT * FROM wa_messages WHERE chat_jid = ? ORDER BY ts DESC, id DESC LIMIT 1',
  );
  const readLastPreview = db.prepare(
    `SELECT * FROM wa_messages
      WHERE chat_jid = ? AND type NOT IN ('pollUpdate', 'system', 'protocol', 'reaction')
      ORDER BY ts DESC, id DESC LIMIT 1`,
  );
  const readRecentMessages = db.prepare(
    `SELECT * FROM (
       SELECT * FROM wa_messages WHERE chat_jid = ? ORDER BY ts DESC, id DESC LIMIT ?
     ) ORDER BY ts ASC, id ASC`,
  );
  const readOlderMessages = db.prepare(
    `SELECT * FROM (
       SELECT * FROM wa_messages WHERE chat_jid = ? AND (ts, id) <
         (SELECT ts, id FROM wa_messages WHERE chat_jid = ? AND id = ?)
       ORDER BY ts DESC, id DESC LIMIT ?
     ) ORDER BY ts ASC, id ASC`,
  );
  const readMessagesByType = db.prepare(
    'SELECT * FROM wa_messages WHERE chat_jid = ? AND type = ? ORDER BY ts ASC, id ASC',
  );
  const readNewestMessageId = db.prepare(
    'SELECT id FROM wa_messages WHERE chat_jid = ? ORDER BY ts DESC, id DESC LIMIT 1',
  );
  // Row values are what makes "newer than the cursor" one comparison instead of two.
  const countUnread = db.prepare(
    `SELECT COUNT(*) AS c FROM wa_messages
      WHERE chat_jid = ? AND from_me = 0
        AND (ts, id) > (SELECT ts, id FROM wa_messages WHERE id = ?)`,
  );
  const setReadCursor = db.prepare('UPDATE wa_chats SET last_read_msg_id = ? WHERE jid = ?');
  const insertContact = db.prepare(
    `INSERT INTO wa_contacts (jid, name, push_name, lid_jid, phone_jid)
     VALUES (@jid, @name, @push_name, @lid_jid, @phone_jid)
     ON CONFLICT(jid) DO UPDATE SET
       name = COALESCE(excluded.name, wa_contacts.name),
       push_name = COALESCE(excluded.push_name, wa_contacts.push_name),
       lid_jid = COALESCE(excluded.lid_jid, wa_contacts.lid_jid),
       phone_jid = COALESCE(excluded.phone_jid, wa_contacts.phone_jid)`,
  );
  const readContact = db.prepare('SELECT * FROM wa_contacts WHERE jid = ?');
  const readContactByPhone = db.prepare(
    'SELECT jid, phone_jid FROM wa_contacts WHERE jid = ? OR phone_jid = ?',
  );
  const readAvatar = db.prepare('SELECT * FROM wa_avatars WHERE jid = ?');
  const insertAvatar = db.prepare(
    `INSERT INTO wa_avatars (jid, url, state, fetched_at, reason)
     VALUES (@jid, @url, @state, @fetched_at, @reason)
     ON CONFLICT(jid) DO UPDATE SET
       url = excluded.url,
       state = excluded.state,
       fetched_at = excluded.fetched_at,
       reason = excluded.reason`,
  );
  const dropAvatar = db.prepare('DELETE FROM wa_avatars WHERE jid = ?');
  const readPhoneAlias = db.prepare(
    `SELECT phone_jid FROM wa_contacts
       WHERE (jid = ? OR lid_jid = ?)
         AND phone_jid IS NOT NULL
         AND phone_jid LIKE '%@s.whatsapp.net'
       LIMIT 1`,
  );
  const moveMessages = db.prepare('UPDATE wa_messages SET chat_jid = ? WHERE chat_jid = ?');
  const moveReactions = db.prepare(
    `INSERT INTO wa_message_reactions (chat_jid, target_msg_id, actor, emoji, updated_at)
     SELECT ?, target_msg_id, actor, emoji, updated_at
       FROM wa_message_reactions WHERE chat_jid = ?
     ON CONFLICT(chat_jid, target_msg_id, actor) DO UPDATE SET
       emoji = excluded.emoji,
       updated_at = excluded.updated_at
     WHERE excluded.updated_at > wa_message_reactions.updated_at`,
  );
  const dropReactions = db.prepare('DELETE FROM wa_message_reactions WHERE chat_jid = ?');
  const movePollVotes = db.prepare(
    `INSERT INTO wa_poll_votes (chat_jid, poll_msg_id, actor, options_json, pending_json, updated_at)
     SELECT ?, poll_msg_id, actor, options_json, pending_json, updated_at
       FROM wa_poll_votes WHERE chat_jid = ?
     ON CONFLICT(chat_jid, poll_msg_id, actor) DO UPDATE SET
       options_json = excluded.options_json,
       pending_json = excluded.pending_json,
       updated_at = excluded.updated_at
     WHERE excluded.updated_at > wa_poll_votes.updated_at`,
  );
  const dropPollVotes = db.prepare('DELETE FROM wa_poll_votes WHERE chat_jid = ?');
  const dropChat = db.prepare('DELETE FROM wa_chats WHERE jid = ?');
  const insertPollVote = db.prepare(
    `INSERT INTO wa_poll_votes (chat_jid, poll_msg_id, actor, options_json, pending_json, updated_at)
     VALUES (@chat_jid, @poll_msg_id, @actor, @options_json, @pending_json, @updated_at)
     ON CONFLICT(chat_jid, poll_msg_id, actor) DO UPDATE SET
       options_json = excluded.options_json,
       pending_json = excluded.pending_json,
       updated_at = excluded.updated_at`,
  );
  const deletePollVote = db.prepare(
    'DELETE FROM wa_poll_votes WHERE chat_jid = ? AND poll_msg_id = ? AND actor = ?',
  );
  const readPollVotes = db.prepare(
    'SELECT * FROM wa_poll_votes WHERE chat_jid = ? AND poll_msg_id = ? ORDER BY updated_at ASC, actor ASC',
  );
  const readPendingPollVotes = db.prepare(
    'SELECT * FROM wa_poll_votes WHERE poll_msg_id = ? AND pending_json IS NOT NULL ORDER BY updated_at ASC, actor ASC',
  );

  const upsertChat = (chat: ChatInput): void => {
    insertChat.run({
      jid: chat.jid,
      name: chat.name ?? null,
      kind: chat.kind,
      last_msg_at: chat.last_msg_at ?? null,
    });
  };

  const mergeChats = (from: string, to: string): boolean => {
    if (from === to) return false;
    const loser = readChat.get(from) as ChatRow | undefined;
    if (!loser) return false;
    const winner = readChat.get(to) as ChatRow | undefined;
    db.transaction(() => {
      // The surviving row must exist before children point at it (foreign keys are on).
      upsertChat({
        jid: to,
        name: winner?.name ?? loser.name,
        kind: winner?.kind ?? loser.kind,
        last_msg_at: Math.max(winner?.last_msg_at ?? 0, loser.last_msg_at ?? 0) || null,
      });
      // A cursor names a message id, and ids survive the move, so the best known one carries over.
      const cursor = winner?.last_read_msg_id ?? loser.last_read_msg_id;
      if (cursor) setReadCursor.run(cursor, to);
      // Message ids are unique on their own, so a moved row can never collide.
      moveMessages.run(to, from);
      // The same actor may have reacted under both identities; the newer verdict wins.
      moveReactions.run(to, from);
      dropReactions.run(from);
      movePollVotes.run(to, from);
      dropPollVotes.run(from);
      // A picture belongs to the person, so the surviving identity keeps the fresher answer and the
      // dead jid is not asked about again.
      const avatars = [readAvatar.get(to), readAvatar.get(from)] as Array<Avatar | undefined>;
      const kept = avatars.filter((avatar): avatar is Avatar => Boolean(avatar))
        .sort((a, b) => (b.fetched_at ?? 0) - (a.fetched_at ?? 0))[0];
      dropAvatar.run(from);
      if (kept) insertAvatar.run({ ...kept, jid: to });
      dropChat.run(from);
    })();
    return true;
  };

  /** The phone jid when this is a LID with a known mapping, otherwise `jid` unchanged. */
  const canonicalChatJid = (jid: string): string => {
    if (!jid.endsWith('@lid')) return jid;
    const row = readPhoneAlias.get(jid, jid) as { phone_jid: string } | undefined;
    return row?.phone_jid ?? jid;
  };

  const upsertContact = (contact: ContactInput): void => {
    insertContact.run({
      jid: contact.jid,
      name: contact.name ?? null,
      push_name: contact.push_name ?? null,
      lid_jid: contact.lid_jid ?? null,
      phone_jid: contact.phone_jid ?? null,
    });
  };

  /**
   * Keep both WhatsApp aliases addressable while sharing the best known metadata. A contact carrying
   * both aliases, or a `lid-mapping.update`, is the signal that two rows are one person.
   */
  const linkContactIdentity = (identity: ContactIdentity): void => {
    const lid = readContact.get(identity.lidJid) as Contact | undefined;
    const phone = readContact.get(identity.phoneJid) as Contact | undefined;
    const name = identity.name ?? phone?.name ?? lid?.name ?? null;
    const pushName = identity.pushName ?? phone?.push_name ?? lid?.push_name ?? null;
    for (const jid of new Set([identity.lidJid, identity.phoneJid])) {
      upsertContact({ jid, name, push_name: pushName, lid_jid: identity.lidJid, phone_jid: identity.phoneJid });
    }
  };

  return {
    /** One transaction for a batch: a half-ingested history set is worse than none. */
    transaction<T>(work: () => T): T {
      return db.transaction(work)();
    },
    upsertChat,
    getChat(jid: string): Chat | undefined {
      return readChat.get(jid) as Chat | undefined;
    },
    /**
     * One page of chats in the order the panel shows them — newest activity first, so paging by
     * offset never repeats a row. `last` is the newest stored message, and `unread` counts only
     * other people's messages newer than the read cursor.
     */
    listChats(input: { offset?: number; limit: number }): ChatPageRow[] {
      const chats = readChatPage.all(input.limit, input.offset ?? 0) as ChatRow[];
      return chats.map((chat) => {
        const last = (readLastPreview.get(chat.jid) ?? readLastMessage.get(chat.jid)) as MessageRow | undefined;
        const unread = chat.last_read_msg_id
          ? (countUnread.get(chat.jid, chat.last_read_msg_id) as { c: number }).c
          : 0;
        return { chat, last: last ? mapMessage(last) : null, unread };
      });
    },
    /**
     * Every chat with every message it stores: the corpus a search reads, in two statements and no
     * socket. The unread count is the same rule `listChats` applies, so a hit can be drawn as the
     * row the list would have drawn.
     */
    listCorpus(): CorpusChatRow[] {
      const byChat = new Map<string, CorpusMessage[]>();
      for (const row of readCorpusMessages.all() as CorpusRow[]) {
        const messages = byChat.get(row.chat_jid) ?? [];
        messages.push({
          id: row.id,
          chatJid: row.chat_jid,
          fromMe: row.from_me !== 0,
          sender: row.sender,
          ts: row.ts,
          type: row.type,
          text: row.text ?? '',
          edited: row.edited_at != null,
        });
        byChat.set(row.chat_jid, messages);
      }
      return (readAllChats.all() as ChatRow[]).map(chat => ({
        chat,
        unread: chat.last_read_msg_id
          ? (countUnread.get(chat.jid, chat.last_read_msg_id) as { c: number }).c
          : 0,
        messages: byChat.get(chat.jid) ?? [],
      }));
    },
    /** The newest `limit` messages of one chat, oldest first — the order a thread reads in. */
    listRecentMessages(chatJid: string, limit: number, before?: string): Message[] {
      const rows = before ? readOlderMessages.all(chatJid, chatJid, before, limit) : readRecentMessages.all(chatJid, limit);
      return (rows as MessageRow[]).map(mapMessage);
    },
    listMessagesByType(chatJid: string, type: string): Message[] {
      return (readMessagesByType.all(chatJid, type) as MessageRow[]).map(mapMessage);
    },
    /** Where a read stops: the newest stored message of a chat. */
    newestMessageId(chatJid: string): string | undefined {
      const row = readNewestMessageId.get(chatJid) as { id: string } | undefined;
      return row?.id;
    },
    /**
     * Move the read cursor to `messageId`, forward only: re-reading an older row must never claim a
     * newer message was read, and an id from another chat is refused rather than recorded.
     */
    markRead(chatJid: string, messageId: string): boolean {
      const chat = readChat.get(chatJid) as ChatRow | undefined;
      const target = readMessage.get(messageId) as MessageRow | undefined;
      if (!chat || !target || target.chat_jid !== chatJid) return false;
      const current = chat.last_read_msg_id
        ? (readMessage.get(chat.last_read_msg_id) as MessageRow | undefined)
        : undefined;
      if (current && comparePosition(current, target) >= 0) return false;
      setReadCursor.run(messageId, chatJid);
      return true;
    },
    /**
     * History that was synced is not news: a chat with no cursor yet gets its newest stored message,
     * so a first pairing does not open with every chat marked unread. An existing cursor is left
     * where it is — a history batch may append messages newer than it, and those really are unread.
     */
    markChatsRead(chatJids: Iterable<string>): void {
      for (const jid of new Set(chatJids)) {
        const chat = readChat.get(jid) as ChatRow | undefined;
        if (!chat || chat.last_read_msg_id) continue;
        const newest = readNewestMessageId.get(jid) as { id: string } | undefined;
        if (newest) setReadCursor.run(newest.id, jid);
      }
    },
    canonicalChatJid,
    linkIdentityAndMergeChats(identity: ContactIdentity): ChatMerge | null {
      linkContactIdentity(identity);
      return mergeChats(identity.lidJid, identity.phoneJid) ? { from: identity.lidJid, to: identity.phoneJid } : null;
    },
    upsertContact,
    getContact(jid: string): Contact | undefined {
      return readContact.get(jid) as Contact | undefined;
    },
    /**
     * The chat id already stored for these digits. A phone row and a LID row both match. The phone
     * jid wins when it is a phone, because that is the chat the list already shows. No socket.
     */
    findPhoneJid(digits: string): string | undefined {
      const phone = `${digits}@s.whatsapp.net`;
      const row = readContactByPhone.get(phone, phone) as { jid: string; phone_jid: string | null } | undefined;
      if (!row) return undefined;
      return row.phone_jid?.endsWith('@s.whatsapp.net') ? row.phone_jid : row.jid;
    },
    /**
     * What is known about a person's or a group's picture. Absent means never asked; `failed` means
     * asked and answered "none", which is a fact worth keeping but not a failure.
     */
    getAvatar(jid: string): Avatar | undefined {
      const row = readAvatar.get(jid) as Avatar | undefined;
      if (!row) return undefined;
      // An answer that arrived has no reason: absence, not a row that says `null`.
      const { reason, ...rest } = row;
      return reason ? { ...rest, reason } : rest;
    },
    setAvatar(avatar: Avatar): void {
      // `reason` is named in the statement, so a writer that has nothing to say passes null rather
      // than leaving the parameter out — better-sqlite3 refuses a statement with a missing name.
      insertAvatar.run({ reason: null, ...avatar });
    },
    /**
     * Idempotent: the same id replaces its row. `media_ref` is preserved on conflict and the media
     * state is not touched at all, so re-ingesting history never resets a cached picture.
     */
    upsertMessage(message: MessageInput): void {
      insertMessage.run({
        id: message.id,
        chat_jid: message.chat_jid,
        from_me: message.from_me ? 1 : 0,
        sender: message.sender ?? null,
        ts: message.ts,
        type: message.type ?? 'text',
        text: message.text ?? null,
        media_ref: message.media_ref ?? null,
        quote_target_id: message.quote_target_id ?? null,
        quote_sender: message.quote_sender ?? null,
        quote_type: message.quote_type ?? null,
        quote_text: message.quote_text ?? null,
        raw: message.raw ?? null,
      });
    },
    getMessage(id: string): Message | undefined {
      const row = readMessage.get(id) as MessageRow | undefined;
      return row ? mapMessage(row) : undefined;
    },
    listMessages(chatJid: string): Message[] {
      return (readMessages.all(chatJid) as MessageRow[]).map(mapMessage);
    },
    countMessages(): number {
      return (countMessages.get() as { c: number }).c;
    },
    /** Replace the content of the same message identity after a verified provider edit. */
    updateEditedMessage(input: {
      id: string;
      chat_jid: string;
      type: string;
      text: string | null;
      raw: string;
      edited_at: number;
    }): boolean {
      return updateEditedMessage.run(input.type, input.text, input.raw, input.edited_at, input.id, input.chat_jid).changes === 1;
    },
    setMediaState(id: string, state: MediaState, error: MediaFailureReason | null = null): void {
      setMediaState.run(state, state === 'failed' ? error : null, id);
    },
    /** Records a successful download: cached path + `ready`, in one statement. */
    setMediaRef(id: string, mediaRef: string): void {
      setMediaRef.run(mediaRef, id);
    },
    /**
     * Take back a cache entry: a row with no ref has no bytes anything may read, so it goes back to
     * `placeholder`. Used when what landed is a file the panel will never show, which no `media_ref`
     * may then point at.
     */
    forgetMediaRef(id: string): void {
      forgetMediaRef.run(id);
    },
    /** One actor has at most one reaction per target; a falsey emoji removes it. */
    upsertMessageReaction(reaction: MessageReactionInput): void {
      const emoji = reaction.emoji?.trim();
      if (!emoji) {
        deleteReaction.run(reaction.chat_jid, reaction.target_msg_id, reaction.actor);
        return;
      }
      insertReaction.run({ ...reaction, emoji });
    },
    listMessageReactions(chatJid: string, targetMsgId: string): MessageReaction[] {
      return readReactions.all(chatJid, targetMsgId) as MessageReaction[];
    },
    /**
     * One actor has one vote on a poll. An empty option list removes it. A pending ciphertext
     * waits for the creation row; storing names clears that ciphertext.
     */
    upsertPollVote(vote: PollVoteInput): void {
      const options = vote.options?.map(option => option.trim()).filter(Boolean);
      if (vote.pending == null && (!options || options.length === 0)) {
        deletePollVote.run(vote.chat_jid, vote.poll_msg_id, vote.actor);
        return;
      }
      insertPollVote.run({
        chat_jid: vote.chat_jid,
        poll_msg_id: vote.poll_msg_id,
        actor: vote.actor,
        options_json: options && options.length > 0 ? JSON.stringify(options) : null,
        pending_json: vote.pending ? JSON.stringify(vote.pending) : null,
        updated_at: vote.updated_at,
      });
    },
    listPollVotes(chatJid: string, pollMsgId: string): PollVote[] {
      return (readPollVotes.all(chatJid, pollMsgId) as PollVoteRow[]).map(mapPollVote);
    },
    listPendingPollVotes(pollMsgId: string): PollVote[] {
      return (readPendingPollVotes.all(pollMsgId) as PollVoteRow[]).map(mapPollVote);
    },
    /**
     * Answers Baileys' `getMessage(key)` from the stored envelope. An unknown id, or a row whose
     * envelope will not parse, answers `undefined` — the protocol treats that as "I cannot resend
     * this", which is true, and throwing here would break a socket event instead.
     */
    storedMessageLoader(): StoredMessageLoader {
      return async (key: WAMessageKey) => {
        if (!key.id) return undefined;
        const stored = readMessage.get(key.id) as MessageRow | undefined;
        if (!stored?.raw) return undefined;
        try {
          const { reviver } = await bufferJsonCodec();
          const envelope = JSON.parse(stored.raw, reviver) as { message?: proto.IMessage | null };
          return envelope.message ?? undefined;
        } catch {
          return undefined;
        }
      };
    },
    /**
     * What a cache clear covers for this store: the messages, chats, contacts and reactions the
     * transport wrote, envelopes included. The account state is not here and is not touched —
     * forgetting it is a re-pair, which is the ban lever.
     */
    clear(): void {
      db.transaction(() => {
        db.prepare('DELETE FROM wa_messages').run();
        db.prepare('DELETE FROM wa_message_reactions').run();
        db.prepare('DELETE FROM wa_poll_votes').run();
        db.prepare('DELETE FROM wa_chats').run();
        db.prepare('DELETE FROM wa_contacts').run();
        db.prepare('DELETE FROM wa_avatars').run();
      })();
    },
  };
}

export type WhatsAppStore = ReturnType<typeof createWhatsAppStore>;
