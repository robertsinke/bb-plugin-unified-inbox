import assert from 'node:assert/strict';
import test from 'node:test';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { createSendGate, SEND_POLICY } from '../src/adapters/policy.ts';
import { createSendAudit } from '../src/send-audit.ts';
import { createGateway, type GatewayDriver } from '../src/gateway.ts';
import { MailApprovalError, mailPayload, type MailPolicy, type MailRequest } from '../src/mail-approval.ts';
import { assertionBytes, buildPayload, makeAssertion, payloadHash, keyIdOf, x963FromJwk, type Envelope, type Payload } from '../src/send-approval/canonical.ts';
import { rpcContract } from '../src/rpc-contract.ts';
import { harness } from './adapters/harness.ts';

const T = 1_790_000_000_000;
function signer() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const point = x963FromJwk(jwk.x!, jwk.y!);
  return { keyId: keyIdOf(point), sign(payload: Payload, createdAt = T): Envelope {
    const assertion = makeAssertion({ approvalId: randomUUID(), keyId: keyIdOf(point), createdAt, payloadHash: payloadHash(payload) });
    return { v: 1, payload, assertion, publicKey: point.toString('base64'), signature: sign('sha256', assertionBytes(assertion), privateKey).toString('base64') };
  } };
}
const owner = signer(); // Fixture software key, explicitly pinned for tests; no presence/hardware claim.
function request(): MailRequest {
  return { account: 'personal', to: 'Ada <ada@example.com>', cc: 'bob@example.com', bcc: 'quiet@example.com',
    subject: 'Test mail', text: 'PRIVATE BODY', threadId: 'thread-1', inReplyTo: '<m@example.com>', references: '<m@example.com>',
    attachments: [{ name: 'a.txt', mimeType: 'text/plain', size: 3, data: Buffer.from('abc').toString('base64') }],
    draft: { draftId: 'draft-1', revision: 1, sourceVersion: 'source-1' } };
}
function approved(mail = request(), authority = owner, createdAt = T): MailRequest {
  return { ...mail, envelope: authority.sign(mailPayload(mail, mail.draft!), createdAt) };
}
function fixture(db = new Database(':memory:')) {
  const h = harness();
  const audit = createSendAudit(db);
  const config: MailPolicy = { mode: 'compatibility', allowedKeyIds: [owner.keyId] };
  let now = T;
  const gate = createSendGate({ now: () => now, store: audit,
    mail: { db, policy: () => config, lastRefusal: audit.lastMailRefusal } });
  const driver: GatewayDriver = {
    openInLinkedInProfile: async () => {}, inspectLinkedInPage: async () => [], evaluateInLinkedInProfile: async () => null,
    pressKeyInLinkedInPage: async () => {}, readSendTarget: async () => ({ recipients: [], threadKey: '' }),
    clickNamedControl: async () => ({ clicked: false }), typeIntoNamedControl: async () => ({ typed: false }), openLinkedInSignIn: async () => '',
  };
  const gateway = createGateway({ cache: h.cache, registry: h.registry, gate, audit, driver, now: () => now,
    search: { warm() {}, search: () => [], status: () => ({ size: 0, updatedAt: null, ready: true }) } });
  return { ...h, db, audit, gate, gateway, config, time: (value: number) => { now = value; },
    count: () => (db.prepare('SELECT COUNT(*) AS n FROM inbox_mail_spend').get() as { n: number }).n,
    close: () => { h.close(); db.close(); } };
}
async function refused(f: ReturnType<typeof fixture>, input: MailRequest, code: string) {
  await assert.rejects(async () => f.gateway.send_gmail(input), (error: unknown) => error instanceof MailApprovalError && error.mailCode === code);
}

test('positive control: real gateway/gate/audit/MIME, fake provider, committed before one dispatch', async () => {
  const f = fixture();
  try {
    const input = approved();
    const id = (input.envelope as Envelope).assertion.approvalId;
    const send = f.registry.personal.send!;
    f.registry.personal.send = async (...args) => {
      assert.equal(f.db.inTransaction, false);
      assert.equal(f.count(), 1);
      assert.equal(f.audit.list()[0].decision, 'allowed');
      return send(...args);
    };
    const result = await f.gateway.send_gmail(rpcContract.send_gmail.input.parse(input));
    assert.equal(result.approvalId, id);
    assert.equal(result.state, 'accepted');
    assert.equal(f.sent.length, 1);
    assert.match(Buffer.from(f.sent[0].raw).toString(), /Subject: Test mail/);
    const row = f.audit.list()[0];
    assert.equal(row.approvalId, id);
    assert.equal(row.keyId, owner.keyId);
    assert.equal(row.assertionTrust, 'signature_verified');
    assert.equal(row.payloadHash, (input.envelope as Envelope).assertion.payloadHash);
    assert.match(row.assertionHash!, /^[0-9a-f]{64}$/);
    assert.doesNotMatch(JSON.stringify(row), /PRIVATE BODY|hardware|presence/);
    assert.equal(rpcContract.send_gmail.output.safeParse(result).success, true);
    assert.equal(rpcContract.send_audit.output.safeParse({ rows: f.audit.list() }).success, true);
  } finally { f.close(); }
});

