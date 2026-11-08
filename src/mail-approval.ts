import { experimental_PluginRpcRefusal } from '@get-bb/plugin-sdk';
import type Database from 'better-sqlite3';
import addressparser from 'nodemailer/lib/addressparser/index.js';
import type { AuditRow } from './adapters/policy.ts';
import type { GmailDraft, SendReceipt } from './adapters/types.ts';
import { assertionBytes, buildPayload, payloadHash, sha256Hex, validateAssertion, type Payload } from './send-approval/canonical.ts';
import { verifyApproval, type RefusalCode } from './send-approval/verify.ts';

export type MailMode = 'prepare' | 'compatibility' | 'require';
export type MailPolicy = { mode: MailMode; allowedKeyIds: string[] };
export type MailParameters = Omit<GmailDraft, 'kind'>;
export type MailRequest = MailParameters & { allow?: 'send'; envelope?: unknown; draft?: Payload['draft'] };
export type MailCode = RefusalCode | 'mixed_authorization' | 'approval_required' | 'envelope_delivery_disabled'
  | 'invalid_mail' | 'spend_unavailable' | 'spend_commit_failed' | 'already_spent' | 'delivery_uncertain' | 'configuration_error' | 'send_disabled';
export class MailApprovalError extends experimental_PluginRpcRefusal {
  readonly mailCode: MailCode;
  constructor(code: MailCode) {
    super({
      code: ['already_spent', 'delivery_uncertain', 'spend_commit_failed'].includes(code) ? 'conflict' : 'forbidden',
      message: `[mail:${code}] ${code === 'delivery_uncertain' ? 'Approval spent; the message may have been delivered. Outcome is uncertain. Do not retry automatically.' : 'Mail refused; nothing dispatched by this attempt.'}`,
      issues: [{ path: ['envelope'], message: code }],
    });
    this.mailCode = code;
  }
}
export type MailSpend = {
  approvalId: string; payloadHash: string; keyId: string; account: string;
  state: 'spent' | 'accepted' | 'uncertain'; spentAt: number;
};
export type MailGateDeps = {
  db?: Database.Database;
  policy(): MailPolicy | Promise<MailPolicy>;
  now(): number;
  enabled(account: MailParameters['account']): boolean;
  /** True when this id is a mailbox the registry currently holds. */
  mailbox?(account: string): boolean;
  record(row: AuditRow): void;
  lastRefusal?(): { reason: string; at: number; account: string } | null;
  legacy(request: MailRequest, deliver: () => Promise<SendReceipt>): Promise<SendReceipt>;
};

export function parseMailKeyIds(text: string): string[] {
  const keys = text.split(/[\s,]+/).filter(Boolean);
  if (keys.length > 1000 || keys.some(key => !/^[0-9a-f]{64}$/.test(key))) throw new MailApprovalError('configuration_error');
  return [...new Set(keys)];
}

/** Exact transport fields, not the untrusted envelope's claimed content. */
export function mailPayload(mail: MailParameters, draft: Payload['draft']): Payload {
  const payload = buildPayload({
    transport: 'gmail', route: 'send_gmail', account: mail.account,
    conversation: { conversationId: mail.threadId ?? null, inReplyTo: mail.inReplyTo ?? null, references: mail.references ?? null },
    to: mail.to, cc: mail.cc ?? '', bcc: mail.bcc ?? '', subject: mail.subject, body: mail.text, draft,
    attachments: (mail.attachments ?? []).map(file => {
      // Node's base64 decoder is forgiving. Refuse non-canonical data and misleading byte sizes.
      const bytes = Buffer.from(file.data, 'base64');
      if (bytes.toString('base64') !== file.data || bytes.length !== file.size) throw new MailApprovalError('invalid_mail');
      return { name: file.name, mimeType: file.mimeType, size: bytes.length, sha256: sha256Hex(bytes) };
    }),
  });
  // The provider's MIME parser must resolve the same recipient sets as the shared canonicalizer.
  for (const field of ['to', 'cc', 'bcc'] as const) {
    const actual = [...new Set(addressparser(payload.recipients[field], { flatten: true }).map(entry => entry.address.toLowerCase()))].sort();
    if (JSON.stringify(actual) !== JSON.stringify(payload.recipients[`${field}Addresses`])) throw new MailApprovalError('invalid_mail');
  }
  return payload;
}

