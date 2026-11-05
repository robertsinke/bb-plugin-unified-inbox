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
//     WhatsApp only), `chats.unread/muted/archived/agent_state/last_read_msg_id` (the panel keeps its
//     own unread marks in `inbox_unread_mark`, and this plugin never drives WhatsApp receipts from
//     storage) and `contacts.avatar_url` (no reader — the plugin shows initials avatars).
//   - the LID merge moves only the children this database has (messages, reactions). WhatsAgent also
//     moved drafts, outbox rows and proposals, which live in its schema and not in ours.
//   - one module owns the shape, as `src/inbox-cache.ts` does, instead of one file per table.
//
// Schema shape. The plugin has no migration runner: `CREATE TABLE IF NOT EXISTS` on every start is
// the idiom `src/inbox-cache.ts` already uses, and it is what an existing install sees the first time
// this code runs — its cached rows are untouched and four empty `wa_*` tables appear. A future column
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
};

export type ChatInput = {
  jid: string;
  name?: string | null;
  kind: ChatKind;
  last_msg_at?: number | null;
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
    last_msg_at INTEGER
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
  CREATE TABLE IF NOT EXISTS wa_message_reactions (
    chat_jid TEXT NOT NULL REFERENCES wa_chats(jid),
    target_msg_id TEXT NOT NULL,
    actor TEXT NOT NULL,
    emoji TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (chat_jid, target_msg_id, actor)
  );
  CREATE INDEX IF NOT EXISTS wa_message_reactions_target ON wa_message_reactions(chat_jid, target_msg_id);
`;

type MessageRow = Omit<Message, 'from_me'> & { from_me: number };
type ChatRow = Chat;

function mapMessage(row: MessageRow): Message {
  return { ...row, from_me: row.from_me !== 0 };
}

/**
 * One store per plugin database. Every statement is prepared once here, and the store — not its
 * callers — owns the write ordering (a chat row before the message that references it).
 */
export function createWhatsAppStore(db: Database.Database) {
  db.exec(SCHEMA);

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
  const dropChat = db.prepare('DELETE FROM wa_chats WHERE jid = ?');

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
      // Message ids are unique on their own, so a moved row can never collide.
      moveMessages.run(to, from);
      // The same actor may have reacted under both identities; the newer verdict wins.
      moveReactions.run(to, from);
      dropReactions.run(from);
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
        db.prepare('DELETE FROM wa_chats').run();
        db.prepare('DELETE FROM wa_contacts').run();
      })();
    },
  };
}

export type WhatsAppStore = ReturnType<typeof createWhatsAppStore>;