for (const field of ['account', 'to', 'cc', 'bcc', 'subject', 'text', 'threadId', 'inReplyTo', 'references', 'attachment', 'attachmentOrder', 'draft'] as const) {
  test(`exact mail binding refuses changed ${field}`, async () => {
    const f = fixture();
    try {
      const base = request();
      base.attachments!.push({ name: 'b.txt', mimeType: 'text/plain', size: 3, data: Buffer.from('xyz').toString('base64') });
      const input = approved(base);
      if (field === 'account') input.account = 'business';
      else if (field === 'attachment') input.attachments![0].data = Buffer.from('def').toString('base64');
      else if (field === 'attachmentOrder') input.attachments!.reverse();
      else if (field === 'draft') input.draft!.revision++;
      else input[field] = field === 'to' ? 'Ada <ADA@example.com>' : 'changed@example.com';
      await refused(f, input, 'payload_mismatch');
      assert.equal(f.count(), 0);
      assert.equal(f.sent.length, 0);
    } finally { f.close(); }
  });
}

test('tampered payload, expired assertion, bad signature, unknown/empty pins: zero spend and delivery', async () => {
  for (const scenario of ['tampered', 'expired', 'signature', 'unknown', 'empty'] as const) {
    const f = fixture();
    try {
      const input = approved(request(), scenario === 'unknown' ? signer() : owner);
      const envelope = input.envelope as Envelope;
      if (scenario === 'tampered') envelope.payload.body = 'different';
      if (scenario === 'expired') f.time(T + 300_001);
      if (scenario === 'signature') envelope.signature = Buffer.alloc(72).toString('base64');
      if (scenario === 'empty') f.config.allowedKeyIds = [];
      await refused(f, input, scenario === 'tampered' ? 'payload_mismatch' : scenario === 'expired' ? 'expired' : scenario === 'signature' ? 'bad_signature' : 'unknown_key');
      assert.equal(f.count(), 0);
      assert.equal(f.sent.length, 0);
      assert.equal(f.audit.list()[0].approvalId, envelope.assertion.approvalId);
      assert.equal(f.audit.list()[0].assertionTrust, 'unverified');
    } finally { f.close(); }
  }
});

test('mixed envelope+allow, null envelope and bad envelope never become compatibility sends', async () => {
  const f = fixture();
  try {
    await refused(f, { ...approved(), allow: 'send' }, 'mixed_authorization');
    await refused(f, { ...request(), envelope: null }, 'missing_field');
    const bad = approved();
    (bad.envelope as Envelope).signature = Buffer.alloc(72).toString('base64');
    await refused(f, bad, 'bad_signature');
    assert.equal(f.count(), 0);
    assert.equal(f.sent.length, 0);
  } finally { f.close(); }
});

test('refusal uses the native RPC category and machine-readable mail code', async () => {
  const f = fixture();
  try {
    await assert.rejects(async () => f.gateway.send_gmail({ ...approved(), allow: 'send' }), (error: unknown) => {
      assert.ok(error instanceof MailApprovalError);
      assert.equal(error.code, 'forbidden');
      assert.deepEqual(error.issues, [{ path: ['envelope'], message: 'mixed_authorization' }]);
      assert.match(error.message, /^\[mail:mixed_authorization\]/);
      return true;
    });
  } finally { f.close(); }
});

test('prepare verifies but never spends; legacy works in compatibility; Require refuses legacy', async () => {
  const f = fixture();
  try {
    f.config.mode = 'prepare';
    await refused(f, approved(), 'envelope_delivery_disabled');
    assert.equal(f.count(), 0);
    f.config.mode = 'compatibility';
    const result = await f.gateway.send_gmail({ ...request(), allow: 'send' });
    assert.equal(result.authorizationModel, 'legacy_mail_allow');
    assert.match(result.status, /Legacy mail consent/, 'old clients that only display status still see migration warning');
    assert.equal(f.audit.list()[0].authorizationModel, 'legacy_mail_allow');
    assert.equal(f.sent.length, 1);
    assert.equal(f.count(), 0);
    f.config.mode = 'require';
    await refused(f, { ...request(), allow: 'send' }, 'approval_required');
    assert.equal(f.sent.length, 1);
  } finally { f.close(); }
});

