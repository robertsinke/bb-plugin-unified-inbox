// The RPC contract: what a caller may send, what it gets back, and nothing about how
// the plugin answers it. It lives in its own module so tests can import it — the
// plugin entry point pulls in the browser and provider clients, which a unit test
// must not touch.
import { defineRpcContract } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import { ATTACHMENT_LIMIT } from './adapters/media.ts';
import { accounts, gmailAccounts } from './adapters/types.ts';
import { attachmentMediaRequestSchema, imsgMediaRequestSchema, messageMediaRequestSchema } from './adapters/media.ts';
import { capabilitiesSchema } from './adapters/capability.ts';
import { sourceDeclarationSchema } from './adapters/source.ts';

const account = z.enum(accounts);
export const item = z.object({ account, id: z.string(), title: z.string(), preview: z.string(), date: z.number(), unread: z.boolean(), sender: z.string().optional(), avatarUrl: z.string().url().max(2048).optional(), recipients: z.string().max(4000).optional(), attachments: z.array(z.string().max(255)).max(20).optional(), participants: z.array(z.string()).optional() });
const messageMedia = z.object({ messageId: z.string(), kind: z.enum(['image','sticker','video']), cached: z.boolean(), available: z.boolean(), mime: z.string().optional(), filename: z.string().optional(), size: z.number().positive().optional(), url: z.string().optional() });
const imsgAttachment = z.object({ index: z.number().int().nonnegative(), name: z.string(), available: z.boolean() });
export const message = z.object({ edited: z.boolean().optional(), replyContext: z.boolean().optional(), imsgId: z.string().optional(), imsgAttachments: z.array(imsgAttachment).optional(), sender: z.string(), text: z.string(), date: z.number(), fromMe: z.boolean().optional(), html: z.string().max(800_000).optional(), to: z.string().optional(), cc: z.string().optional(), replyTo: z.string().optional(), subject: z.string().optional(), messageId: z.string().optional(), references: z.string().optional(), suggestedTo: z.string().optional(), suggestedCc: z.string().optional(), attachments: z.array(z.string().max(255)).max(20).optional(), gmailId: z.string().max(512).optional(), media: messageMedia.optional(), link: z.string().optional(), reactions: z.array(z.object({ sender: z.string(), label: z.string() })).optional() });
const pageControl = z.object({ index: z.number().int().nonnegative(), role: z.string(), name: z.string(), tag: z.string(), x: z.number(), y: z.number(), width: z.number(), height: z.number(), focused: z.boolean() });
const recordedWrite = z.object({ method: z.string().min(3).max(7), url: z.string().min(1).max(2048), body: z.string().max(131_072), capturedAt: z.number().int().nonnegative() }).strict();
export const mailAttachment = z.object({
  name: z.string().min(1).max(255).refine(v => !/[\r\n\0]/.test(v), 'Invalid attachment name'),
  mimeType: z.string().min(1).max(255),
  size: z.number().int().min(0).max(25_000_000),
  data: z.string().max(40_000_000),
}).strict();

