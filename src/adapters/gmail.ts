// Gmail adapter (Migration state 3): one instance per Gmail account. It owns the
// Gmail shapes — thread summaries, HTML bodies, attachments, labels — and asks
// the injected transport for every provider call. Failures are normalized here,
// through the provider-error factory, so raw provider output never travels
// further.
import { buildGmailMime } from '../gmail-mime.ts';
import { findGmailAttachment, pickGmailAttachments, pickGmailBodies } from '../gmail-body.ts';
import { latestReceivedMessage } from '../gmail-inbox.ts';
import { gmailCursorUnchanged, gmailInboxIdsToFetch, gmailSummaryCursor } from '../sync-plan.ts';
import { mailSenderName, replyRecipients } from '../recipients.ts';
import { z } from 'zod';
import { canChange } from './capability.ts';
import type { RegistryDeps } from './deps.ts';
import type {
  ActionKind, ActionOptions, ActionResult, Adapter, Capabilities,
  Conversation, GmailAccount, ListResult, MediaPayload, Message, OpenOptions, OpenResult,
  SendAuthorization, SendDraft, SendReceipt, SourceDeclaration, SyncResult,
} from './types.ts';
import type { MediaRequest } from './media.ts';

/** Largest attachment a media request will hand a frame. */
import { SAVE_LIMIT } from './media.ts';
import { savedPayload } from '../media-save.ts';

/** Largest HTML body kept on a message; larger bodies are dropped, not truncated. */
const HTML_LIMIT = 800_000;

/** The address each Gmail account sends as, and never suggests to itself. */
const SELF: Record<GmailAccount, string> = {
  'gmail-personal': 'personal@example.com',
  'gmail-business': 'work@example.com',
};

// `send` is declared because this adapter implements it; whether it may be used is the send
// gate's decision (SEND_POLICY), and every attempt lands in the audit log first.
const CAPABILITIES: Capabilities = { send: true, markRead: true, archive: true, invitations: false, media: false, attachments: true, threads: false, followsList: true };

/**
 * What a person knows each mailbox by, and how the panel paces it. A Gmail row costs one thread
 * read per thread; twenty of those per account, with the periodic refreshes in the same round,
 * measured 11–20s over the CLI and lost the panel's 15-second ceiling — so the owner saw the
 * WhatsApp page and no mail. Ten fits the panel. The ceiling, not the transport, is the reason:
 * a read is faster now, and the page size stays until someone measures it again.
 */
const SOURCE: Record<GmailAccount, SourceDeclaration> = {
  'gmail-personal': { label: 'Personal Gmail', icon: 'Mail', pollIntervalMs: 45_000, pageSize: 10 },
  'gmail-business': { label: 'Inhouse Gmail', icon: 'Mail', pollIntervalMs: 45_000, pageSize: 10 },
};

/** A cached thread is reused only if every message still carries what this adapter writes into it. */
const cachedMessage = z.object({ sender: z.string(), text: z.string(), date: z.number() }).loose();

function headers(m: any) {
  return Object.fromEntries((m?.payload?.headers ?? []).map((h: any) => [String(h.name).toLowerCase(), h.value]));
}

function plain(payload: any): string {
  if (payload?.mimeType === 'text/plain' && payload.body?.data) return Buffer.from(payload.body.data, 'base64url').toString('utf8');
  for (const part of payload?.parts ?? []) { const text = plain(part); if (text) return text; }
  return '';
}

/** Gmail's own token for the page after this one; absent when this page is the last. */
function nextCursor(page: any): { cursor?: string } {
  return typeof page?.nextPageToken === 'string' && page.nextPageToken ? { cursor: page.nextPageToken } : {};
}

