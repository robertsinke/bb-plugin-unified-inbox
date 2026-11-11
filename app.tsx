import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { definePluginApp, experimental_Icon as Icon, experimental_useAppPanel, ThreadChat, useBbNavigate, useComposers, useRpc, useSdk } from '@get-bb/plugin-sdk/app';
import { z } from 'zod';
import type { rpcContract } from './src/rpc-contract';
import { bubbleClass, sourceClass } from './src/inbox-appearance.ts';
import { composerMode, draftForConversation } from './src/composer-mode.ts';
import { formatBytes, formatDuration } from './src/format.ts';
import { MailComposer } from './src/mail-composer.tsx';
import { assignCidSources, drawnMailImage, mailDocument, sanitizeMailMarkup } from './src/mail-html';
import type { WhatsAppMedia } from './src/whatsapp-media';
import './inbox.css';
import './chat.css';
import './layout.css';
import { siGmail, siWhatsapp } from 'simple-icons';
import { createMediaCache } from './src/media-cache';
import { isInvitationId } from './src/linkedin-inbox';
import { migrateDraftAccountIds } from './src/inbox-drafts';
import { attentionTitle, attentionWords, type AttentionVerdict } from './src/attention-label';
import { startInboxHeartbeat } from './src/inbox-heartbeat';
import { createInboxSession, type InboxItem, type InboxSession, type InboxSessionDeps, type MailDraft } from './src/inbox-session';
import { InboxErrors, errorLine } from './src/inbox-errors.tsx';
import { ItemMenu, filterAccountOrder, filterActions, menuTrigger } from './src/inbox-menu.tsx';
import { AccountSettings } from './src/account-settings.tsx';
import { sourceLabel } from './src/source-label.ts';
import type { SourceMap } from './src/adapters/types';
import { expandEmailScrollRegions } from './src/mail-scroll';
import { MENTION_PROVIDER, mentionId, threadComposer } from './src/inbox-mention';
import { installInboxMentionOpenListener, subscribeInboxMentionOpen, takeInboxMentionOpen, type InboxMentionOpen } from './src/inbox-mention-open';
import { browserTabId, focusedBrowserId, messageParts, panelStateFocusedOn, panelStateKey, tabsAfterLink } from './src/message-links';
import { REACTION_SET } from './src/reaction-set.ts';
import { canAnswerInvitation, canArchive, canMarkRead, canPollVote, canQuoteReply, canReact, canSend, hasThread } from './src/ui-capabilities';
import { isLegacyGmailAccount, isMailboxAddress, type Account, type Message as InboxMessage } from './src/adapters/types';

/*
 * The row, thread and draft shapes belong to the session: the panel renders what
 * it publishes and never keeps a second copy of them.
 */
type Item = InboxItem;
type Message = InboxMessage;

/**
 * The panel mounts twice — the nav panel and the tab slot — and both must show the
 * same inbox with the same timers, so the session is created once and shared.
 */
let shared: InboxSession | null = null;
function draftStorage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | undefined {
  try {
    migrateDraftAccountIds(window.localStorage);
    return window.localStorage;
  } catch { return undefined; }
}
function getInboxSession(rpc: InboxSessionDeps['rpc']): InboxSession {
  shared ??= createInboxSession({ rpc, storage: draftStorage(), now: () => Date.now() });
  return shared;
}
/** Names BB Settings and this plugin. There is no navigation from a thread tab to that page. */
const SETTINGS_COPY = 'Open BB Settings for Unified Inbox to connect an account.';
const WHATSAPP_SETTINGS_COPY = 'Open BB Settings for Unified Inbox to connect WhatsApp.';

function WhatsAppStart({ unpaired, onSent }: { unpaired: boolean; onSent: () => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const [phone, setPhone] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const digits = phone.replace(/\D/g, '');
  if (unpaired) return <p>{WHATSAPP_SETTINGS_COPY}</p>;
  return <form className="ui-whatsapp-start" onSubmit={event => {
    event.preventDefault();
    const body = text.trim();
    if (digits.length < 7 || digits.length > 15 || !body || busy) return;
    setBusy(true);
    setError(null);
    void rpc.call('whatsapp_resolve', { phone }).then(async ({ jid }) => {
      await rpc.call('action', { account: 'whatsapp', id: jid, action: 'reply', text: body, allow: 'send' });
      onSent();
    }).catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : 'Nothing was sent.');
    }).finally(() => setBusy(false));
  }}>
    <label>Phone number<input className="ui-whatsapp-phone" value={phone} onChange={event => setPhone(event.target.value)} inputMode="tel" autoComplete="tel" placeholder="Country code and number" /></label>
    <label>Message<textarea className="ui-whatsapp-text" value={text} onChange={event => setText(event.target.value)} /></label>
    <button type="submit" disabled={busy || digits.length < 7 || digits.length > 15 || !text.trim()}>Send</button>
    {error ? <p role="alert">{error}</p> : null}
  </form>;
}
function emptyInboxCopy(query: string, filter: string, errorCount: number): string {
  if (query.trim()) return 'No conversations match this search.';
  if (filter === 'unread') return 'No unread messages in this view.';
  if (filter !== 'all' || errorCount > 0) return 'No conversations in this view.';
  return SETTINGS_COPY;
}
/* Presentation and mail protocol: the sources whose messages render as documents and reply through the mail draft form. */
const isMail = (account: string) => isLegacyGmailAccount(account) || isMailboxAddress(account);
const linkedinPath = 'M20.45 20.45h-3.56v-5.57c0-1.33-.02-3.04-1.85-3.04-1.85 0-2.13 1.45-2.13 2.94v5.67H9.35V9h3.41v1.56h.05c.48-.9 1.63-1.85 3.36-1.85 3.6 0 4.27 2.37 4.27 5.45v6.29zM5.34 7.43a2.06 2.06 0 1 1 0-4.13 2.06 2.06 0 0 1 0 4.13zM7.12 20.45H3.55V9h3.57v11.45zM22.22 0H1.77C.79 0 0 .77 0 1.72v20.55C0 23.22.79 24 1.77 24h20.45c.98 0 1.78-.78 1.78-1.73V1.72C24 .77 23.2 0 22.22 0z'
const imessagePath = 'M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z'
function AppIcon({account}:{account:Account}) {
  const isMessages = account === 'imessage';
  const path = isMessages ? imessagePath : account === 'linkedin' ? linkedinPath : account === 'whatsapp' ? siWhatsapp.path : siGmail.path;
  return <span className="ui-source-icon" aria-hidden="true">
    <svg viewBox="0 0 24 24" width="15" height="15" fill={isMessages?'none':'currentColor'} stroke={isMessages?'currentColor':'none'} strokeWidth={isMessages?2:undefined} strokeLinecap={isMessages?'round':undefined} strokeLinejoin={isMessages?'round':undefined}><path d={path}/></svg>
  </span>;
}
function initialsFor(name:string) {
  const words = name.replace(/[^\p{L}\p{N} ]/gu, ' ').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  return (words.length === 1 ? words[0].slice(0, 2) : words[0][0] + words[1][0]).toUpperCase();
}
function avatarHue(name:string) {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + (char.codePointAt(0) || 0)) % 360;
  return hash;
}
function avatarFace(name:string) {
  return `color-mix(in srgb, hsl(${avatarHue(name)} 55% 45%) 18%, transparent)`;
}
function firstLetter(name:string) {
  return (Array.from(name.trim())[0] || '?').toUpperCase();
}
function ContactAvatar({name,account,participants=[],avatarUrl}:{name:string;account:Account;participants?:string[];avatarUrl?:string}) {
  const [imageFailed,setImageFailed]=useState(false);
  useEffect(()=>setImageFailed(false),[avatarUrl]);
  const photo=!!avatarUrl&&!imageFailed;
  // A stored picture is the face. A dead link falls back to initials, never to the participant mosaic.
  const mosaic = account === 'whatsapp' && participants.length >= 2 && !avatarUrl;
  return <span className={`ui-avatar ${sourceClass(account)}${mosaic?' ui-avatar-group':''}`} aria-hidden="true">
    <span className="ui-avatar-face" style={mosaic?undefined:{background:avatarFace(name)}}>
      {photo ? <img className="ui-avatar-photo" src={avatarUrl} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={()=>setImageFailed(true)}/> : mosaic ? participants.slice(0,4).map((person,index)=><span key={`${person}-${index}`} className="ui-avatar-cell" style={{background:avatarFace(person)}}>{firstLetter(person)}</span>) : initialsFor(name)}
    </span>
    <AppIcon account={account}/>
  </span>;
}
function date(value:number) { if (!value) return ''; const d=new Date(value); const now=new Date(); const sameDay=d.getFullYear()===now.getFullYear()&&d.getMonth()===now.getMonth()&&d.getDate()===now.getDate(); return sameDay?d.toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'}):d.toLocaleDateString(undefined,{month:'short',day:'numeric'}); }
function safeMailDocument(html: string) {
  const stripped = sanitizeMailMarkup(html);
  if (typeof DOMParser === 'undefined') return mailDocument(stripped);
  const doc = new DOMParser().parseFromString(stripped, 'text/html');
  doc.querySelectorAll('script,iframe,object,embed,form,link,meta,base,noscript').forEach(node => node.remove());
  doc.querySelectorAll('*').forEach(el => {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      const value = attr.value.trim().toLowerCase();
      if (name.startsWith('on') || ((name === 'href' || name === 'src' || name === 'action') && (value.startsWith('javascript:') || (value.startsWith('data:') && !value.startsWith('data:image/'))))) el.removeAttribute(attr.name);
    }
  });
  return mailDocument(doc.body.innerHTML);
}
function MailFrame({ html, images, onOpenLink }: { html: string; images?: Readonly<Record<string, string>>; onOpenLink: (url: string) => void }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const resizeObserver = useRef<ResizeObserver|null>(null);
  const openRef = useRef(onOpenLink);
  const imagesRef = useRef(images);
  openRef.current = onOpenLink;
  imagesRef.current = images;
  useEffect(() => {
    const doc = ref.current?.contentDocument;
    if (doc) assignCidSources(doc, images ?? {});
  }, [images]);
  useEffect(()=>()=>resizeObserver.current?.disconnect(),[]);
  return <iframe ref={ref} className="ui-mail-frame" title="Email" scrolling="no" sandbox="allow-same-origin allow-popups" referrerPolicy="no-referrer" srcDoc={safeMailDocument(html)} onLoad={() => {
    const frame = ref.current;
    const doc = frame?.contentDocument;
    if (!frame || !doc) return;
    resizeObserver.current?.disconnect();
    const resize = () => {
      const roots = [doc.documentElement, doc.body];
      for (const root of roots) {
        root.style.setProperty('overflow', 'visible', 'important');
        root.style.setProperty('height', 'auto', 'important');
        root.style.setProperty('max-height', 'none', 'important');
      }
      const view = doc.defaultView;
      if (view) expandEmailScrollRegions(Array.from(doc.body.querySelectorAll<HTMLElement>('*')), element => {
        const style = view.getComputedStyle(element);
        return { overflow: style.overflow, overflowY: style.overflowY };
      });
      const body = doc.body;
      const root = doc.documentElement;
      frame.style.height = `${Math.max(body.scrollHeight, body.offsetHeight, root.scrollHeight, root.offsetHeight, 80)}px`;
    };
    resize();
    assignCidSources(doc, imagesRef.current ?? {});
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver.current = new ResizeObserver(resize);
      resizeObserver.current.observe(doc.body);
      resizeObserver.current.observe(doc.documentElement);
    }
    for (const image of Array.from(doc.images)) {
      if (!image.complete) {
        image.addEventListener('load', resize, { once: true });
        image.addEventListener('error', resize, { once: true });
      }
    }
    doc.addEventListener('click', event => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest('a');
      const href = anchor?.getAttribute('href') ?? '';
      if (!/^https?:/i.test(href)) return;
      event.preventDefault();
      openRef.current(href);
    });
  }} />;
}