test('concurrent duplicate requests across SQLite connections dispatch exactly once; replay stays spent after reload', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mail-spend-'));
  const path = join(dir, 'db.sqlite');
  const a = fixture(new Database(path));
  const b = fixture(new Database(path));
  const input = approved();
  try {
    const answers = await Promise.allSettled([a.gateway.send_gmail(input), b.gateway.send_gmail(input)]);
    assert.equal(answers.filter(answer => answer.status === 'fulfilled').length, 1);
    const failure = answers.find(answer => answer.status === 'rejected') as PromiseRejectedResult;
    assert.equal(failure.reason.mailCode, 'already_spent');
    assert.equal(a.sent.length + b.sent.length, 1);
    assert.equal(a.count(), 1);
  } finally { a.close(); b.close(); }
  const c = fixture(new Database(path));
  try {
    await refused(c, input, 'already_spent');
    assert.equal(c.sent.length, 0);
    assert.equal(c.count(), 1);
  } finally { c.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('dispatch throws AFTER commit: durable uncertain result, spent approval, no automatic retry', async () => {
  const f = fixture();
  let attempts = 0;
  try {
    f.registry.personal.send = async () => { attempts++; assert.equal(f.count(), 1); assert.equal(f.db.inTransaction, false); throw new Error('transport timeout'); };
    const input = approved();
    await refused(f, input, 'delivery_uncertain');
    const status = await f.gateway.mail_approval_status({ approvalId: (input.envelope as Envelope).assertion.approvalId });
    assert.equal(status.spend?.state, 'uncertain');
    await refused(f, input, 'already_spent');
    assert.equal(attempts, 1);
    assert.equal(f.count(), 1);
  } finally { f.close(); }
});

test('failed pre-dispatch audit rolls back spend and never dispatches', async () => {
  const f = fixture();
  try {
    f.db.exec("CREATE TRIGGER reject_allowed BEFORE INSERT ON inbox_send_audit WHEN NEW.decision = 'allowed' BEGIN SELECT RAISE(ABORT, 'fixture failure'); END");
    await refused(f, approved(), 'spend_commit_failed');
    assert.equal(f.count(), 0);
    assert.equal(f.sent.length, 0);
    assert.equal(f.audit.list()[0].decision, 'refused');
  } finally { f.close(); }
});

test('record inserts the allowed audit row then throws: both spend and allowed audit roll back', async () => {
  const f = fixture();
  let dispatched = 0;
  try {
    const gate = createSendGate({ now: () => T,
      store: { hasSpent: f.audit.hasSpent, record(row) {
        f.audit.record(row);
        if (row.decision === 'allowed') throw new Error('fixture failure after audit insert');
      } }, mail: { db: f.db, policy: () => f.config } });
    await assert.rejects(gate.mail(approved(), async () => { dispatched++; return { status: 'Sent.' }; }),
      (error: unknown) => error instanceof MailApprovalError && error.mailCode === 'spend_commit_failed');
    assert.equal(f.count(), 0);
    assert.equal(f.audit.list().filter(row => row.decision === 'allowed').length, 0);
    assert.equal(f.audit.list()[0].decision, 'refused');
    assert.equal(dispatched, 0);
  } finally { f.close(); }
});

test('verified and delivered mail is frozen before asynchronous policy resolution', async () => {
  const f = fixture();
  try {
    const input = approved();
    const pending = f.gateway.send_gmail(input);
    input.text = 'MUTATED AFTER CALL';
    input.attachments![0].data = Buffer.from('def').toString('base64');
    await pending;
    assert.equal(f.sent.length, 1);
    const raw = Buffer.from(f.sent[0].raw).toString();
    assert.match(raw, /PRIVATE BODY/);
    assert.doesNotMatch(raw, /MUTATED AFTER CALL/);
  } finally { f.close(); }
});

test('expiry is rechecked after acquiring the SQLite write lock', async () => {
  const f = fixture();
  try {
    const exec = f.db.exec.bind(f.db);
    f.db.exec = sql => {
      const value = exec(sql);
      if (sql === 'BEGIN IMMEDIATE') f.time(T + 300_001);
      return value;
    };
    await refused(f, approved(), 'expired');
    assert.equal(f.count(), 0);
    assert.equal(f.sent.length, 0);
  } finally { f.close(); }
});

test('source policy still disables signed mail before any spend', async () => {
  const f = fixture();
  const previous = SEND_POLICY.personal;
  try {
    SEND_POLICY.personal = { state: 'disabled', reason: 'fixture disabled' };
    await refused(f, approved(), 'send_disabled');
    assert.equal(f.count(), 0);
    assert.equal(f.sent.length, 0);
  } finally { SEND_POLICY.personal = previous; f.close(); }
});

test('malformed attachment encoding/size and non-mail signed routes cannot dispatch', async () => {
  const f = fixture();
  try {
    const badSize = approved();
    badSize.attachments![0].size++;
    await refused(f, badSize, 'invalid_mail');
    const badEncoding = approved();
    badEncoding.attachments![0].data += '\\n';
    await refused(f, badEncoding, 'invalid_mail');
    const wrongRoute = request();
    const payload = mailPayload(wrongRoute, wrongRoute.draft!);
    payload.route = 'action:reply';
    await refused(f, { ...wrongRoute, envelope: owner.sign(payload) }, 'payload_mismatch');
    assert.equal(f.count(), 0);
    assert.equal(f.sent.length, 0);
  } finally { f.close(); }
});

test('a signed canonical recipient set must agree with the MIME recipient parser', async () => {
  const f = fixture();
  try {
    const input = request();
    input.to = 'Group:ada@example.com;';
    const payload = buildPayload({ transport: 'gmail', route: 'send_gmail', account: input.account,
      to: input.to, subject: input.subject, body: input.text, draft: input.draft! });
    await refused(f, { ...input, envelope: owner.sign(payload) }, 'invalid_mail');
    assert.equal(f.count(), 0);
    assert.equal(f.sent.length, 0);
  } finally { f.close(); }
});

test('zero-byte attachments retain their exact empty-byte hash and can dispatch', async () => {
  const f = fixture();
  try {
    const input = request();
    input.attachments = [{ name: 'empty.txt', mimeType: 'text/plain', size: 0, data: '' }];
    await f.gateway.send_gmail(rpcContract.send_gmail.input.parse(approved(input)));
    assert.equal(f.sent.length, 1);
  } finally { f.close(); }
});

test('outcome persistence failure remains uncertain and can never dispatch the approval again', async () => {
  const f = fixture();
  try {
    f.db.exec("CREATE TRIGGER reject_outcome BEFORE UPDATE ON inbox_mail_spend BEGIN SELECT RAISE(ABORT, 'fixture outcome failure'); END");
    const input = approved();
    await assert.rejects(async () => f.gateway.send_gmail(input), (error: unknown) => {
      assert.ok(error instanceof MailApprovalError);
      assert.equal(error.mailCode, 'delivery_uncertain');
      assert.match(error.message, /message may have been delivered/);
      return true;
    });
    assert.equal(f.sent.length, 1);
    await refused(f, input, 'already_spent');
    assert.equal(f.sent.length, 1);
    assert.equal(f.count(), 1);
  } finally { f.close(); }
});

test('status is current for requested key but last refusal is global, historical and survives reload', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mail-status-'));
  const path = join(dir, 'db.sqlite');
  const f = fixture(new Database(path));
  try {
    f.config.allowedKeyIds = [];
    await refused(f, approved(), 'unknown_key');
    const before = await f.gateway.mail_approval_status({ keyId: owner.keyId });
    assert.equal(before.keyPinned, false);
    assert.equal(before.lastRefusalWasKeyMismatch, true);
    assert.equal(before.pinnedKeyCount, 0);
  } finally { f.close(); }
  const reloaded = fixture(new Database(path));
  try {
    const status = await reloaded.gateway.mail_approval_status({ keyId: owner.keyId });
    assert.equal(status.keyPinned, true);
    assert.equal(status.envelopeDeliveryEnabled, true);
    assert.equal(status.lastRefusalCode, 'unknown_key');
    assert.equal(status.lastRefusalAt, T);
    assert.equal(status.lastRefusalAccount, 'personal');
    assert.equal(status.lastRefusalScope, 'mail_global');
    assert.equal(rpcContract.mail_approval_status.output.safeParse(status).success, true);
  } finally { reloaded.close(); rmSync(dir, { recursive: true, force: true }); }
});