const timestamp = z.number().int().nonnegative().nullable();
const freshness = z.record(account, z.object({ lastAttemptAt: timestamp, lastSuccessAt: timestamp, lastError: z.string().nullable(), cacheFallback: z.boolean() }));
const threadResult = z.object({ messages: z.array(message), updatedAt: timestamp.optional(), cacheFallback: z.boolean().optional() });
const header = z.string().max(2000).refine(v => !/[\r\n\0]/.test(v), 'Invalid header');
export const rpcContract = defineRpcContract({
  // `null` is the call every existing consumer makes (the panel's poll, the CLI, the mention
  // provider) and it keeps answering exactly what it always did. `{ older: true }` asks every
  // source that has one for the page after the newest one; `{ older: true, account }` asks one
  // source, which is how the panel grows the list as each answers instead of waiting for the
  // slowest. `more` answers for the scope the call named.
  list: { input: z.object({ older: z.boolean().optional(), account: account.optional() }).strict().nullable(), output: z.object({ items: z.array(item), errors: z.array(z.string()), more: z.boolean().optional() }) },
  cached: { input: z.null(), output: z.object({ items: z.array(item), freshness: freshness.optional(), more: z.record(account, z.boolean()).optional() }) },
  freshness: { input: z.null(), output: freshness },
  search: { input: z.object({ query: z.string().max(200) }).strict(), output: z.object({ ids: z.array(z.object({ account, id: z.string(), score: z.number() })), truncated: z.boolean() }) },
  search_status: { input: z.null(), output: z.object({ size: z.number().int().nonnegative(), updatedAt: z.number().int().nonnegative().nullable(), ready: z.boolean() }) },
  cached_open: { input: z.object({ account, id: z.string().min(1).max(512) }).strict(), output: threadResult },
  clear_cache: { input: z.null(), output: z.object({ cleared: z.boolean() }) },
  // One refresh primitive for every source: the adapter for the account decides
  // whether the answer comes from its cache, a probe, or a live read.
  sync: { input: z.object({ account, limit: z.number().int().min(1).max(20).optional() }).strict(), output: z.object({ items: z.array(item), updatedAt: z.number().int().nonnegative(), reason: z.string().optional(), more: z.boolean().optional() }) },
  open: { input: z.object({ account, id: z.string().min(1).max(512) }).strict(), output: threadResult },
  // The page driver behind slice D's recording procedure: one call, one step, one control by index.
  // Not a user feature — a send control is refused unless the caller passes allow: 'send'.
  linkedin_ui: { input: z.object({
    op: z.enum(['goto', 'snapshot', 'text', 'click', 'type', 'press', 'describe']),
    path: z.string().max(512).optional(),
    role: z.string().max(32).optional(),
    index: z.number().int().min(0).max(599).optional(),
    text: z.string().max(20_000).optional(),
    control: z.string().min(1).max(120).optional(),
    key: z.enum(['Enter', 'Escape', 'Tab', 'Backspace', 'ArrowDown']).optional(),
    allow: z.literal('send').optional(),
    recipient: z.string().min(1).max(120).optional(),
    conversation: z.string().min(1).max(512).optional(),
    invitation: z.string().min(1).max(120).optional(),
    replace: z.boolean().optional(),
  }).strict(), output: z.object({ url: z.string().optional(), controls: z.array(pageControl).optional(), text: z.string().optional(), clicked: z.boolean().optional(), control: pageControl.optional(), typed: z.boolean().optional(), reason: z.string().optional(), focus: pageControl.optional(), description: z.unknown().optional(), recipients: z.array(z.string()).optional() }) },
  linkedin_record: { input: z.object({ op: z.enum(['arm', 'clear', 'dump']) }).strict(), output: z.object({ installed: z.boolean().optional(), recording: z.boolean().optional(), writes: z.array(recordedWrite).optional(), seen: z.unknown().optional() }) },
  linkedin_writes: { input: z.null(), output: z.object({ writes: z.array(recordedWrite) }) },
  linkedin_replay: { input: z.object({ write: recordedWrite, conversationId: z.string().min(1).max(512), text: z.string().max(20_000).optional(), confirm: z.boolean() }).strict(), output: z.object({ ok: z.boolean(), status: z.number().int().nonnegative() }) },
  linkedin_signin: { input: z.null(), output: z.object({ profile: z.string(), message: z.string() }) },
  // What the send gate decided, newest first: the same rows `bb unified-inbox send-audit`
  // prints, so a refused send is visible where it happened rather than only in a terminal.
  send_audit: { input: z.object({ limit: z.number().int().min(1).max(50).optional() }).strict(), output: z.object({ rows: z.array(z.object({ at: z.number(), account, conversationId: z.string(), decision: z.enum(['allowed', 'refused']),
            reason: z.string().nullable().optional(),
            // The audience the conversation id cannot name: who was blind-copied.
            bcc: z.string().nullable().optional(),
            // Null means delivered without an approval (a page-confirmed replay): the row says so.
            approvalId: z.string().nullable().optional(), payloadHash: z.string().nullable().optional(),
            assertionHash: z.string().nullable().optional(), keyId: z.string().nullable().optional(),
            authorizationModel: z.enum(['legacy_mail_allow','envelope_mail']).nullable().optional(),
            assertionTrust: z.enum(['unverified','signature_verified']).nullable().optional() })) }) },
  media: {
    input: z.discriminatedUnion('kind', [
      messageMediaRequestSchema.extend({ account }),
      imsgMediaRequestSchema.extend({ account }),
      attachmentMediaRequestSchema.extend({ account }),
    ]),
    output: z.object({ dataUrl: z.string(), mime: z.string(), filename: z.string().max(255).optional(), size: z.number().int().nonnegative().max(ATTACHMENT_LIMIT).optional(), url: z.string().optional() }),
  },
  // `allow: 'send'` is the caller's statement that this reply is a send. Without it the gate
  // refuses and records the attempt: a send is never approved by merely happening.
  action: { input: z.object({ account, id: z.string().min(1).max(512), action: z.enum(['read','unread','archive','reply','confirm','reject']), text: z.string().max(20000).optional(), allow: z.literal('send').optional() }).strict(), output: z.object({ status: z.string(), text: z.string().optional() }) },
  send_gmail: { input: z.object({ account: z.enum(gmailAccounts), to: header.min(1), cc: header.optional(), bcc: header.optional(), subject: header, text: z.string().max(100000), threadId: z.string().max(512).optional(), attachments: z.array(mailAttachment).max(20).optional(), inReplyTo: header.optional(), references: header.optional(),
    // Legacy flag remains a migration input, never a fallback from envelope refusal.
    allow: z.literal('send').optional(), envelope: z.unknown().optional(),
    draft: z.object({ draftId: z.string().min(1).max(512), revision: z.number().int().min(1), sourceVersion: z.string().max(512) }).strict().optional(),
  }).strict(), output: z.object({ status: z.string(), authorizationModel: z.enum(['legacy_mail_allow','envelope_mail']).optional(),
    warning: z.string().optional(), approvalId: z.string().optional(), state: z.literal('accepted').optional() }) },
  mail_approval_policy: { input: z.null(), output: z.object({ mode: z.enum(['prepare','compatibility','require']), allowedKeyIds: z.array(z.string()) }) },
  mail_approval_status: { input: z.object({ approvalId: z.string().min(1).max(512).optional(), keyId: z.string().regex(/^[0-9a-f]{64}$/).optional() }).strict(), output: z.object({
    mode: z.enum(['prepare','compatibility','require']), pinnedKeyCount: z.number().int().nonnegative(),
    keyPinned: z.boolean().nullable(), legacyAllowed: z.boolean(), envelopeDeliveryEnabled: z.boolean(),
    lastRefusalCode: z.string().nullable(), lastRefusalAt: z.number().nullable(), lastRefusalWasKeyMismatch: z.boolean(),
    lastRefusalAccount: z.string().nullable(), lastRefusalScope: z.literal('mail_global'),
    spend: z.object({
    approvalId: z.string(), payloadHash: z.string(), keyId: z.string(), account: z.string(),
    state: z.enum(['spent','accepted','uncertain']), spentAt: z.number(),
  }).nullable() }) },
  capabilities: { input: z.null(), output: z.record(account, capabilitiesSchema) },
  // What each source *is*, as opposed to what it can do: the name a person knows it by, its icon,
  // and the cadences the panel paces it with. One call, at start; the panel keeps no copy of its
  // own, so a renamed source is renamed everywhere the moment its adapter says so.
  sources: { input: z.null(), output: z.record(account, sourceDeclarationSchema) },
});