function MailView({ account, message, onOpenLink }: { account: string; message: Message; onOpenLink: (url: string) => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const [images, setImages] = useState<Record<string, string>>({});
  const inlineKey = (message.inline ?? []).map(part => `${part.contentId}\n${part.filename}`).join('\n');
  const inlineRef = useRef(message.inline);
  inlineRef.current = message.inline;
  useEffect(() => {
    const parts = inlineRef.current ?? [];
    if (!message.gmailId || parts.length === 0) return;
    let alive = true;
    void Promise.all(parts.map(async part => {
      try {
        const result = await rpc.call('media', { account, kind: 'attachment', id: message.gmailId!, filename: part.filename });
        const drawn = drawnMailImage(result.dataUrl);
        return drawn ? [part.contentId, drawn] as const : null;
      } catch {
        return null;
      }
    })).then(rows => {
      if (!alive) return;
      const next: Record<string, string> = {};
      for (const row of rows) if (row) next[row[0]] = row[1];
      setImages(next);
    });
    return () => { alive = false; };
  }, [account, inlineKey, message.gmailId, rpc]);
  return <MailFrame html={message.html ?? ''} images={images} onOpenLink={onOpenLink} />;
}
const mediaCache = createMediaCache();
function useMediaSource(media: WhatsAppMedia) {
  const rpc = useRpc<typeof rpcContract>();
  const [src, setSrc] = useState(() => media.kind === 'video' ? '' : mediaCache.get(media.messageId) ?? '');
  const [state, setState] = useState<'idle'|'loading'|'error'>('idle');
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    if (src || state === 'loading') return;
    setState('loading'); setError('');
    try {
      const result = await rpc.call('media', { account: 'whatsapp', kind: 'message', id: media.messageId });
      if (!result.dataUrl) throw new Error('This file is in your Downloads folder.');
      if (media.kind !== 'video') mediaCache.set(media.messageId, result.dataUrl);
      setSrc(result.dataUrl);
      setState('idle');
    } catch (cause) {
      setState('error');
      setError(cause instanceof Error ? cause.message : 'Could not load this media.');
    }
  }, [media.messageId, rpc, src, state]);
  return { src, state, error, load };
}
/** Hand a served file to the browser: the bytes stay out of the page, and the name is the sender's. */
function saveDownload(dataUrl: string, filename: string) {
  const link = document.createElement('a');
  link.href = dataUrl;
  link.download = filename;
  link.rel = 'noopener';
  document.body.append(link);
  link.click();
  link.remove();
}
const MAIL_IMAGE_NAME = /\.(png|jpe?g|gif|webp)$/i;

function AttachmentChips({ account, gmailId, names }: { account: string; gmailId?: string; names?: string[] }) {
  if (!names || names.length === 0) return null;
  return <div className="ui-attachments" aria-label="Attachments">
    {names.map(name => <MailFile key={name} account={account} gmailId={gmailId} name={name} />)}
  </div>;
}