/** Mail-only authorization. Chat and observed LinkedIn paths do not use this ledger. */
export function createMailGate(deps: MailGateDeps) {
  const { db } = deps;
  db?.exec(`CREATE TABLE IF NOT EXISTS inbox_mail_spend (
    approval_id TEXT PRIMARY KEY, payload_hash TEXT NOT NULL, assertion_hash TEXT NOT NULL,
    key_id TEXT NOT NULL, account TEXT NOT NULL, draft_id TEXT NOT NULL, draft_revision INTEGER NOT NULL,
    source_version TEXT NOT NULL, expires_at INTEGER NOT NULL, spent_at INTEGER NOT NULL, state TEXT NOT NULL)`);
  const insert = db?.prepare('INSERT INTO inbox_mail_spend VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const outcome = db?.prepare('UPDATE inbox_mail_spend SET state = ? WHERE approval_id = ?');
  const read = db?.prepare(`SELECT approval_id AS approvalId, payload_hash AS payloadHash,
    key_id AS keyId, account, state, spent_at AS spentAt FROM inbox_mail_spend WHERE approval_id = ?`);

  async function policy(): Promise<MailPolicy> {
    const value = await deps.policy();
    if (!['prepare', 'compatibility', 'require'].includes(value.mode) || !Array.isArray(value.allowedKeyIds)
      || value.allowedKeyIds.some(key => typeof key !== 'string' || !/^[0-9a-f]{64}$/.test(key))) throw new MailApprovalError('configuration_error');
    return value;
  }
  // No argument asks about the policy alone; the panel asks this before it offers a send.
  async function status(input: { approvalId?: string; keyId?: string } | null) {
    const config = await policy();
    const last = deps.lastRefusal?.() ?? null;
    return {
      spend: (input?.approvalId ? read?.get(input.approvalId) as MailSpend | undefined : undefined) ?? null,
      mode: config.mode, pinnedKeyCount: config.allowedKeyIds.length,
      keyPinned: input?.keyId ? config.allowedKeyIds.includes(input.keyId) : null,
      legacyAllowed: config.mode !== 'require',
      envelopeDeliveryEnabled: config.mode !== 'prepare' && config.allowedKeyIds.length > 0 && !!db,
      lastRefusalCode: last?.reason ?? null, lastRefusalAt: last?.at ?? null,
      lastRefusalAccount: last?.account ?? null, lastRefusalScope: 'mail_global' as const,
      lastRefusalWasKeyMismatch: last?.reason === 'unknown_key',
    };
  }

  async function send(input: MailRequest, deliver: (mail: MailParameters) => Promise<SendReceipt>) {
    // Freeze before the first await: the verified parameters are also the delivered parameters.
    const snapshot = structuredClone(input);
    const { envelope, allow, draft, ...mail } = snapshot;
    const account = mail.account;
    const conversationId = mail.threadId ?? mail.to;
    let metadata: Partial<AuditRow> = {};
    // Presented claims in a refused row are identifiers, not evidence that the assertion was trusted.
    if ('envelope' in snapshot) {
      try {
        const assertion = validateAssertion((envelope as { assertion?: unknown } | null)?.assertion);
        metadata = { approvalId: assertion.approvalId, payloadHash: assertion.payloadHash,
          keyId: assertion.keyId, assertionHash: sha256Hex(assertionBytes(assertion)), assertionTrust: 'unverified' };
      } catch { /* malformed claims have no usable audit identity */ }
    }
    function refuse(code: MailCode): never {
      deps.record({ at: deps.now(), operation: 'send', account, conversationId, decision: 'refused',
        ...metadata, authorizationModel: 'envelope_mail', reason: code });
      throw new MailApprovalError(code);
    }
    if (deps.mailbox && !deps.mailbox(account)) return refuse('invalid_mail');
    if (!deps.enabled(account)) return refuse('send_disabled');
    let config: MailPolicy;
    try { config = await policy(); } catch { return refuse('configuration_error'); }
    if ('envelope' in snapshot && 'allow' in snapshot) return refuse('mixed_authorization');
    if (!('envelope' in snapshot)) {
      if (config.mode === 'require') return refuse('approval_required');
      const receipt = await deps.legacy(snapshot, () => deliver(mail));
      const warning = 'Legacy mail consent is not verified approval; migrate to an envelope before Require mode.';
      return { ...receipt, status: `${receipt.status} ${warning}`, authorizationModel: 'legacy_mail_allow' as const, warning };
    }
    const verified = verifyApproval(envelope, { now: deps.now(), allowedKeyIds: config.allowedKeyIds });
    if (!verified.ok) return refuse(verified.code);
    metadata = { approvalId: verified.assertion.approvalId, payloadHash: verified.payloadHash,
      keyId: verified.keyId, assertionHash: sha256Hex(assertionBytes(verified.assertion)), assertionTrust: 'signature_verified' };
    if (!draft) return refuse('payload_mismatch');
    let expectedHash: string;
    try { expectedHash = payloadHash(mailPayload(mail, draft)); }
    catch (error) { return refuse(error instanceof MailApprovalError ? error.mailCode : 'invalid_mail'); }
    if (expectedHash !== verified.payloadHash) return refuse('payload_mismatch');
    if (config.mode === 'prepare') return refuse('envelope_delivery_disabled');
    if (!db || !insert) return refuse('spend_unavailable');
    let began = false;
    try {
      db.exec('BEGIN IMMEDIATE');
      began = true;
      if (deps.now() > verified.assertion.expiresAt) throw new MailApprovalError('expired');
      insert.run(verified.assertion.approvalId, verified.payloadHash, metadata.assertionHash, verified.keyId,
        account, draft.draftId, draft.revision, draft.sourceVersion, verified.assertion.expiresAt, deps.now(), 'spent');
      // Audit and spend share the production connection and commit atomically before transport.
      deps.record({ at: deps.now(), operation: 'send', account, conversationId, decision: 'allowed',
        ...metadata, authorizationModel: 'envelope_mail' });
      db.exec('COMMIT');
      began = false;
    } catch (error) {
      if (began) { try { db.exec('ROLLBACK'); } catch { /* no dispatch after any transaction failure */ } }
      if (error instanceof MailApprovalError) return refuse(error.mailCode);
      const code = (error as { code?: string }).code;
      return refuse(code === 'SQLITE_CONSTRAINT_PRIMARYKEY' ? 'already_spent' : 'spend_commit_failed');
    }
    // No await between committed spend and invoking delivery. There is no retry or spend refund.
    try {
      const receipt = await deliver(mail);
      outcome!.run('accepted', verified.assertion.approvalId);
      return { ...receipt, authorizationModel: 'envelope_mail' as const, approvalId: verified.assertion.approvalId, state: 'accepted' as const };
    } catch {
      try { outcome!.run('uncertain', verified.assertion.approvalId); } catch { /* durable spend still forbids retry */ }
      throw new MailApprovalError('delivery_uncertain');
    }
  }
  return { send, policy, status };
}
