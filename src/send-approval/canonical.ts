/**
 * THE canonical definition of what an approval binds. This is the only place the payload schema,
 * the canonical encoder, the payload hash and the signed assertion are defined; Home, the gate and
 * the Swift helper are all tested against `helper/vectors.json`, which this module generates.
 *
 * Two artifacts, deliberately separate:
 *
 *   payload   = the message content. Hashed by whoever displays it and by whoever signs it.
 *   assertion = { approvalId, createdAt, expiresAt, keyId, payloadHash, v }. Minted at the human
 *               gesture, carried inside the signed bytes, and never derived from the payload alone.
 *
 * The approval id is minted by the authority, not by the caller: a caller-chosen id is a caller
 * choosing its own single-use key (that is the bug the inbox has today).
 *
 * Canonical form: keys sorted by UTF-16 code unit order, compact (no whitespace), integers only,
 * strings passed through unaltered (no Unicode normalisation — two different reviewed strings must
 * never hash the same), arrays in order. Numbers outside the safe-integer range and every non-integer
 * number are refused rather than rounded.
 */
import { createHash } from "node:crypto";

export const PAYLOAD_VERSION = 1 as const;
export const ASSERTION_VERSION = 1 as const;
/** Expiry is a property of the signed artifact, not of a server clock read at dispatch time. */
export const APPROVAL_TTL_MS = 5 * 60_000;
/** Under this, Home shows the approval as expiring rather than settled. */
export const EXPIRING_WITHIN_MS = 60_000;

export type Transport = "gmail" | "whatsapp" | "imessage" | "stub";
export type Route = "send_gmail" | "action:reply" | "stub";

export type Attachment = { name: string; mimeType: string; size: number; sha256: string };

export type Recipients = {
  /** What will be sent, byte for byte. */
  to: string;
  cc: string;
  bcc: string;
  /** What "the recipient set" means: lowercased, deduplicated within a field, sorted. */
  toAddresses: string[];
  ccAddresses: string[];
  bccAddresses: string[];
};

export type Conversation = {
  conversationId: string | null;
  inReplyTo: string | null;
  references: string | null;
};

export type Payload = {
  v: typeof PAYLOAD_VERSION;
  transport: Transport;
  route: Route;
  account: string;
  conversation: Conversation;
  recipients: Recipients;
  subject: string;
  body: string;
  attachments: Attachment[];
  draft: { draftId: string; revision: number; sourceVersion: string };
  /** One approval, one attempt. Present in the signed content so "at most once" is stated there. */
  delivery: { maxAttempts: 1 };
};

export type Assertion = {
  v: typeof ASSERTION_VERSION;
  approvalId: string;
  keyId: string;
  createdAt: number;
  expiresAt: number;
  payloadHash: string;
};

/** What the authority hands back and the gate verifies. `payload` is unauthenticated until the
 * verifier recomputes its hash and matches the signed value. */
export type Envelope = {
  v: typeof ASSERTION_VERSION;
  payload: Payload;
  assertion: Assertion;
  /** X9.63 uncompressed P-256 point, base64. Not secret. */
  publicKey: string;
  /** X9.62 DER ECDSA signature over sha256(canonical(assertion)). */
  signature: string;
};

export type PayloadInput = {
  transport: Transport;
  route: Route;
  account: string;
  conversation?: Partial<Conversation>;
  to: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  body: string;
  attachments?: Attachment[];
  draft: { draftId: string; revision: number; sourceVersion: string };
};