function MailFile({ account, gmailId, name }: { account: string; gmailId?: string; name: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  const [src, setSrc] = useState('');
  useEffect(() => {
    if (!gmailId || !MAIL_IMAGE_NAME.test(name)) return;
    let alive = true;
    void rpc.call('media', { account, kind: 'attachment', id: gmailId, filename: name }).then(result => {
      if (!alive) return;
      if (result.savedPath) { setSaved(`${result.filename ?? name} is in your Downloads folder`); return; }
      const drawn = drawnMailImage(result.dataUrl);
      if (drawn) setSrc(drawn);
    }).catch((cause: unknown) => {
      if (alive) setError(cause instanceof Error ? cause.message : 'Could not open this attachment.');
    });
    return () => { alive = false; };
  }, [account, gmailId, name, rpc]);
  async function download() {
    if (busy || !gmailId) return;
    setBusy(true); setError('');
    try {
      const result = await rpc.call('media', { account, kind: 'attachment', id: gmailId, filename: name });
      if (result.savedPath) { setSaved(`${result.filename ?? name} is in your Downloads folder`); return; }
      const drawn = drawnMailImage(result.dataUrl);
      if (drawn) setSrc(drawn);
      if (result.dataUrl) saveDownload(result.dataUrl, result.filename ?? name);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not open this attachment.');
    } finally { setBusy(false); }
  }
  return <>
    {src ? <img className="ui-mail-image" alt="" src={src} /> : null}
    <button type="button" className="ui-attachment" disabled={busy || !gmailId} aria-busy={busy} title={gmailId ? `Download ${name}` : 'Reopen this conversation to download'} onClick={() => void download()}>
      <Icon name="Paperclip" aria-hidden="true"/><span>{busy ? 'Opening…' : name}</span>
    </button>
    {saved ? <p className="ui-media-note" role="status">{saved}</p> : null}
    {error ? <p className="ui-attachment-error" role="alert">{error}</p> : null}
  </>;
}
/**
 * A document in a thread: a chip named after the file, saved on one click under the same ceiling as
 * a mail attachment. Expired media is a line, not a control — the bytes are gone and no retry helps.
 */
function WhatsAppDocument({ media }: { media: WhatsAppMedia }) {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<'idle'|'loading'|'error'>('idle');
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  const name = media.filename || 'Document';
  if (!media.available) return <p className="ui-media-note">{name} is no longer available from WhatsApp.</p>;
  async function save() {
    if (state === 'loading') return;
    setState('loading'); setError(''); setSaved('');
    try {
      const result = await rpc.call('media', { account: 'whatsapp', kind: 'message', id: media.messageId });
      // A file too large for a data URL is already on disk; saying so beats downloading it twice.
      if (result.savedPath) setSaved(`${result.filename ?? name} is in your Downloads folder`);
      else saveDownload(result.dataUrl ?? '', result.filename ?? name);
      setState('idle');
    } catch (cause) {
      setState('error');
      setError(cause instanceof Error ? cause.message : 'Could not open this file.');
    }
  }
  return <div className="ui-attachments" aria-label="Document">
    <button type="button" className="ui-attachment" disabled={state === 'loading'} aria-busy={state === 'loading'} title={`Download ${name}`} onClick={() => void save()}>
      <Icon name="Paperclip" aria-hidden="true"/><span>{state === 'loading' ? 'Opening…' : name}</span>{media.size ? <span className="ui-attachment-size">{formatBytes(media.size)}</span> : null}
    </button>
    {saved && <p className="ui-media-note" role="status">{saved}</p>}
    {error && <p className="ui-attachment-error" role="alert">{error}</p>}
  </div>;
}
function WhatsAppImage({ media }: { media: WhatsAppMedia }) {
  const holder = useRef<HTMLDivElement>(null);
  const { src, state, error, load } = useMediaSource(media);
  useEffect(() => {
    if (src || state !== 'idle' || !media.available) return;
    const node = holder.current;
    if (!node) return;
    if (typeof IntersectionObserver === 'undefined') { void load(); return; }
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { observer.disconnect(); void load(); }
    }, { rootMargin: '160px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, [src, state, media.available, load]);
  if (src) return <div className="ui-bubble-media" ref={holder}><img className={`ui-bubble-image${media.kind === 'sticker' ? ' ui-bubble-sticker' : ''}`} src={src} alt={media.filename || (media.kind === 'sticker' ? 'Sticker' : 'Photo')} loading="lazy" /></div>;
  if (!media.available) return <p className="ui-media-note">This {media.kind === 'sticker' ? 'sticker' : 'photo'} is no longer available.</p>;
  return <div className={`ui-bubble-media ui-media-prompt${media.kind === 'sticker' ? ' ui-media-sticker-prompt' : ''}`} ref={holder}>{state === 'error' ? <><button type="button" className="ui-text-button" onClick={() => void load()}>Retry photo</button><span role="status">{error}</span></> : <span className="ui-media-note">{state === 'loading' ? 'Loading photo…' : 'Photo'}</span>}</div>;
}
function WhatsAppVideo({ media }: { media: WhatsAppMedia }) {
  const { src, state, error, load } = useMediaSource(media);
  if (src) return <video className="ui-bubble-video" src={src} controls autoPlay playsInline />;
  if (!media.available) return <p className="ui-media-note">This video is no longer available.</p>;
  return <button type="button" className="ui-video-tile" disabled={state === 'loading'} onClick={() => void load()} aria-label="Play video">
    <span className="ui-video-play" aria-hidden="true"><Icon name="Play" /></span>
    <span className="ui-video-label">{state === 'loading' ? 'Loading video…' : `Play video${media.size ? ` · ${formatBytes(media.size)}` : ''}`}</span>
    {state === 'error' && <span className="ui-video-error" role="status">{error}</span>}
  </button>;
}
/**
 * A voice note or an audio file in a thread: the same bounded whole-file fetch a picture gets, drawn as
 * a player instead of a frame. `preload="none"` and no autoplay — a thread of voice notes must not start
 * talking when it opens. The length is the envelope's own `seconds`, so the player is labelled before a
 * byte is decoded; a note recorded in WhatsApp is named for what it is, a forwarded audio file for its
 * type and size. Expired media is a line, not a control — the bytes are gone and no retry helps.
 */
function WhatsAppAudio({ media }: { media: WhatsAppMedia }) {
  const holder = useRef<HTMLDivElement>(null);
  const { src, state, error, load } = useMediaSource(media);
  useEffect(() => {
    if (src || state !== 'idle' || !media.available) return;
    const node = holder.current;
    if (!node) return;
    if (typeof IntersectionObserver === 'undefined') { void load(); return; }
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { observer.disconnect(); void load(); }
    }, { rootMargin: '160px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, [src, state, media.available, load]);
  const voice = media.voice === true;
  const name = voice ? 'Voice message' : 'Audio';
  const label = [name, media.seconds ? formatDuration(media.seconds) : '', voice || !media.size ? '' : formatBytes(media.size)].filter(Boolean).join(' · ');
  if (!media.available) return <p className="ui-media-note">This {voice ? 'voice message' : 'audio'} is no longer available from WhatsApp.</p>;
  if (src) return <div className="ui-bubble-media" ref={holder}><audio className="ui-bubble-audio" src={src} controls preload="none" aria-label={label} /><span className="ui-media-note">{label}</span></div>;
  return <div className="ui-bubble-media ui-media-prompt ui-audio-prompt" ref={holder}>{state === 'error' ? <><button type="button" className="ui-text-button" onClick={() => void load()}>Retry audio</button><span role="status">{error}</span></> : <span className="ui-media-note">{state === 'loading' ? 'Loading audio…' : label}</span>}</div>;
}
/**
 * The mail draft is the bottom composer, the same slot a chat reply uses: the addresses, the
 * subject and the body are one form, and reply / reply all / forward / new all open it here.
 */
/** What the open conversation can contribute to a draft: the files of its newest message that has any. */
function threadAttachments(messages: InboxMessage[], account: string): { account: string; gmailId: string; names: string[] } | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.gmailId && message.attachments && message.attachments.length > 0) {
      return { account, gmailId: message.gmailId, names: message.attachments };
    }
  }
  return undefined;
}

/**
 * The panel's half of the mail composer: the media reader, the refusals and the confirmations live
 * here, so the form itself stays a form that a test can render.
 */
type PanelAsk = { title: string; confirm: string; run: () => void };

/** The send, discard, and archive questions. One card, in the panel, for each. */
function AskCard({ ask, onCancel }: { ask: PanelAsk; onCancel: () => void }) {
  const titleId = useId();
  const confirmButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    confirmButton.current?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ask.title, onCancel]);
  return <div className="ui-send-ask" role="dialog" aria-labelledby={titleId}>
    <p id={titleId}>{ask.title}</p>
    <div className="ui-send-ask-actions">
      <button type="button" className="ui-send-ask-cancel" onClick={onCancel}>Cancel</button>
      <button type="button" className="ui-send-ask-send" ref={confirmButton} onClick={() => { onCancel(); ask.run(); }}>{ask.confirm}</button>
    </div>
  </div>;
}