export function createGmailAdapter(deps: RegistryDeps, account: GmailAccount): Adapter {
  const { cache } = deps;

  // Which implementation answers is the wiring's business, so nothing below knows whether a CLI
  // or the plugin's own HTTPS client is behind this.
  const mail = deps.gmail(account);

  /** Every transport failure becomes one scrubbed ProviderError message, at the source boundary. */
  const gmail = async <T>(call: () => Promise<T>): Promise<T> => {
    try {
      return await call();
    } catch (cause) {
      throw new Error(deps.providerError(account, 'gmail', cause).message);
    }
  };

  const stored = () => (cache.list() as Conversation[]).filter(item => item.account === account);

  async function messageHtml(messageId: string, payload: unknown): Promise<string | undefined> {
    const bodies = pickGmailBodies(payload as Parameters<typeof pickGmailBodies>[0]);
    let html = bodies.html;
    const size = bodies.htmlAttachmentSize ?? 0;
    const htmlAttachmentId = bodies.htmlAttachmentId;
    if (!html && htmlAttachmentId && (size === 0 || size <= HTML_LIMIT)) {
      try {
        const bytes = await gmail(() => mail.attachmentGet({ messageId, id: htmlAttachmentId }));
        html = Buffer.from(bytes).toString('utf8');
      } catch { html = ''; }
    }
    if (!html || html.length > HTML_LIMIT) return undefined;
    return html;
  }

  async function thread(id: string, format: 'full' | 'metadata' = 'full') {
    return gmail(() => mail.threadGet({ id, format }));
  }

  async function attachment(gmailId: string, filename: string): Promise<MediaPayload> {
    const message = await gmail(() => mail.messageGet({ id: gmailId, format: 'full' }));
    const part = findGmailAttachment(message?.payload, filename);
    if (!part) throw new Error('This attachment is no longer in the message.');
    if (part.size !== undefined && part.size > SAVE_LIMIT) throw new Error('This attachment is too large to save.');
    // The transport decodes once and hands back bytes; only an inline part still holds base64.
    const attachmentId = part.attachmentId;
    let bytes: Uint8Array | undefined = part.data ? Buffer.from(part.data, 'base64url') : undefined;
    if (!bytes?.length && attachmentId) bytes = await gmail(() => mail.attachmentGet({ messageId: gmailId, id: attachmentId }));
    if (!bytes?.length) throw new Error('This attachment could not be read.');
    return savedPayload(bytes, { mime: part.mimeType, filename: part.filename });
  }

  function row(t: any, headersOnly = false): Conversation {
    const ms: any[] = t.messages ?? [];
    const last: any = latestReceivedMessage(ms) ?? {};
    const head = headers(last);
    const recipients = [...new Set(ms.flatMap((m: any) => { const h = headers(m); return [h.to, h.cc]; }).filter(Boolean))].join(', ').slice(0, 4000);
    // A `metadata` read carries no part list, so an older row cannot name its attachments. Saying
    // "none" would be a lie, so the field is left out; only the newest page reaches the cache, and
    // the cache is what search reads, so nothing that is indexed loses an attachment name.
    const attachments = headersOnly ? undefined : [...new Set(ms.flatMap((m: any) => pickGmailAttachments(m.payload)))].slice(0, 20);
    return {
      account,
      id: String(t.id),
      title: String(head.subject || '(no subject)'),
      sender: mailSenderName(String(head.from || '')),
      recipients,
      ...(attachments ? { attachments } : {}),
      preview: String(last.snippet || ''),
      date: Number(last.internalDate || 0),
      unread: ms.some((m: any) => m.labelIds?.includes('UNREAD')),
    };
  }

  async function listThreads(limit: number, cursor?: string): Promise<{ items: Conversation[]; cursor?: string }> {
    const storedItems = stored();
    const previous = new Map(storedItems.map(item => [item.id, item]));
    // An older page is a read only. The cache holds "the newest rows as of the last full
    // refresh", so writing a second page into it would make the next refresh look like the
    // inbox lost rows — and each refresh replaces that account's entries wholesale anyway.
    if (cursor) {
      const page = await gmail(() => mail.threadsList({ labelIds: ['INBOX'], maxResults: limit, pageToken: cursor }));
      // Gmail's listing gives an id and a snippet and nothing else: the subject, sender, date and
      // read state a row shows live in the thread. So an older page costs one read per row, and
      // the two cheapening moves are both here. `metadata` is exactly what a row needs — headers,
      // labels and dates, no body and no part list — and measured 0.7s against 1.35s for `full`.
      // The reads overlap instead of running one after another, which is the other half: twenty
      // of them in sequence was a forty-second wait for a page.
      const items = await Promise.all((page.threads ?? []).map(async (entry: any) => {
        const id = String(entry.id);
        return previous.get(id) ?? row(await thread(id, 'metadata'), true);
      }));
      return { items, ...nextCursor(page) };
    }
    const profile = await gmail(() => mail.profile());
    const historyId = String(profile.historyId ?? '');
    // The listing runs even when the cached rows are still current, because it is what says
    // whether a page exists beyond this one: "show older" is offered on evidence, not guessed.
    const page = await gmail(() => mail.threadsList({ labelIds: ['INBOX'], maxResults: limit }));
    const next = nextCursor(page);
    const complete = storedItems.length && storedItems.slice(0, limit).every(item => item.sender && item.preview && item.recipients !== undefined && item.attachments !== undefined);
    if (gmailCursorUnchanged(cache.cursor(account), gmailSummaryCursor(historyId)) && complete) return { items: storedItems.slice(0, limit), ...next };
    const listed = (page.threads ?? []).map((entry: any) => ({ id: String(entry.id), historyId: String(entry.historyId ?? ''), snippet: String(entry.snippet ?? '') }));
    const changed = new Set<string>(gmailInboxIdsToFetch(cache.cursor(account), cache.revisions(account), listed));
    for (const entry of listed) {
      const known = previous.get(entry.id);
      if (known && (!known.sender || known.recipients === undefined || known.attachments === undefined)) changed.add(entry.id);
    }
    const fetched = new Map<string, Conversation>();
    for (const id of changed) fetched.set(id, row(await thread(id)));
    const items = listed.flatMap((entry: { id: string }) => {
      const found = fetched.get(entry.id) ?? previous.get(entry.id);
      return found ? [found] : [];
    });
    cache.save(account, items);
    cache.saveRevisions(account, listed.map((entry: { id: string; historyId: string; snippet: string }) => ({ id: entry.id, historyId: entry.historyId, preview: entry.snippet })));
    if (historyId) cache.setCursor(account, gmailSummaryCursor(historyId));
    return { items: items.slice(0, limit), ...next };
  }

  async function openThread(id: string): Promise<OpenResult> {
    const raw = cache.readThread(account, id);
    const parsed = raw === null ? null : cachedMessage.array().safeParse(raw);
    const cachedMessages: Message[] = parsed?.success ? parsed.data as Message[] : [];
    // A list's mailbox cursor cannot validate an independently cached conversation body.
    let t: any;
    try { t = await thread(id); }
    catch (error) {
      if (cachedMessages.length) return { messages: cachedMessages, cacheFallback: true };
      throw error;
    }
    const messages: Message[] = await Promise.all((t.messages ?? []).map(async (m: any) => {
      const h = headers(m);
      const sender = String(h.from || ''), to = String(h.to || ''), cc = String(h.cc || ''), replyTo = String(h['reply-to'] || '');
      const suggested = replyRecipients({ from: sender, to, cc, replyTo, self: SELF[account] });
      const html = await messageHtml(String(m.id), m.payload);
      const attachments = pickGmailAttachments(m.payload);
      return {
        sender, text: plain(m.payload) || String(m.snippet || ''), date: Number(m.internalDate || 0),
        ...(html ? { html } : {}),
        to, cc, replyTo, subject: String(h.subject || ''), messageId: String(h['message-id'] || ''), references: String(h.references || ''),
        suggestedTo: suggested.to, suggestedCc: suggested.cc, attachments, gmailId: String(m.id),
      };
    }));
    cache.saveThread(account, id, messages);
    return { messages };
  }

  return {
    source: SOURCE[account],
    capabilities: () => CAPABILITIES,

    async list(cursor, opts?: OpenOptions): Promise<ListResult> {
      return { ...(await listThreads(opts?.limit ?? 20, cursor)), errors: [] };
    },

    async sync(opts?: OpenOptions): Promise<SyncResult> {
      return { ...(await listThreads(opts?.limit ?? 20)), updatedAt: Date.now() };
    },

    open: (id: string, _opts?: OpenOptions) => openThread(id),

    async media(request: MediaRequest): Promise<MediaPayload> {
      if (request.kind === 'attachment') return attachment(request.id, request.filename);
      throw new Error('This source has no media to open here.');
    },

    async action(kind: ActionKind, id: string, _opts?: ActionOptions): Promise<ActionResult> {
      if (canChange(CAPABILITIES, kind)) {
        const body = kind === 'archive' ? { removeLabelIds: ['INBOX'] } : kind === 'read' ? { removeLabelIds: ['UNREAD'] } : { addLabelIds: ['UNREAD'] };
        await gmail(() => mail.threadsModify({ id, ...body }));
        return { status: kind === 'archive' ? 'Archived.' : 'Updated.' };
      }
      throw new Error('This action is not supported.');
    },

    async send(draft: SendDraft, _authorization: SendAuthorization): Promise<SendReceipt> {
      if (draft.kind !== 'gmail' || draft.account !== account) throw new Error('This draft belongs to another account.');
      try {
        const raw = await buildGmailMime({ from: SELF[account], to: draft.to, cc: draft.cc ?? '', bcc: draft.bcc ?? '', subject: draft.subject, text: draft.text, inReplyTo: draft.inReplyTo, references: draft.references, attachments: draft.attachments });
        const response = await mail.sendRaw({ raw, threadId: draft.threadId });
        if (typeof response?.id !== 'string' || !response.id) throw new Error('Send result missing message ID');
        return { status: 'Sent.' };
      } catch {
        throw new Error('Send failed or its outcome is unknown. Check Gmail Sent before trying again.');
      }
    },
  };
}
