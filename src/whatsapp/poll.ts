// WhatsApp polls. The pinned client can decrypt a vote and can build a poll. It does not send a
// vote, and the path that would attach a decrypted vote to the poll is commented out, so this
// module owns both directions. The cipher is the inverse of `decryptPollVote`: same HMAC chain,
// same AES-GCM, same "Poll Vote" label.
import { randomBytes } from 'node:crypto';
import {
  BufferJSON,
  aesEncryptGCM,
  decryptPollVote,
  extractMessageContent,
  getKeyAuthor,
  hmacSign,
  jidNormalizedUser,
  proto,
  sha256,
  type WAMessage,
  type WAMessageKey,
} from 'baileys';

export const POLL_TYPE = 'poll';

const CREATION_FIELDS = ['pollCreationMessage', 'pollCreationMessageV2', 'pollCreationMessageV3', 'pollCreationMessageV5'] as const;

export function isPollCreationType(type: string): boolean {
  return type === POLL_TYPE || type.startsWith('pollCreation');
}

export function isPollUpdateType(type: string): boolean {
  return type === 'pollUpdate';
}

/** The jid a poll vote is sealed with. A key that has both a LID and a phone uses the LID. */
export function pollPartyJid(key: WAMessageKey | null | undefined, meJid?: string): string {
  const direct = key?.participant || key?.participantAlt;
  if (direct) return direct;
  const me = meJid ? jidNormalizedUser(meJid) : undefined;
  const author = getKeyAuthor(key, me);
  return author && author !== 'me' ? author : '';
}

export type PollFacts = {
  question: string;
  options: string[];
  /** `0` means every option may be selected. The client treats that as a multi-choice poll. */
  selectableCount: number;
  secret?: Uint8Array;
};

export type PollCardOption = { name: string; count: number; selected: boolean };

export type PollCard = {
  question: string;
  selectableCount: number;
  options: PollCardOption[];
};

type Creation = proto.Message.IPollCreationMessage;

function creationOf(message: proto.IMessage | null | undefined): Creation | undefined {
  const content = extractMessageContent(message);
  if (!content) return undefined;
  for (const field of CREATION_FIELDS) {
    const value = content[field];
    if (value?.options?.length || value?.name) return value;
  }
  return undefined;
}

/** A proto byte field, or the base64 string an older stored envelope kept instead. */
export function pollBytes(value: unknown): Uint8Array | undefined {
  if (value instanceof Uint8Array) return value.byteLength ? value : undefined;
  if (typeof value !== 'string' || !value) return undefined;
  const decoded = Buffer.from(value, 'base64');
  return decoded.byteLength ? decoded : undefined;
}

function secretOf(message: proto.IMessage | null | undefined): Uint8Array | undefined {
  const secret = pollBytes(message?.messageContextInfo?.messageSecret);
  return secret?.byteLength === 32 ? secret : undefined;
}

export function pollFacts(message: proto.IMessage | null | undefined): PollFacts | undefined {
  const creation = creationOf(message);
  if (!creation) return undefined;
  const options = (creation.options ?? [])
    .map(option => option.optionName?.trim() ?? '')
    .filter(Boolean);
  if (options.length === 0 && !creation.name?.trim()) return undefined;
  const count = creation.selectableOptionsCount;
  return {
    question: creation.name?.trim() ?? '',
    options,
    selectableCount: typeof count === 'number' && count > 0 ? count : 0,
    ...(secretOf(message) ? { secret: secretOf(message) } : {}),
  };
}

export function pollFactsFromRaw(raw: string | null | undefined): PollFacts | undefined {
  if (!raw) return undefined;
  try {
    const envelope = JSON.parse(raw, BufferJSON.reviver) as WAMessage;
    return pollFacts(envelope.message);
  } catch {
    return undefined;
  }
}

/** Question and option names, one line each, so a search can hit them. The list still says Poll. */
export function pollSearchText(facts: PollFacts): string {
  return [facts.question, ...facts.options].filter(Boolean).join('\n');
}

function optionHash(name: string): Uint8Array {
  return sha256(Buffer.from(name));
}

function sameHash(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  return Buffer.from(left).equals(Buffer.from(right));
}

export function optionNamesFromVote(facts: PollFacts, vote: proto.Message.IPollVoteMessage): string[] {
  const names: string[] = [];
  for (const selected of vote.selectedOptions ?? []) {
    const hash = selected instanceof Uint8Array ? selected : undefined;
    if (!hash) continue;
    const match = facts.options.find(name => sameHash(optionHash(name), hash));
    if (match && !names.includes(match)) names.push(match);
  }
  return names;
}

function voteKey(pollEncKey: Uint8Array, pollMsgId: string, pollCreatorJid: string, voterJid: string): { key: Uint8Array; aad: Uint8Array } {
  const sign = Buffer.concat([
    Buffer.from(pollMsgId),
    Buffer.from(pollCreatorJid),
    Buffer.from(voterJid),
    Buffer.from('Poll Vote'),
    new Uint8Array([1]),
  ]);
  const key0 = hmacSign(pollEncKey, new Uint8Array(32), 'sha256');
  return { key: hmacSign(sign, key0, 'sha256'), aad: Buffer.from(`${pollMsgId}\u0000${voterJid}`) };
}

/**
 * The vote relay uses the same meta tag as poll creation in this pin (`polltype` on a `meta` node).
 * Creation's token is `creation`. A vote is the other poll operation, and its token is `vote`.
 */
export const POLL_VOTE_TYPE = 'vote';

export function encryptPollVote(input: {
  optionNames: string[];
  pollEncKey: Uint8Array;
  pollMsgId: string;
  pollCreatorJid: string;
  voterJid: string;
}): { encPayload: Uint8Array; encIv: Uint8Array } {
  const { key, aad } = voteKey(input.pollEncKey, input.pollMsgId, input.pollCreatorJid, input.voterJid);
  const iv = randomBytes(12);
  const plaintext = proto.Message.PollVoteMessage.encode({
    selectedOptions: input.optionNames.map(optionHash),
  }).finish();
  return { encPayload: aesEncryptGCM(plaintext, key, iv, aad), encIv: iv };
}

/** The option names inside a vote, or undefined when the secret is missing or the ciphertext will not open. */
export function decryptPollSelection(input: {
  encPayload: Uint8Array;
  encIv: Uint8Array;
  facts: PollFacts;
  pollMsgId: string;
  pollCreatorJid: string;
  voterJid: string;
}): string[] | undefined {
  if (!input.facts.secret) return undefined;
  try {
    const vote = decryptPollVote(
      { encPayload: input.encPayload, encIv: input.encIv },
      {
        pollEncKey: input.facts.secret,
        pollMsgId: input.pollMsgId,
        pollCreatorJid: input.pollCreatorJid,
        voterJid: input.voterJid,
      },
    );
    return optionNamesFromVote(input.facts, vote);
  } catch {
    return undefined;
  }
}

export function pollCard(facts: PollFacts, votes: Array<{ actor: string; options: string[] | null }>, ownerActor = 'me'): PollCard {
  const tally = new Map(facts.options.map(name => [name, { count: 0, selected: false }]));
  for (const vote of votes) {
    for (const name of vote.options ?? []) {
      const row = tally.get(name);
      if (!row) continue;
      row.count += 1;
      if (vote.actor === ownerActor) row.selected = true;
    }
  }
  return {
    question: facts.question,
    selectableCount: facts.selectableCount,
    options: facts.options.map(name => {
      const row = tally.get(name);
      return { name, count: row?.count ?? 0, selected: row?.selected ?? false };
    }),
  };
}