function MailDraftComposer({ mail, busy, mailStatus, session, fromThread, sources, onAsk }: {
  mail: MailDraft;
  busy: boolean;
  mailStatus: string;
  session: InboxSession;
  sources: SourceMap | null;
  fromThread?: { account: string; gmailId: string; names: string[] };
  onAsk: (ask: PanelAsk) => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [taking, setTaking] = useState('');
  const [error, setError] = useState('');

  /** A file already on the thread travels through `media`: the same call that reads it in the message. */
  async function take(name: string): Promise<void> {
    if (!fromThread || taking) return;
    setTaking(name);
    setError('');
    try {
      const result = await rpc.call('media', { account: fromThread.account, kind: 'attachment', id: fromThread.gmailId, filename: name });
      // A file over the inline ceiling was written to Downloads: a draft cannot carry it, so say so rather
      // than send an empty attachment.
      if (!result.dataUrl) throw new Error('That file is in your Downloads folder; a draft cannot carry it.');
      const data = result.dataUrl.replace(/^data:[^,]*,/, '');
      const mimeType = result.dataUrl.slice(5, result.dataUrl.indexOf(';')) || 'application/octet-stream';
      const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
      session.attach({ name: result.filename ?? name, mimeType, size: Math.floor((data.length * 3) / 4) - padding, data });
    } catch {
      setError(`${name} could not be read from the conversation.`);
    } finally {
      setTaking('');
    }
  }

  const accountLabel = sourceLabel(sources, mail.account);
  return <MailComposer
    mail={mail}
    accountLabel={accountLabel}
    busy={busy}
    status={error || mailStatus}
    sendIcon={<Icon name="ArrowUp" aria-hidden="true" />}
    fromThread={fromThread ? { names: fromThread.names, taking, onTake: name => void take(name) } : undefined}
    onField={patch => session.setMail(patch)}
    onAttach={file => { session.attach(file); }}
    onDetach={index => session.detach(index)}
    onDiscard={() => {
      if (!mail.text.trim() && mail.attachments.length === 0 && !mail.to.trim()) session.discardMail();
      else onAsk({ title: 'Discard this draft?', confirm: 'Discard', run: () => session.discardMail() });
    }}
    onSend={() => onAsk({ title: `Send from ${accountLabel} to ${mail.to}?`, confirm: 'Send', run: () => void session.sendMail() })}
  />;
}
function MessageText({ text, onOpenLink }: { text: string; onOpenLink: (url: string) => void }) {
  return <>{messageParts(text).map((part, index) => part.kind === 'link'
    ? <a key={index} href={part.value} onClick={event => { if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); onOpenLink(part.value); }}>{part.value}</a>
    : <span key={index}>{part.value}</span>)}</>;
}
function MessagesAttachment({ chatId, messageId, attachment }: { chatId: string; messageId: string; attachment: {index:number;name:string;available:boolean} }) {
  const rpc = useRpc<typeof rpcContract>();
  const [src, setSrc] = useState('');
  const [state, setState] = useState<'idle'|'loading'|'error'>('idle');
  async function load() {
    setState('loading');
    try { const result = await rpc.call('media', { account: 'imessage', kind: 'imsg', chatId, messageId, index: attachment.index }); if (!result.dataUrl) throw new Error('no bytes'); setSrc(result.dataUrl); setState('idle'); }
    catch { setState('error'); }
  }
  if (src) return <div className="ui-bubble-media"><img className="ui-bubble-image" src={src} alt={attachment.name} /></div>;
  if (!attachment.available) return <p className="ui-media-note">{attachment.name} — attachment unavailable or unsupported.</p>;
  return <div className="ui-bubble-media ui-media-prompt"><button type="button" className="ui-text-button" disabled={state==='loading'} onClick={()=>void load()}>{state==='loading'?'Loading image…':state==='error'?'Retry image':`Show ${attachment.name}`}</button>{state==='error'&&<span role="status">Could not load this attachment.</span>}</div>;
}
/** One chip per emoji. Senders stay on the chip so a repeat from the same person still reads as one reaction. */
function reactionChips(reactions: NonNullable<Message['reactions']>): { label: string; senders: string[] }[] {
  const chips: { label: string; senders: string[] }[] = [];
  for (const reaction of reactions) {
    const label = reaction.label.trim();
    if (!label) continue;
    const existing = chips.find(chip => chip.label === label);
    const sender = reaction.sender.trim();
    if (existing) { if (sender) existing.senders.push(sender); continue; }
    chips.push({ label, senders: sender ? [sender] : [] });
  }
  return chips;
}

/** The sender text a from-me row already carries. Empty when the thread has none, so a tap cannot guess a removal. */
function ownerLabel(messages: Message[]): string {
  for (const message of messages) {
    if (!message.fromMe) continue;
    const label = message.sender.trim();
    if (label) return label;
  }
  return '';
}
function PollChoices({ poll, disabled, onChoose }: { poll: NonNullable<Message['poll']>; disabled: boolean; onChoose: (names: string[]) => void }) {
  function toggle(name: string) {
    const selected = poll.options.filter(option => option.selected).map(option => option.name);
    const cap = poll.selectableCount === 0 ? poll.options.length : poll.selectableCount;
    if (cap <= 1) {
      onChoose(selected.length === 1 && selected[0] === name ? [] : [name]);
      return;
    }
    if (selected.includes(name)) {
      onChoose(selected.filter(option => option !== name));
      return;
    }
    if (selected.length >= cap) return;
    onChoose([...selected, name]);
  }
  const total = poll.options.reduce((sum, option) => sum + option.count, 0);
  return <div className="ui-poll">{poll.question ? <div className="ui-poll-question">{poll.question}</div> : null}<div className="ui-poll-options" role="group" aria-label={poll.question || 'Poll'}>{poll.options.map(option => <button key={option.name} type="button" className="ui-poll-option" aria-pressed={option.selected} disabled={disabled} onClick={() => toggle(option.name)}><span className="ui-poll-bar" style={{ width: `${total ? (option.count / total) * 100 : 0}%` }} /><span className="ui-poll-name">{option.name}</span><span className="ui-poll-count">{option.count}</span></button>)}</div></div>;
}

/** A shared post: the post's words and picture, and a click that opens the post. */
function ShareCard({ message: m, onOpenLink }: { message: Message; onOpenLink: (url: string) => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const share = m.share;
  const link = m.link?.trim() ?? '';
  const title = share?.title.trim() ?? '';
  const author = share?.author?.trim() ?? '';
  const [src, setSrc] = useState('');
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const messageId = m.messageId?.trim() ?? '';
    if (!share?.hasImage || !messageId) return;
    let alive = true;
    void rpc.call('media', { account: 'linkedin', kind: 'message', id: messageId, index: 0 }).then(result => {
      if (!alive) return;
      if (result.dataUrl) setSrc(result.dataUrl);
      else setFailed(true);
    }).catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [m.messageId, rpc, share?.hasImage]);
  if (!title && !author && !share?.hasImage) {
    if (!link) return null;
    return <button type="button" className="ui-text-button" onClick={() => onOpenLink(link)}>Open shared post</button>;
  }
  return <button type="button" className="ui-share" aria-label={title || author ? undefined : 'Open shared post'} onClick={() => { if (link) onOpenLink(link); }}>
    {src ? <img src={src} alt="" /> : null}
    {author ? <span className="ui-share-author">{author}</span> : null}
    {title ? <span className="ui-share-text">{title}</span> : null}
    {share?.hasImage && !src && failed ? <span className="ui-media-note">This picture could not be loaded.</span> : null}
  </button>;
}

