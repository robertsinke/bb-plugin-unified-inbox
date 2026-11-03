/**
 * The verifier. Pure: no network, no store, no clock of its own — the caller passes `now`. It is the
 * only thing that may turn an envelope into "approved", and it never trusts `envelope.payload`
 * before recomputing its hash and matching the signed value.
 *
 * Adapted from Home's verifier. Inbox requires an explicit enrolled-key allowlist: an empty list
 * accepts NO keys. Signature verification establishes only possession of the matching private key,
 * not hardware origin, helper identity or human presence. Those are enrollment/issuer-policy facts.
 */
import { createPublicKey, verify as verifySignature } from "node:crypto";
import {
  ASSERTION_VERSION,
  type Assertion,
  type Envelope,
  type Payload,
  CanonicalError,
  assertionBytes,
  keyIdOf,
  payloadHash as hashOfPayload,
  sha256Hex,
  validateAssertion,
  validatePayload,
} from "./canonical.ts";

export type RefusalCode =
  | "missing_field"
  | "unsupported_version"
  | "invalid_assertion"
  | "payload_mismatch"
  | "bad_signature"
  | "unknown_key"
  | "expired";

export type Verified = {
  ok: true;
  payload: Payload;
  assertion: Assertion;
  payloadHash: string;
  keyId: string;
};

export type Refused = { ok: false; code: RefusalCode; detail: string };

export type VerifyOptions = {
  /** The delivery process's clock, in ms. Zero skew tolerance: same host, same clock. */
  now: number;
  /** Server-controlled enrolled keys. Empty means no key is authorized. */
  allowedKeyIds: readonly string[];
};

const decodeBase64 = (value: unknown, field: string): Buffer => {
  if (typeof value !== "string" || value === "") {
    throw new CanonicalError("invalid_type", `${field}: expected base64 text`);
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.length === 0) throw new CanonicalError("invalid_type", `${field}: not base64`);
  return bytes;
};

/** X9.63 point → JWK, so node:crypto can verify against a public key it never had before. */
const jwkOf = (point: Buffer): { kty: "EC"; crv: "P-256"; x: string; y: string } => {
  if (point.length !== 65 || point[0] !== 0x04) {
    throw new CanonicalError("invalid_value", "publicKey: expected an uncompressed X9.63 P-256 point");
  }
  return {
    kty: "EC",
    crv: "P-256",
    x: point.subarray(1, 33).toString("base64url"),
    y: point.subarray(33, 65).toString("base64url"),
  };
};

export function verifyApproval(envelope: unknown, options: VerifyOptions): Verified | Refused {
  if (typeof envelope !== "object" || envelope === null) {
    return { ok: false, code: "missing_field", detail: "no envelope" };
  }
  const candidate = envelope as Partial<Envelope>;
  if (candidate.v !== ASSERTION_VERSION) return { ok: false, code: "unsupported_version", detail: "unsupported envelope version" };
  if (Object.keys(candidate).some(key => !["v", "payload", "assertion", "publicKey", "signature"].includes(key))) {
    return { ok: false, code: "invalid_assertion", detail: "unknown envelope field" };
  }
  for (const field of ["payload", "assertion", "publicKey", "signature"] as const) {
    if (candidate[field] === undefined || candidate[field] === null) {
      return { ok: false, code: "missing_field", detail: `envelope.${field} is absent` };
    }
  }

  let payload: Payload;
  let assertion: Assertion;
  try {
    payload = validatePayload(candidate.payload);
    assertion = validateAssertion(candidate.assertion);
  } catch (error) {
    if (error instanceof CanonicalError) {
      const code: RefusalCode =
        error.code === "unknown_field" || error.code === "missing_field" ? "missing_field" : "invalid_assertion";
      return { ok: false, code, detail: error.message };
    }
    throw error;
  }
  if (payload.v !== 1 || assertion.v !== ASSERTION_VERSION) {
    return { ok: false, code: "unsupported_version", detail: `assertion v${assertion.v}` };
  }

  // The key id is derived, never taken on trust: an assertion naming a key it was not signed with is
  // a signature over someone else's claim.
  let point: Buffer;
  let keyId: string;
  try {
    point = decodeBase64(candidate.publicKey, "envelope.publicKey");
    keyId = keyIdOf(point);
  } catch (error) {
    if (error instanceof CanonicalError) return { ok: false, code: "bad_signature", detail: error.message };
    throw error;
  }
  if (keyId !== assertion.keyId) {
    return { ok: false, code: "bad_signature", detail: "keyId is not the hash of the supplied public key" };
  }
  const pinned = options.allowedKeyIds;
  if (!pinned.includes(keyId)) {
    return { ok: false, code: "unknown_key", detail: `key ${keyId.slice(0, 16)}… is not pinned` };
  }

  // Recompute first, compare second. Until this line passes, the payload is caller-supplied text.
  const recomputed = hashOfPayload(payload);
  if (recomputed !== assertion.payloadHash) {
    return {
      ok: false,
      code: "payload_mismatch",
      detail: `payload hashes to ${recomputed.slice(0, 16)}…, the assertion signed ${assertion.payloadHash.slice(0, 16)}…`,
    };
  }

  let signature: Buffer;
  try {
    signature = decodeBase64(candidate.signature, "envelope.signature");
  } catch (error) {
    if (error instanceof CanonicalError) return { ok: false, code: "bad_signature", detail: error.message };
    throw error;
  }

  let valid = false;
  try {
    // The helper signs sha256(assertion) with .ecdsaSignatureDigestX962SHA256, which is exactly
    // verify("sha256", assertionBytes, …) on this side. DER is node's default dsaEncoding.
    const key = createPublicKey({ key: jwkOf(point), format: "jwk" });
    valid = verifySignature("sha256", assertionBytes(assertion), key, signature);
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, code: "bad_signature", detail: "ECDSA signature does not verify" };

  // Expiry lives inside the signed bytes, so restarting the process or moving the gate's clock
  // forward cannot revive an approval. A backwards clock only extends a window a human granted.
  if (options.now > assertion.expiresAt) {
    return {
      ok: false,
      code: "expired",
      detail: `expired ${Math.round((options.now - assertion.expiresAt) / 1000)}s ago`,
    };
  }
  if (assertion.createdAt > options.now) {
    // A signature dated in the future is not "early", it is a different clock.
    return { ok: false, code: "invalid_assertion", detail: "assertion is dated in the future" };
  }

  return { ok: true, payload, assertion, payloadHash: recomputed, keyId };
}

/** The assertion digest a signer must sign, exposed so a fixture signer and the helper agree. */
export { assertionBytes, sha256Hex };