export class CanonicalError extends Error {
  readonly code:
    | "unknown_field"
    | "missing_field"
    | "invalid_type"
    | "invalid_value"
    | "unsupported_recipient_header"
    | "invalid_address";
  constructor(code: CanonicalError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

function fail(code: CanonicalError["code"], message: string): never {
  throw new CanonicalError(code, message);
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Exact key set: a field the schema does not name is a refusal, never a silently ignored key. */
function strictKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  where: string,
): void {
  for (const key of Object.keys(value)) {
    if (!required.includes(key)) fail("unknown_field", `${where}: unknown field "${key}"`);
  }
  for (const key of required) {
    if (!(key in value)) fail("missing_field", `${where}: missing field "${key}"`);
  }
}

function stringField(value: unknown, where: string): string {
  if (typeof value !== "string") fail("invalid_type", `${where}: expected a string`);
  return value;
}

function integerField(value: unknown, where: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    fail("invalid_type", `${where}: expected a safe integer`);
  }
  return value;
}

function nullableString(value: unknown, where: string): string | null {
  if (value === null) return null;
  return stringField(value, where);
}

const HEX64 = /^[0-9a-f]{64}$/;
const CONTROL = /[\r\n\0]/;

/**
 * Recipient headers are parsed by a deliberately small scanner: commas split at angle depth 0 and
 * outside quotes, `Name <addr>` or a bare addr-spec, no RFC 5322 comments. Anything it cannot parse
 * (comments, unbalanced brackets) is refused instead of guessed — a mis-parsed recipient list would
 * make the address set in the payload disagree with what the provider sends.
 */
export function parseAddressField(header: string, where: string): string[] {
  if (CONTROL.test(header)) fail("invalid_value", `${where}: header may not contain CR, LF or NUL`);
  const trimmed = header.trim();
  if (trimmed === "") return [];

  const segments: string[] = [];
  let current = "";
  let angle = 0;
  let quoted = false;
  for (const char of trimmed) {
    if (char === '"') quoted = !quoted;
    else if (!quoted && char === "<") angle += 1;
    else if (!quoted && char === ">") angle -= 1;
    if (char === "," && angle === 0 && !quoted) {
      segments.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  segments.push(current);
  if (angle !== 0 || quoted) {
    fail("unsupported_recipient_header", `${where}: unbalanced quotes or brackets`);
  }

  const addresses: string[] = [];
  for (const segment of segments) {
    const part = segment.trim();
    if (part === "") fail("unsupported_recipient_header", `${where}: empty recipient`);
    if (part.includes("(") || part.includes(")")) {
      fail("unsupported_recipient_header", `${where}: RFC 5322 comments are not supported`);
    }
    const bracket = part.lastIndexOf("<");
    let address: string;
    if (bracket >= 0) {
      const end = part.indexOf(">", bracket);
      if (end < 0) fail("unsupported_recipient_header", `${where}: unterminated angle address`);
      address = part.slice(bracket + 1, end).trim();
      const after = part.slice(end + 1).trim();
      if (after !== "") fail("unsupported_recipient_header", `${where}: trailing text after address`);
    } else {
      address = part;
    }
    if (!/^[^@\s<>]+@[^@\s<>]+$/.test(address)) {
      fail("invalid_address", `${where}: "${address}" is not an addr-spec`);
    }
    addresses.push(address.toLowerCase());
  }
  return [...new Set(addresses)].sort();
}

function attachment(value: unknown, index: number): Attachment {
  const where = `payload.attachments[${index}]`;
  if (!isPlainObject(value)) fail("invalid_type", `${where}: expected an object`);
  strictKeys(value, ["name", "mimeType", "size", "sha256"], where);
  const attachment: Attachment = {
    name: stringField(value.name, `${where}.name`),
    mimeType: stringField(value.mimeType, `${where}.mimeType`),
    size: integerField(value.size, `${where}.size`),
    sha256: stringField(value.sha256, `${where}.sha256`),
  };
  if (attachment.name === "") fail("invalid_value", `${where}.name: may not be empty`);
  if (attachment.size < 0) fail("invalid_value", `${where}.size: may not be negative`);
  if (!HEX64.test(attachment.sha256)) {
    fail("invalid_value", `${where}.sha256: expected 64 lowercase hex characters`);
  }
  return attachment;
}

/** Validate an unknown value as a payload: exact fields, exact types, no repair. */
export function validatePayload(input: unknown): Payload {
  if (!isPlainObject(input)) fail("invalid_type", "payload: expected an object");
  strictKeys(
    input,
    ["v", "transport", "route", "account", "conversation", "recipients", "subject", "body", "attachments", "draft", "delivery"],
    "payload",
  );
  if (integerField(input.v, "payload.v") !== PAYLOAD_VERSION) {
    fail("invalid_value", `payload.v: only ${PAYLOAD_VERSION} is supported`);
  }
  const transport = stringField(input.transport, "payload.transport") as Transport;
  if (!["gmail", "whatsapp", "imessage", "stub"].includes(transport)) {
    fail("invalid_value", "payload.transport: unknown transport");
  }
  const route = stringField(input.route, "payload.route") as Route;
  if (!["send_gmail", "action:reply", "stub"].includes(route)) {
    fail("invalid_value", "payload.route: unknown route");
  }
  const account = stringField(input.account, "payload.account");
  if (account === "") fail("invalid_value", "payload.account: may not be empty");

  const conversation = input.conversation;
  if (!isPlainObject(conversation)) fail("invalid_type", "payload.conversation: expected an object");
  strictKeys(conversation, ["conversationId", "inReplyTo", "references"], "payload.conversation");
  const conversationView: Conversation = {
    conversationId: nullableString(conversation.conversationId, "payload.conversation.conversationId"),
    inReplyTo: nullableString(conversation.inReplyTo, "payload.conversation.inReplyTo"),
    references: nullableString(conversation.references, "payload.conversation.references"),
  };

  const recipients = input.recipients;
  if (!isPlainObject(recipients)) fail("invalid_type", "payload.recipients: expected an object");
  strictKeys(
    recipients,
    ["to", "cc", "bcc", "toAddresses", "ccAddresses", "bccAddresses"],
    "payload.recipients",
  );
  const addressSet = (value: unknown, where: string): string[] => {
    if (!Array.isArray(value)) fail("invalid_type", `${where}: expected an array`);
    const out = value.map((entry, index) => stringField(entry, `${where}[${index}]`));
    const expected = [...new Set(out)].sort();
    if (out.length !== expected.length || out.some((entry, index) => entry !== expected[index])) {
      fail("invalid_value", `${where}: expected lowercased, deduplicated, sorted addresses`);
    }
    return out;
  };
  const recipientsView: Recipients = {
    to: stringField(recipients.to, "payload.recipients.to"),
    cc: stringField(recipients.cc, "payload.recipients.cc"),
    bcc: stringField(recipients.bcc, "payload.recipients.bcc"),
    toAddresses: addressSet(recipients.toAddresses, "payload.recipients.toAddresses"),
    ccAddresses: addressSet(recipients.ccAddresses, "payload.recipients.ccAddresses"),
    bccAddresses: addressSet(recipients.bccAddresses, "payload.recipients.bccAddresses"),
  };
  // The parsed set is not decoration: it must agree with the header strings that will be sent.
  const derived: [string, string[], string][] = [
    ["to", recipientsView.toAddresses, recipientsView.to],
    ["cc", recipientsView.ccAddresses, recipientsView.cc],
    ["bcc", recipientsView.bccAddresses, recipientsView.bcc],
  ];
  for (const [field, set, header] of derived) {
    const parsed = parseAddressField(header, `payload.recipients.${field}`);
    if (parsed.length !== set.length || parsed.some((entry, index) => entry !== set[index])) {
      fail("invalid_value", `payload.recipients.${field}Addresses: does not match the header string`);
    }
  }
  if (transport !== "stub" && recipientsView.toAddresses.length === 0) {
    fail("invalid_value", "payload.recipients.to: a message needs at least one recipient");
  }

  const subject = stringField(input.subject, "payload.subject");
  const body = stringField(input.body, "payload.body");
  if (transport === "gmail" && subject === "" && body === "") {
    fail("invalid_value", "payload: a mail needs a subject or a body");
  }

  if (!Array.isArray(input.attachments)) fail("invalid_type", "payload.attachments: expected an array");
  const attachments = input.attachments.map(attachment);

  const draft = input.draft;
  if (!isPlainObject(draft)) fail("invalid_type", "payload.draft: expected an object");
  strictKeys(draft, ["draftId", "revision", "sourceVersion"], "payload.draft");
  const draftView = {
    draftId: stringField(draft.draftId, "payload.draft.draftId"),
    revision: integerField(draft.revision, "payload.draft.revision"),
    sourceVersion: stringField(draft.sourceVersion, "payload.draft.sourceVersion"),
  };
  if (draftView.draftId === "") fail("invalid_value", "payload.draft.draftId: may not be empty");
  if (draftView.revision < 1) fail("invalid_value", "payload.draft.revision: 1-based");

  const delivery = input.delivery;
  if (!isPlainObject(delivery)) fail("invalid_type", "payload.delivery: expected an object");
  strictKeys(delivery, ["maxAttempts"], "payload.delivery");
  if (integerField(delivery.maxAttempts, "payload.delivery.maxAttempts") !== 1) {
    fail("invalid_value", "payload.delivery.maxAttempts: only 1 is supported");
  }

  return {
    v: PAYLOAD_VERSION,
    transport,
    route,
    account,
    conversation: conversationView,
    recipients: recipientsView,
    subject,
    body,
    attachments,
    draft: draftView,
    delivery: { maxAttempts: 1 },
  };
}

/** Build a payload from display fields, deriving the address sets with the one parser. */
export function buildPayload(input: PayloadInput): Payload {
  const to = input.to ?? "";
  const cc = input.cc ?? "";
  const bcc = input.bcc ?? "";
  return validatePayload({
    v: PAYLOAD_VERSION,
    transport: input.transport,
    route: input.route,
    account: input.account,
    conversation: {
      conversationId: input.conversation?.conversationId ?? null,
      inReplyTo: input.conversation?.inReplyTo ?? null,
      references: input.conversation?.references ?? null,
    },
    recipients: {
      to,
      cc,
      bcc,
      toAddresses: parseAddressField(to, "payload.recipients.to"),
      ccAddresses: parseAddressField(cc, "payload.recipients.cc"),
      bccAddresses: parseAddressField(bcc, "payload.recipients.bcc"),
    },
    subject: input.subject ?? "",
    body: input.body,
    attachments: input.attachments ?? [],
    draft: input.draft,
    delivery: { maxAttempts: 1 },
  });
}

export type JsonValue = null | boolean | string | number | JsonValue[] | { [key: string]: JsonValue };

/**
 * Canonical JSON. Deliberately narrow: the payload schema has no floats and no `undefined`, so a
 * value this encoder cannot represent is a bug or an attack, and it throws instead of guessing.
 */
export function canonicalJson(value: JsonValue): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      fail("invalid_value", `canonicalJson: ${value} is not a safe integer`);
    }
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort();
    const body = keys
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key] as JsonValue)}`)
      .join(",");
    return `{${body}}`;
  }
  return fail("invalid_type", `canonicalJson: ${typeof value} is not representable`);
}

export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The content commitment. Computed from the payload alone, on both sides. */
export function payloadHash(payload: Payload): string {
  return sha256Hex(Buffer.from(canonicalJson(payload as unknown as JsonValue), "utf8"));
}

/** keyId is a hash of the public key, so the verifier can never accept a key id it did not derive. */
export function keyIdOf(publicKey: Uint8Array): string {
  return sha256Hex(publicKey);
}

/** X9.63 uncompressed point (0x04 || X || Y) from a JWK P-256 public key. */
export function x963FromJwk(x: string, y: string): Buffer {
  const decode = (value: string) => Buffer.from(value, "base64url");
  return Buffer.concat([Buffer.from([0x04]), decode(x), decode(y)]);
}

/** The signed bytes. `signature` is not part of them; the assertion is everything else. */
export function assertionBytes(assertion: Assertion): Buffer {
  return Buffer.from(canonicalJson(assertion as unknown as JsonValue), "utf8");
}

/** What the signature actually covers: sha256(assertion bytes), signed with X9.62 DER output. */
export function assertionDigest(assertion: Assertion): Buffer {
  return createHash("sha256").update(assertionBytes(assertion)).digest();
}

export function validateAssertion(input: unknown): Assertion {
  if (!isPlainObject(input)) fail("invalid_type", "assertion: expected an object");
  strictKeys(input, ["v", "approvalId", "keyId", "createdAt", "expiresAt", "payloadHash"], "assertion");
  if (integerField(input.v, "assertion.v") !== ASSERTION_VERSION) {
    fail("invalid_value", `assertion.v: only ${ASSERTION_VERSION} is supported`);
  }
  const approvalId = stringField(input.approvalId, "assertion.approvalId");
  if (approvalId === "") fail("invalid_value", "assertion.approvalId: may not be empty");
  const keyId = stringField(input.keyId, "assertion.keyId");
  if (!HEX64.test(keyId)) fail("invalid_value", "assertion.keyId: expected 64 lowercase hex characters");
  const payloadDigest = stringField(input.payloadHash, "assertion.payloadHash");
  if (!HEX64.test(payloadDigest)) {
    fail("invalid_value", "assertion.payloadHash: expected 64 lowercase hex characters");
  }
  const createdAt = integerField(input.createdAt, "assertion.createdAt");
  const expiresAt = integerField(input.expiresAt, "assertion.expiresAt");
  if (expiresAt <= createdAt) fail("invalid_value", "assertion.expiresAt: must be after createdAt");
  if (expiresAt - createdAt > APPROVAL_TTL_MS) {
    fail("invalid_value", `assertion.expiresAt: window exceeds ${APPROVAL_TTL_MS} ms`);
  }
  return { v: ASSERTION_VERSION, approvalId, keyId, createdAt, expiresAt, payloadHash: payloadDigest };
}

/** Mint the assertion an authority signs. The clock is injected; the TTL is not negotiable here. */
export function makeAssertion(input: {
  approvalId: string;
  keyId: string;
  createdAt: number;
  payloadHash: string;
  ttlMs?: number;
}): Assertion {
  const ttlMs = input.ttlMs ?? APPROVAL_TTL_MS;
  if (ttlMs <= 0 || ttlMs > APPROVAL_TTL_MS) fail("invalid_value", `ttl must be 1..${APPROVAL_TTL_MS} ms`);
  return validateAssertion({
    v: ASSERTION_VERSION,
    approvalId: input.approvalId,
    keyId: input.keyId,
    createdAt: input.createdAt,
    expiresAt: input.createdAt + ttlMs,
    payloadHash: input.payloadHash,
  });
}

/** 8 hex characters is what Home shows; the full id is what the spend row keys on. */
export function approvalPrefix(approvalId: string): string {
  return sha256Hex(approvalId).slice(0, 8);
}