function ChatBubble({ message: m, group, onOpenLink, imsgChatId, account, selfLabel, canReact: reactionsOn, canQuoteReply: quotesOn, canVote: votesOn, busy, onReact, onReply, onVote }: { message: Message; group: boolean; onOpenLink: (url: string) => void; imsgChatId?: string; account: Account; selfLabel: string; canReact: boolean; canQuoteReply: boolean; canVote: boolean; busy: boolean; onReact: (messageId: string, emoji: string, remove: boolean) => void; onReply: (messageId: string) => void; onVote: (messageId: string, options: string[]) => void }) {
  const text = m.text.trim();
  const hasText = Boolean(text) && (!m.media || text !== `[${m.media.kind}]`);
  const inlineSender = group && !m.fromMe && Boolean(m.sender) && hasText;
  const quoteText = m.quote?.text?.trim() ?? '';
  const quoteSender = m.quote?.sender?.trim() ?? '';
  const messageId = m.messageId?.trim() ?? '';
  const chips = m.reactions?.length ? reactionChips(m.reactions) : [];
  const mine = (emoji: string) => Boolean(selfLabel) && (m.reactions ?? []).some(reaction => reaction.label === emoji && reaction.sender === selfLabel);
  const frame = useRef<HTMLElement>(null);
  const [open, setOpen] = useState(false);
  const actions = (reactionsOn || quotesOn) && Boolean(messageId);
  function close() { setOpen(false); }
  return <article ref={frame} className={bubbleClass(account)} onMouseEnter={actions ? () => setOpen(true) : undefined} onMouseLeave={actions ? close : undefined}>
    <span className="ui-sr">{m.fromMe ? 'You' : m.sender || 'WhatsApp'}</span>
    {!inlineSender && !m.fromMe && m.sender && <div className="ui-bubble-sender">{m.sender}</div>}
    {quoteText ? <blockquote className="ui-quote">{quoteSender ? <span className="ui-quote-sender">{quoteSender}</span> : null}<span className="ui-quote-text">{quoteText}</span></blockquote> : m.replyContext ? <p className="ui-quote ui-quote-marker">Reply to an earlier message</p> : null}
    {m.media?.kind === 'video' ? <WhatsAppVideo media={m.media} /> : m.media?.kind === 'document' ? <WhatsAppDocument media={m.media} /> : m.media?.kind === 'audio' ? <WhatsAppAudio media={m.media} /> : m.media ? <WhatsAppImage media={m.media} /> : null}
    {imsgChatId && m.imsgId && m.imsgAttachments?.map(attachment=><MessagesAttachment key={`${m.imsgId}:${attachment.index}`} chatId={imsgChatId} messageId={m.imsgId!} attachment={attachment}/>)}
    {m.forwarded ? <span className="ui-media-note">Forwarded</span> : null}
    {m.poll ? <PollChoices poll={m.poll} disabled={!votesOn || busy || !messageId} onChoose={names => onVote(messageId, names)} /> : null}
    {hasText && <div className="ui-bubble-text">{inlineSender && <strong className="ui-bubble-sender-inline">{m.sender}: </strong>}<MessageText text={m.text} onOpenLink={onOpenLink} /></div>}
    {(m.share || m.link) && !m.media ? <ShareCard message={m} onOpenLink={onOpenLink} /> : null}
    {m.edited && <span className="ui-media-note">Edited</span>}
    {m.date > 0 && <time className="ui-bubble-time">{new Date(m.date).toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'})}</time>}
    {chips.length ? <div className="ui-reaction-pills" aria-label="Reactions">{chips.map(chip => <span key={chip.label} className="ui-reaction-pill" title={chip.senders.join(', ')}>{chip.label}{chip.senders.length > 1 ? <span className="ui-reaction-count">{chip.senders.length}</span> : null}</span>)}</div> : null}
    {actions ? <div className={`ui-bubble-actions${open ? ' is-open' : ''}`}>{reactionsOn ? <div className="ui-reaction-set">{REACTION_SET.map(item => <button key={item.label} type="button" className="ui-reaction-choice" aria-label={item.label} aria-pressed={mine(item.emoji)} disabled={busy} onClick={event => { close(); event.currentTarget.blur(); onReact(messageId, item.emoji, mine(item.emoji)); }}>{item.emoji}</button>)}</div> : null}{quotesOn ? <button type="button" className="ui-reply-choice" onClick={event => { close(); event.currentTarget.blur(); onReply(messageId); }}>Reply</button> : null}</div> : null}
  </article>;
}
function openTaggedConversation(session: InboxSession, target: InboxMentionOpen) {
  const snap = session.snapshot();
  const row = [...snap.items, ...(snap.hits ?? [])].find(item => item.account === target.account && item.id === target.id);
  void session.open(row ?? {
    account: target.account,
    id: target.id,
    title: target.label.trim() || 'Untitled conversation',
    preview: '',
    date: Date.now(),
    unread: false,
  });
}

function ProfileName({ name, className, href, onOpen }: { name: string; className: string; href?: string; onOpen: () => void }) {
  if (!href) return <span className={className}>{name}</span>;
  const label = `Open ${name}'s public profile`;
  return <button type="button" className={`${className} ui-profile-link`} aria-label={label} title={label} onClick={event => { event.preventDefault(); onOpen(); }}>{name}</button>;
}

function Inbox({ threadId }: { threadId: string | null }) {
  const sdk = useSdk();
  const navigate = useBbNavigate();
  const panel = experimental_useAppPanel();
  const rpc=useRpc<typeof rpcContract>();
  const composers=useComposers();
  const session=getInboxSession(rpc);
  useEffect(() => {
    const open = (target: InboxMentionOpen) => {
      panel.openTab({ tab: { id: 'inbox', context: { kind: 'thread' }, availability: 'fixed' } });
      openTaggedConversation(session, target);
    };
    const stop = subscribeInboxMentionOpen(open);
    const waiting = takeInboxMentionOpen();
    if (waiting) open(waiting);
    return stop;
  }, [panel, session]);
  // State and time live in the session; the panel renders its snapshot.
  const state=useSyncExternalStore(session.subscribe,session.snapshot);
  const {items,errors,capabilities,sources,selected,messages,status,text,replyMessageId,busy,opening,filter,query,hits,refreshedAt,refreshingInbox,hasOlder,loadingOlder,mail,mailStatus,audit,auditOpen}=state;
  // One status read so a list that already has rows can say where to pair. It is not a poll, and it never pairs or closes a socket.
  const [whatsappUnpaired,setWhatsappUnpaired]=useState(false);
  const rpcRef=useRef(rpc);
  rpcRef.current=rpc;
  useEffect(()=>{
    let alive=true;
    void rpcRef.current.call('whatsapp_pairing', null).then(answer=>{
      if(alive&&answer?.state==='unpaired') setWhatsappUnpaired(true);
    }).catch(()=>{ /* a missed status read is not a source error */ });
    return()=>{ alive=false; };
  },[]);
  /* Which account picker is open is the one thing only the panel needs to know. */
  const [compose,setCompose]=useState(false);
  const [ask,setAsk]=useState<PanelAsk|null>(null);
  const cancelAsk=useCallback(()=>setAsk(null),[]);
  const [mailFocus,setMailFocus]=useState(0);
  const threadScroll=useRef<HTMLDivElement>(null); const pinnedBottom=useRef(true); const activeThread=useRef('');
  const listScroll=useRef<HTMLDivElement>(null); const olderKey=useRef('');
  // The one heartbeat. `tick` runs every due list refresh, thread watch, search
  // debounce and draft write. When this panel goes away, a draft still inside
  // its debounce is written here. The beat itself lives in `startInboxHeartbeat`.
  useEffect(()=>{
    session.start();
    const stop=startInboxHeartbeat(session, window);
    return()=>{stop();session.flush();};
  },[session]);
  useLayoutEffect(()=>{
    const scroller=threadScroll.current;
    if(!scroller||!selected){if(!selected)activeThread.current='';return;}
    const key=`${selected.account}:${selected.id}`;
    if(activeThread.current!==key){activeThread.current=key;pinnedBottom.current=true;}
    if(pinnedBottom.current)scroller.scrollTop=scroller.scrollHeight;
  },[selected?.account,selected?.id,messages]);
  useEffect(()=>{
    const scroller=threadScroll.current;
    if(!scroller||typeof ResizeObserver==='undefined')return;
    const observer=new ResizeObserver(()=>{if(!pinnedBottom.current)return;requestAnimationFrame(()=>{if(pinnedBottom.current)scroller.scrollTop=scroller.scrollHeight;});});
    for(const child of Array.from(scroller.children))observer.observe(child);
    return()=>observer.disconnect();
  },[selected?.account,selected?.id,messages,opening]);
  async function openLink(url: string) {
    let href = '';
    try { const parsed = new URL(url); if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return; href = parsed.toString(); } catch { return; }
    if (!threadId) { navigate.openUrl(href); return; }
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const current = await sdk.threads.tabs.get({ threadId });
        const browserId = browserTabId(crypto.randomUUID());
        const tabs = tabsAfterLink(current.tabs, href, browserId);
        try {
          const saved = await sdk.threads.tabs.update({ threadId, expectedRevision: current.revision, tabs });
          const activeId = focusedBrowserId(saved.tabs, href, browserId);
          const key = panelStateKey(threadId);
          const previous = localStorage.getItem(key);
          const next = JSON.stringify(panelStateFocusedOn(previous, activeId, href, Date.now()));
          localStorage.setItem(key, next);
          window.dispatchEvent(new StorageEvent('storage', { key, oldValue: previous, newValue: next, storageArea: localStorage, url: window.location.href }));
          break;
        } catch (error) { if (attempt === 1) throw error; }
      }
      navigate.toThread(threadId);
    } catch (error) { session.notify(error instanceof Error ? error.message : 'Could not open that link in the browser.'); }
  }
  function tag(item: Item) {
    const target = threadComposer(composers, threadId);
    if (!target) { session.notify('Open a thread beside the inbox to tag this conversation.'); return; }
    try {
      target.insert({ provider: MENTION_PROVIDER, id: mentionId(item.account, item.id), label: item.title || item.preview || 'Inbox conversation' }, { at: 'end', block: true });
      target.focus();
      requestAnimationFrame(() => target.focus());
    } catch (error) { session.notify(error instanceof Error ? error.message : 'Could not tag this conversation.'); }
  }
  const latestRefresh=Math.max(0,...Object.values(refreshedAt).filter((value): value is number => typeof value==='number'));
  const refreshTitle=latestRefresh?`Last refresh ${new Date(latestRefresh).toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})}; LinkedIn reads only from an already-open BB Browser tab`:'Refresh inbox; LinkedIn reads only from an already-open BB Browser tab';
  /* A search shows what it matched: a hit is a row, so it is drawn even when this list never loaded
     it. The filter is the owner's, so it still narrows both. */
  const matches=(i:Item)=>filter==='all'||(filter==='unread'?i.unread:filter==='yes'||filter==='no'?i.needsAttention===filter:i.account===filter);
  const shown=(hits??items).filter(matches);
  const listedKey=shown.filter(item=>item.listedOnly).map(item=>`${item.account}\0${item.id}`).join('\n');
  useEffect(()=>{
    const root=listScroll.current;
    if(!root||hits!==null||!listedKey) return;
    const nodes=[...root.querySelectorAll<HTMLElement>('[data-listed-only="true"]')];
    if(!nodes.length||typeof IntersectionObserver==='undefined') return;
    const seen=new Set<string>();
    const report=()=>{
      session.showListed(nodes.flatMap(node=>{
        const account=node.dataset.rowAccount as Account|undefined;
        const id=node.dataset.rowId;
        if(!account||!id||!seen.has(`${account}\0${id}`)) return [];
        return [{account,id}];
      }));
    };
    const observer=new IntersectionObserver(entries=>{
      for(const entry of entries){
        const node=entry.target as HTMLElement;
        const account=node.dataset.rowAccount;
        const id=node.dataset.rowId;
        if(!account||!id) continue;
        const key=`${account}\0${id}`;
        if(entry.isIntersecting) seen.add(key);
        else seen.delete(key);
      }
      report();
    },{root,rootMargin:'160px'});
    for(const node of nodes) observer.observe(node);
    return()=>observer.disconnect();
  },[listedKey,hits,session]);
  function maybeOlder() {
    const el=listScroll.current;
    if(!el||hits!==null||!hasOlder||loadingOlder) return;
    if(el.scrollHeight-el.scrollTop-el.clientHeight>320) return;
    const key=`${filter}:${items.length}`;
    if(olderKey.current===key) return;
    olderKey.current=key;
    void session.more();
  }
  useEffect(()=>{ maybeOlder(); },[hasOlder,loadingOlder,items.length,hits,filter,shown.length]);
  /* The header is one control now: the filter is a group inside its menu, so the trigger is what
     says the list is narrowed, and it says it in the name as well as in the dot. */
  const trigger=menuTrigger(sources,filter,errors.length?`Some messages couldn't load: ${errors.map(error=>errorLine(error,sources)).join(' ')}`:'');
  // LinkedIn's messages are messages too, so it takes the composer and (in slice G) the bubble layout; Gmail stays a document.
  /* A source that declares `threads` reads as a bubble thread; everything else opens as a document. */
  const chat=!!selected&&hasThread(capabilities,selected.account);
  const threaded=chat;
  const sendable=!!selected&&canSend(capabilities,selected.account);
  const reactionsOn=!!selected&&canReact(capabilities,selected.account);
  const votesOn=!!selected&&canPollVote(capabilities,selected.account);
  const quotesOn=!!selected&&canQuoteReply(capabilities,selected.account);
  const mine=ownerLabel(messages);
  const aimed=replyMessageId?messages.find(message=>message.messageId===replyMessageId):undefined;
  const composer=composerMode({selected:!!selected,draft:!!mail,draftForThisThread:draftForConversation(mail?.threadId,selected?.id),threaded:chat});
  return <div
    className={`ui-inbox ${selected?'ui-inbox-detail':''}`}
    /* A file dropped anywhere in the panel would otherwise be opened by the browser and the app is
       gone; only the composer turns a drop into an attachment. */
    onDragOver={event => event.preventDefault()}
    onDrop={event => event.preventDefault()}
  >
    

    {selected ? <section className="ui-detail"><header className="ui-conversation-header"><button className="ui-icon-button" onClick={()=>{setAsk(null);session.back();}} aria-label="Back to inbox" title="Back to inbox"><Icon name="ArrowLeft" aria-hidden="true"/></button><ContactAvatar name={selected.account==='whatsapp'||selected.account==='imessage'?selected.title:(selected.sender||selected.title)} account={selected.account} participants={selected.participants} avatarUrl={selected.avatarUrl}/><div className="ui-conversation-title"><h3><ProfileName name={selected.title} className="ui-conversation-name" href={selected.account==='linkedin'&&(!selected.sender||selected.title===selected.sender)?selected.profileUrl:undefined} onOpen={()=>void session.openProfile(selected)}/>{selected.account==='linkedin'&&isInvitationId(selected.id)&&(canAnswerInvitation(capabilities,selected.account)?<InvitationChip item={selected} busy={busy} onAnswer={(item,action)=>void session.answer(item,action)}/>:<span className="ui-chip">Invitation</span>)}{selected.muted&&<span className="ui-mute-mark">Mute</span>}{selected.needsAttention&&<AttentionChip verdict={selected.needsAttention} dismissed={selected.attentionDismissed} onClear={()=>void session.clearAttention(selected)} onRestore={()=>void session.restoreAttention(selected)}/>}</h3>{selected.account!=='whatsapp'&&selected.sender&&<span className="ui-conversation-line">{selected.account==='linkedin'&&selected.profileUrl&&selected.title!==selected.sender?<ProfileName name={selected.sender} className="ui-conversation-meta" href={selected.profileUrl} onOpen={()=>void session.openProfile(selected)}/>:<span className="ui-conversation-meta">{selected.sender}</span>}</span>}</div><div className="ui-conversation-actions"><ItemMenu label={selected.title||'this conversation'} actions={[
          ...(isMail(selected.account)?[
            { label: 'Reply', run: () => { session.startMail('reply', selected.account); setMailFocus(n => n + 1); }, title: 'Reply to this conversation', disabled: opening&&!messages.length },
            { label: 'Reply all', run: () => { session.startMail('replyAll', selected.account); setMailFocus(n => n + 1); }, title: 'Reply to everyone on this thread', disabled: opening&&!messages.length },
            { label: 'Forward', run: () => { session.startMail('forward', selected.account); setMailFocus(n => n + 1); }, title: 'Forward this conversation', disabled: opening&&!messages.length },
          ]:[]),
          { label: 'Add to chat', run: () => tag(selected) },
          ...(isConversationRow(selected)&&canMarkRead(capabilities,selected.account)?[{ label: selected.unread?'Mark read':'Mark unread', run: () => void session.mark(selected, selected.unread?'read':'unread') }]:[]),
          { label: selected.muted ? 'Unmute' : 'Mute', run: () => void (selected.muted ? session.unmute(selected) : session.mute(selected)) },
          ...(canArchive(capabilities,selected.account)?[{ label: 'Archive', run: () => setAsk({ title: 'Archive this Gmail conversation?', confirm: 'Archive', run: () => void session.mark(selected,'archive') }) }]:[]),
        ]}/></div></header><div className="ui-thread-scroll" ref={threadScroll} tabIndex={0} aria-label="Conversation messages" onScroll={event=>{const el=event.currentTarget;pinnedBottom.current=el.scrollHeight-el.scrollTop-el.clientHeight<48;}}>
      {opening?<p className="ui-empty" role="status">Loading conversation…</p>:chat?<div className="ui-chat" aria-label={`${sourceLabel(sources,selected.account)} conversation`}>{messages.length===0?<p className="ui-empty">No messages in this conversation.</p>:messages.map((m,i)=>{const day=m.date?new Date(m.date).toLocaleDateString(undefined,{year:'numeric',month:'long',day:'numeric'}):'';const previous=i>0&&messages[i-1].date?new Date(messages[i-1].date).toLocaleDateString(undefined,{year:'numeric',month:'long',day:'numeric'}):'';return <div key={m.imsgId ?? m.media?.messageId ?? i}>{day&&day!==previous&&<div className="ui-chat-day">{day}</div>}<div className={`ui-chat-row ${m.fromMe?'ui-chat-outgoing':'ui-chat-incoming'}`}><ChatBubble account={selected.account} message={m} group={selected.account==='imessage'||selected.id.endsWith('@g.us')} imsgChatId={selected.account==='imessage'?selected.id:undefined} selfLabel={mine} canReact={reactionsOn} canQuoteReply={quotesOn} canVote={votesOn} busy={busy} onReact={(messageId,emoji,remove)=>{void session.react(messageId,emoji,remove);}} onReply={messageId=>session.aimReply(messageId)} onVote={(messageId,options)=>{void session.vote(messageId,options);}} onOpenLink={url=>{void openLink(url);}}/></div></div>;})}</div>:messages.map((m,i)=><article className="ui-message" key={i}><div className="ui-message-head"><strong>{m.sender||'Unknown sender'}</strong><time>{date(m.date)}</time></div>{isMail(selected.account)&&<AttachmentChips account={selected.account} gmailId={m.gmailId} names={m.attachments}/>}{m.html?<MailView account={selected.account} message={m} onOpenLink={url=>{void openLink(url);}}/>:<div className="ui-message-body"><MessageText text={m.text} onOpenLink={url=>{void openLink(url);}}/></div>}{!chat&&(m.media||m.link)?<MessageAttachment media={m.media} link={m.link} onShow={messageId=>rpc.call('media',{account:selected.account,kind:'message',id:messageId,index:0})} onOpenLink={url=>{void openLink(url);}}/>:null}</article>)}
      </div>
      {ask?<AskCard ask={ask} onCancel={cancelAsk}/>:null}{composer==='mail'&&mail?<MailDraftComposer key={mailFocus} mail={mail} busy={busy} mailStatus={mailStatus} session={session} sources={sources} onAsk={setAsk} fromThread={threadAttachments(messages, selected.account)}/>:composer==='chat'?<form className="ui-chat-composer" onSubmit={event=>{event.preventDefault(); pinnedBottom.current=true; void session.submit();}}>{replyMessageId?<div className="ui-composer-quote"><div className="ui-quote-body">{aimed?.sender?.trim()?<span className="ui-quote-sender">{aimed.sender.trim()}</span>:null}{aimed?.sender?.trim()?' ':null}<span className="ui-quote-text">{aimed?.text?.trim()||'Reply to an earlier message'}</span></div><button type="button" className="ui-text-button" onClick={()=>session.clearReply()}>Clear</button></div>:null}<div className="ui-promptbox">{<textarea id="ui-reply-text" value={text} aria-label={`${sourceLabel(sources,selected.account)} reply`} onChange={e=>session.setDraft(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault(); pinnedBottom.current=true; void session.submit();}}} rows={2} placeholder={sendable?'Write a reply…':'Write a draft…'}/>}{sendable?<button type="submit" className="ui-prompt-send" disabled={busy||!text.trim()} aria-label="Send"><Icon name="ArrowUp" aria-hidden="true"/></button>:null}</div>{sendable?null:<p className="ui-notice">Kept as a draft on this machine; this source cannot send from here.</p>}</form>:null}
      {status&&<p role="status" className="ui-notice">{status}</p>}
    </section>:(compose||composer==='compose')?<section className="ui-compose-view">{compose?<div className="ui-compose-menu"><strong>Choose an account</strong><div className="ui-actions">{filterAccountOrder(sources).filter(isMail).map(account => <button key={account} onClick={()=>{session.startMail('new', account);setCompose(false);setMailFocus(n=>n+1);}}>{sourceLabel(sources, account)}</button>)}</div><WhatsAppStart unpaired={whatsappUnpaired} onSent={() => setCompose(false)} /></div>:mail?<>{ask?<AskCard ask={ask} onCancel={cancelAsk}/>:null}<MailDraftComposer key={mailFocus} mail={mail} busy={busy} mailStatus={mailStatus} session={session} sources={sources} onAsk={setAsk}/></>:null}</section>:<><div className="ui-list" ref={listScroll} onScroll={()=>maybeOlder()}><header className="ui-mail-bar"><span className="ui-search-wrap"><input className="ui-search" value={query} onChange={event=>session.setQuery(event.target.value)} placeholder="Search" aria-label="Search inbox" />{query!==''&&<button type="button" className="ui-search-clear" onClick={()=>session.setQuery('')} aria-label="Clear the search" title="Clear search"><Icon name="CircleX" aria-hidden="true"/></button>}</span><ItemMenu label={trigger.label} marker={trigger.marker} group={{heading:'Filter',actions:filterActions({filter,onFilter:next=>session.setFilter(next),sources,sourceIcon:account=><AppIcon account={account}/>,attention:items.some(item=>item.needsAttention)})}} actions={[
          { label: 'New', run: () => setCompose(!compose) },
          {
            label: auditOpen ? 'Back to inbox' : 'Send log',
            run: () => (auditOpen ? session.hideAudit() : void session.showAudit()),
            title: 'What the send gate decided; a refusal means nothing was sent',
          },
          { label: 'Refresh', run: () => void session.refresh(sources ? Object.keys(sources) : undefined), title: refreshTitle },
        ]}/></header>{auditOpen?null:<>{whatsappUnpaired&&shown.length>0?<p className="ui-settings-hint">{WHATSAPP_SETTINGS_COPY}</p>:null}<InboxErrors errors={errors} sources={sources}/></>}{auditOpen?(<>{audit.length===0?<p className="ui-empty">No send attempts recorded yet.</p>:audit.map(entry=><div className="ui-row ui-send-row" key={`${entry.at}-${entry.conversationId}-${entry.decision}`}><div className="ui-send-row-main"><div className="ui-send-row-head"><time>{new Date(entry.at).toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})}</time><span className={`ui-send-row-decision ${entry.decision==='refused'?'is-refused':'is-allowed'}`}>{entry.decision==='refused'?'Refused':'Sent'}</span><span className="ui-send-row-account">{sourceLabel(sources,entry.account)}</span></div><div className="ui-send-row-reason">{entry.reason??entry.conversationId}</div></div></div>)}</>):shown.length===0?<p className="ui-empty">{emptyInboxCopy(query, filter, errors.length)}</p>:shown.map(i=><div className={`ui-row ${i.unread?'is-unread':''}`} key={`${i.account}:${i.id}`} {...(i.listedOnly?{'data-listed-only':'true','data-row-account':i.account,'data-row-id':i.id}:{})}><div className="ui-row-open"><button type="button" className="ui-row-open-hit" onClick={()=>void session.open(i)} aria-label={`Open ${i.title||i.preview||'conversation'}`}/><ContactAvatar name={i.account==='whatsapp'||i.account==='imessage'?i.title:(i.sender||'Unknown sender')} account={i.account} participants={i.participants} avatarUrl={i.avatarUrl}/><span className="ui-sr">{sourceLabel(sources,i.account)}</span><div className="ui-row-copy"><div className="ui-row-top"><strong className="ui-row-name">{i.account==='whatsapp'||i.account==='imessage'?i.title:(i.sender||'Unknown sender')}</strong></div><time className="ui-row-time" title={new Date(i.date).toLocaleString()}>{date(i.date)}</time><p className="ui-row-body">{(i.sentSnippet||i.preview)||'No preview available'}</p><span className="ui-row-status">{i.unread&&<span className="ui-unread-dot" title="Unread"><span className="ui-sr">Unread</span></span>}{i.muted&&<span className="ui-mute-mark">Mute</span>}</span><div className="ui-row-foot"><span className="ui-row-pills">{i.needsAttention&&<AttentionChip verdict={i.needsAttention} dismissed={i.attentionDismissed} onClear={()=>void session.clearAttention(i)} onRestore={()=>void session.restoreAttention(i)}/>}{i.account==='linkedin'&&isInvitationId(i.id)&&(canAnswerInvitation(capabilities,i.account)?<InvitationChip item={i} busy={busy} onAnswer={(item,action)=>void session.answer(item,action)}/>:<span className="ui-chip">Invitation</span>)}</span></div><span className="ui-row-menu"><ItemMenu label={i.title||i.preview||'this conversation'} actions={[
      { label: 'Add to chat', run: () => tag(i) },
      ...(isConversationRow(i)&&canMarkRead(capabilities,i.account)?[{ label: i.unread?'Mark read':'Mark unread', run: () => void session.mark(i, i.unread?'read':'unread') }]:[]),
      { label: i.muted ? 'Unmute' : 'Mute', run: () => void (i.muted ? session.unmute(i) : session.mute(i)) },
    ]}/></span></div></div></div>)}{loadingOlder&&hits===null&&<p className="ui-older" role="status">Loading older…</p>}</div></>}
  </div>;
}
/**
 * The pending-invitation chip. Hovering it — or tabbing to it — swaps the label for a split pair of
 * icons drawn over the same pill, so the answer occupies exactly the space the chip already held and
 * the row never shifts under the cursor.
 */
/**
 * LinkedIn carries two kinds of row, and only one is a conversation: an invitation has no read
 * state to change and no thread to open, so the inbox stops offering controls that can only fail.
 */

function isConversationRow(item: Item): boolean {
  return !(item.account === 'linkedin' && isInvitationId(item.id));
}

function AttentionChip({ verdict, dismissed, onClear, onRestore }: { verdict: AttentionVerdict; dismissed?: boolean; onClear: () => void; onRestore: () => void }) {
  const [armed, setArmed] = useState(false);
  const wait = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (wait.current) clearTimeout(wait.current); }, []);
  const word = attentionWords(verdict);
  function press(run: () => void) {
    if (wait.current) { clearTimeout(wait.current); wait.current = null; setArmed(false); return; }
    setArmed(true);
    wait.current = setTimeout(() => { wait.current = null; setArmed(false); run(); }, 700);
  }
  if (verdict === 'no' && dismissed) {
    return <button type="button" className="ui-chip ui-chip-clear" data-attention="no" title={armed ? 'Click again to cancel' : 'Click to mark as needed'} aria-label={armed ? 'Cancel' : 'Mark as needed'} onClick={event => { event.stopPropagation(); event.preventDefault(); press(onRestore); }}>{word}</button>;
  }
  if (verdict !== 'yes') return <span className="ui-chip" data-attention={verdict} title={attentionTitle(verdict)}>{word}</span>;
  return <button type="button" className={`ui-chip ui-chip-clear${armed ? ' is-marked' : ''}`} data-attention="yes" title={armed ? 'Click again to cancel' : 'Click to mark as none'} aria-label={armed ? 'Cancel' : 'Mark as none'} onClick={event => {
    event.stopPropagation();
    event.preventDefault();
    press(onClear);
  }}><span className="ui-chip-word">{word}</span><span className="ui-chip-check" aria-hidden="true"><Icon name="Check" /></span></button>;
}

function InvitationChip({item,busy,onAnswer}:{item:Item; busy:boolean; onAnswer:(item:Item,action:'confirm'|'reject')=>void}) {
  return <span className="ui-invite">
    <span className="ui-chip ui-invite-label" title="Pending invitation awaiting your response">Invitation</span>
    <span className="ui-invite-actions">
      <button type="button" className="ui-invite-action" disabled={busy} onClick={event=>{event.stopPropagation();onAnswer(item,'confirm');}} aria-label={`Accept ${item.title}'s invitation`} title="Accept"><Icon name="CircleCheck" aria-hidden="true"/></button>
      <button type="button" className="ui-invite-action" disabled={busy} onClick={event=>{event.stopPropagation();onAnswer(item,'reject');}} aria-label={`Ignore ${item.title}'s invitation`} title="Ignore"><Icon name="CircleX" aria-hidden="true"/></button>
    </span>
  </span>;
}

/** A message whose content is a picture or a post rather than text: shown on demand, never fetched on render. */
function MessageAttachment({media,link,onShow,onOpenLink}:{media?:Message['media']; link?:string; onShow:(messageId:string)=>Promise<{dataUrl?:string; url?:string}>; onOpenLink:(url:string)=>void}) {
  const [src,setSrc]=useState(''); const [note,setNote]=useState('');
  if(link&&!media) return <button type="button" className="ui-text-button" onClick={()=>onOpenLink(link)}>Open shared post</button>;
  if(!media) return null;
  if(src) return <img className="ui-message-media" src={src} alt="Photo in this conversation"/>;
  return <button type="button" className="ui-text-button" disabled={!!note} onClick={()=>{ void (async()=>{ try{ const shown=await onShow(media.messageId); if(shown.url) onOpenLink(shown.url); else if(shown.dataUrl) setSrc(shown.dataUrl); else setNote('This photo could not be loaded.'); }catch(e){ setNote(e instanceof Error?e.message:'This photo could not be loaded.'); } })(); }}>{note||'Show photo'}</button>;
}
installInboxMentionOpenListener();

export default definePluginApp(app => {
  app.slots.experimental_tab({ id: 'inbox', title: 'Inbox', icon: 'unified-inbox/inbox', context: { kind: 'thread' }, availability: 'fixed', layout: 'flush', component: Inbox });
  app.slots.settingsSection({
    id: 'accounts',
    title: 'Accounts',
    description: 'Connect Gmail, WhatsApp, LinkedIn, and Messages. The client id and secret are the fields above.',
    component: AccountSettings,
  });
});
