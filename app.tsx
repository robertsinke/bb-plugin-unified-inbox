import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { definePluginApp, experimental_Icon as Icon, ThreadChat, useBbNavigate, useComposers, useRpc, useSdk } from '@get-bb/plugin-sdk/app';
import { z } from 'zod';
import type { ExperimentalBadge } from '@get-bb/plugin-sdk/app';
import type { rpcContract } from './src/rpc-contract';
import { mailDocument, sanitizeMailMarkup } from './src/mail-html';
import type { WhatsAppMedia } from './src/whatsapp-media';
import './inbox.css';
import './chat.css';
import './layout.css';
import { siGmail, siWhatsapp } from 'simple-icons';
import { createMediaCache } from './src/media-cache';
import { isInvitationId } from './src/linkedin-inbox';
import { createInboxSession, type InboxItem, type InboxSession, type InboxSessionDeps } from './src/inbox-session';
import { expandEmailScrollRegions } from './src/mail-scroll';
import { MENTION_PROVIDER, mentionId, threadComposer } from './src/inbox-mention';
import { browserTabId, focusedBrowserId, messageParts, panelStateFocusedOn, panelStateKey, tabsAfterLink } from './src/message-links';
import { canAnswerInvitation, canArchive, canMarkRead, canSend, hasThread } from './src/ui-capabilities';
import type { Account, Message as InboxMessage } from './src/adapters/types';

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
  try { return window.localStorage; } catch { return undefined; }
}
function getInboxSession(rpc: InboxSessionDeps['rpc']): InboxSession {
  shared ??= createInboxSession({ rpc, storage: draftStorage(), now: () => Date.now() });
  return shared;
}
/** Every source, for the manual refresh: the heartbeat leaves LinkedIn alone until asked. */
const allSources: Account[] = ['whatsapp','personal','business','imessage','linkedin'];
const accounts: Record<Account, {label:string}> = {
  personal:{label:'Personal Gmail'}, business:{label:'Inhouse Gmail'}, whatsapp:{label:'WhatsApp'}, imessage:{label:'Messages'}, linkedin:{label:'LinkedIn'},
};
/* Presentation only: the sources whose conversations render as chat bubbles rather than mail documents. */
const chatLayout = (account: Account | undefined) => account === 'whatsapp' || account === 'imessage';
/* Presentation and mail protocol: the sources whose messages render as documents and reply through the mail draft form. */
const isMail = (account: Account): account is 'personal' | 'business' => account === 'personal' || account === 'business';
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
  const mosaic = account === 'whatsapp' && participants.length >= 2 && !photo;
  return <span className={`ui-avatar ui-${account}${mosaic?' ui-avatar-group':''}`} aria-hidden="true">
    <span className="ui-avatar-face" style={mosaic?undefined:{background:avatarFace(name)}}>
      {photo ? <img className="ui-avatar-photo" src={avatarUrl} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={()=>setImageFailed(true)}/> : mosaic ? participants.slice(0,4).map((person,index)=><span key={`${person}-${index}`} className="ui-avatar-cell" style={{background:avatarFace(person)}}>{firstLetter(person)}</span>) : initialsFor(name)}
    </span>
    <AppIcon account={account}/>
  </span>;
}
function date(value:number) { if (!value) return ''; const d=new Date(value); return d.toLocaleDateString(undefined,{month:'short',day:'numeric'})+' · '+d.toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'}); }
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
function MailFrame({ html, onOpenLink }: { html: string; onOpenLink: (url: string) => void }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const resizeObserver = useRef<ResizeObserver|null>(null);
  const openRef = useRef(onOpenLink);
  openRef.current = onOpenLink;
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
const mediaCache = createMediaCache();
function formatBytes(bytes: number) {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
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
function AttachmentChips({ account, gmailId, names }: { account: 'personal'|'business'; gmailId?: string; names?: string[] }) {
  const rpc = useRpc<typeof rpcContract>();
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  if (!names || names.length === 0) return null;
  async function download(name: string) {
    if (busy || !gmailId) return;
    setBusy(name); setError('');
    try {
      const result = await rpc.call('media', { account, kind: 'attachment', id: gmailId, filename: name });
      const link = document.createElement('a');
      link.href = result.dataUrl;
      link.download = result.filename ?? name;
      link.rel = 'noopener';
      document.body.append(link);
      link.click();
      link.remove();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not open this attachment.');
    } finally { setBusy(''); }
  }
  return <div className="ui-attachments" aria-label="Attachments">
    {names.map(name => <button type="button" className="ui-attachment" key={name} disabled={!!busy || !gmailId} aria-busy={busy === name} title={gmailId ? `Download ${name}` : 'Reopen this conversation to download'} onClick={() => void download(name)}>
      <Icon name="Paperclip" aria-hidden="true"/><span>{busy === name ? 'Opening…' : name}</span>
    </button>)}
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
    try { const result = await rpc.call('media', { account: 'imessage', kind: 'imsg', chatId, messageId, index: attachment.index }); setSrc(result.dataUrl); setState('idle'); }
    catch { setState('error'); }
  }
  if (src) return <div className="ui-bubble-media"><img className="ui-bubble-image" src={src} alt={attachment.name} /></div>;
  if (!attachment.available) return <p className="ui-media-note">{attachment.name} — attachment unavailable or unsupported.</p>;
  return <div className="ui-bubble-media ui-media-prompt"><button type="button" className="ui-text-button" disabled={state==='loading'} onClick={()=>void load()}>{state==='loading'?'Loading image…':state==='error'?'Retry image':`Show ${attachment.name}`}</button>{state==='error'&&<span role="status">Could not load this attachment.</span>}</div>;
}
function ChatBubble({ message: m, group, onOpenLink, imsgChatId }: { message: Message; group: boolean; onOpenLink: (url: string) => void; imsgChatId?: string }) {
  const text = m.text.trim();
  const hasText = Boolean(text) && (!m.media || text !== `[${m.media.kind}]`);
  const inlineSender = group && !m.fromMe && Boolean(m.sender) && hasText;
  return <article className="ui-bubble">
    <span className="ui-sr">{m.fromMe ? 'You' : m.sender || 'WhatsApp'}</span>
    {!inlineSender && !m.fromMe && m.sender && <div className="ui-bubble-sender">{m.sender}</div>}
    {m.replyContext && <p className="ui-media-note">Reply to an earlier message</p>}
    {m.media?.kind === 'video' ? <WhatsAppVideo media={m.media} /> : m.media ? <WhatsAppImage media={m.media} /> : null}
    {imsgChatId && m.imsgId && m.imsgAttachments?.map(attachment=><MessagesAttachment key={`${m.imsgId}:${attachment.index}`} chatId={imsgChatId} messageId={m.imsgId!} attachment={attachment}/>)}
    {hasText && <div className="ui-bubble-text">{inlineSender && <strong className="ui-bubble-sender-inline">{m.sender}: </strong>}<MessageText text={m.text} onOpenLink={onOpenLink} /></div>}
    {m.edited && <span className="ui-media-note">Edited</span>}
    {m.reactions?.length ? <div aria-label="Reactions">{m.reactions.map((reaction, index)=><span key={index} title={reaction.sender}>{reaction.label} </span>)}</div> : null}
    {m.date > 0 && <time className="ui-bubble-time">{new Date(m.date).toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'})}</time>}
  </article>;
}
function Inbox({ threadId }: { threadId: string | null }) {
  const sdk = useSdk();
  const navigate = useBbNavigate();
  const rpc=useRpc<typeof rpcContract>();
  const composers=useComposers();
  const session=getInboxSession(rpc);
  // State and time live in the session; the panel renders its snapshot.
  const state=useSyncExternalStore(session.subscribe,session.snapshot);
  const {items,errors,capabilities,selected,messages,status,text,busy,opening,filter,query,hits,refreshedAt,refreshingInbox,mail,mailStatus,audit}=state;
  /* Which account picker is open is the one thing only the panel needs to know. */
  const [compose,setCompose]=useState(false);
  const threadScroll=useRef<HTMLDivElement>(null); const pinnedBottom=useRef(true); const activeThread=useRef('');
  // The one heartbeat: `tick` runs every due list refresh, thread watch, search
  // debounce and draft write. A hidden panel ticks nothing, so a draft still inside
  // its debounce is written when the panel hides or goes away instead.
  useEffect(()=>{
    session.start();
    const timer=window.setInterval(()=>{if(document.visibilityState==='visible')void session.tick(Date.now());},1000);
    const flushDrafts=()=>session.flush();
    const flushOnHide=()=>{if(document.visibilityState==='hidden')flushDrafts();};
    window.addEventListener('pagehide',flushDrafts);
    document.addEventListener('visibilitychange',flushOnHide);
    return()=>{window.clearInterval(timer);window.removeEventListener('pagehide',flushDrafts);document.removeEventListener('visibilitychange',flushOnHide);flushDrafts();};
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
  const filtered=items.filter(i=>filter==='all'||(filter==='unread'?i.unread:i.account===filter));
  const shown=hits===null?filtered:hits.flatMap(hit=>{const item=filtered.find(row=>row.account===hit.account&&row.id===hit.id);return item?[item]:[];});
  const chat=chatLayout(selected?.account);
  // LinkedIn's messages are messages too, so it takes the composer and (in slice G) the bubble layout; Gmail stays a document.
  const threaded=!!selected&&hasThread(capabilities,selected.account);
  const sendable=!!selected&&canSend(capabilities,selected.account);
  return <div className={`ui-inbox ${selected?'ui-inbox-detail':''}`}>
    
    {compose && <div className="ui-compose-menu"><strong>Choose an account</strong><div className="ui-actions"><button onClick={()=>{session.startMail('new','personal');setCompose(false);}}>Personal Gmail</button><button onClick={()=>{session.startMail('new','business');setCompose(false);}}>Inhouse Gmail</button></div><p>New WhatsApp chats aren't supported here yet.</p></div>}
    {mail && !mail.threadId && <section className="ui-reply"><h3>New email · {accounts[mail.account].label}</h3><p>Sending is not enabled yet. This draft is a preview; attachments and rich formatting are not included.</p><label>To<input value={mail.to} onChange={e=>session.setMail({to:e.target.value})}/></label><label>Cc<input value={mail.cc} onChange={e=>session.setMail({cc:e.target.value})}/></label><label>Subject<input value={mail.subject} onChange={e=>session.setMail({subject:e.target.value})}/></label><label>Message<textarea rows={6} value={mail.text} onChange={e=>session.setMail({text:e.target.value})}/></label><div className="ui-mail-actions"><button className="ui-text-button" disabled={true} onClick={()=>{const label=accounts[mail.account].label;if(window.confirm(`Send from ${label} to ${mail.to}?`))void session.sendMail();}}>Sending unavailable</button><button className="ui-text-button" disabled={busy} onClick={()=>{if(!mail.text.trim()||window.confirm('Discard this draft?'))session.discardMail();}}>Discard</button></div>{mailStatus&&<p role="status">{mailStatus}</p>}</section>}

    {selected ? <section className="ui-detail"><header className="ui-conversation-header"><button className="ui-icon-button" onClick={()=>session.back()} aria-label="Back to inbox" title="Back to inbox"><Icon name="ArrowLeft" aria-hidden="true"/></button><ContactAvatar name={selected.account==='whatsapp'||selected.account==='imessage'?selected.title:(selected.sender||selected.title)} account={selected.account} participants={selected.participants} avatarUrl={selected.avatarUrl}/><div className="ui-conversation-title"><h3>{selected.title}{selected.account==='linkedin'&&isInvitationId(selected.id)&&(canAnswerInvitation(capabilities,selected.account)?<InvitationChip item={selected} busy={busy} onAnswer={(item,action)=>void session.answer(item,action)}/>:<span className="ui-chip">Invitation</span>)}</h3>{selected.account!=='whatsapp'&&selected.sender&&<span className="ui-conversation-meta">{selected.sender}</span>}</div><div className="ui-conversation-actions"><ItemMenu label={selected.title||'this conversation'} busy={busy} actions={[
          ...(isMail(selected.account)?[
            { label: 'Reply', run: () => session.startMail('reply', selected.account as 'personal'|'business'), title: 'Reply to this conversation', disabled: opening&&!messages.length },
            { label: 'Reply all', run: () => session.startMail('replyAll', selected.account as 'personal'|'business'), title: 'Reply to everyone on this thread', disabled: opening&&!messages.length },
            { label: 'Forward', run: () => session.startMail('forward', selected.account as 'personal'|'business'), title: 'Forward this conversation', disabled: opening&&!messages.length },
          ]:[]),
          { label: 'Add to chat', run: () => tag(selected) },
          ...(isConversationRow(selected)&&canMarkRead(capabilities,selected.account)?[{ label: selected.unread?'Mark read':'Mark unread', run: () => void session.mark(selected, selected.unread?'read':'unread') }]:[]),
          ...(canArchive(capabilities,selected.account)?[{ label: 'Archive', run: () => { if(window.confirm('Archive this Gmail conversation?')) void session.mark(selected,'archive'); } }]:[]),
        ]}/></div></header>{mail && mail.threadId===selected.id && <section className="ui-reply ui-reply-inline"><h3>{mail.subject||'Reply'}</h3><label>To<input value={mail.to} onChange={e=>session.setMail({to:e.target.value})}/></label><label>Cc<input value={mail.cc} onChange={e=>session.setMail({cc:e.target.value})}/></label><label>Subject<input value={mail.subject} onChange={e=>session.setMail({subject:e.target.value})}/></label><label>Message<textarea rows={6} value={mail.text} onChange={e=>session.setMail({text:e.target.value})}/></label><div className="ui-mail-actions"><button className="ui-text-button" disabled={true} onClick={()=>{const label=accounts[mail.account].label;if(window.confirm(`Send from ${label} to ${mail.to}?`))void session.sendMail();}}>Sending unavailable</button><button className="ui-text-button" disabled={busy} onClick={()=>{if(!mail.text.trim()||window.confirm('Discard this draft?'))session.discardMail();}}>Discard</button></div>{mailStatus&&<p role="status">{mailStatus}</p>}</section>}<div className="ui-thread-scroll" ref={threadScroll} tabIndex={0} aria-label="Conversation messages" onScroll={event=>{const el=event.currentTarget;pinnedBottom.current=el.scrollHeight-el.scrollTop-el.clientHeight<48;}}>
      {opening?<p className="ui-empty" role="status">Loading conversation…</p>:chat?<div className="ui-chat" aria-label={selected.account==='imessage'?'Messages conversation':'WhatsApp messages'}>{messages.length===0?<p className="ui-empty">No messages in this conversation.</p>:messages.map((m,i)=>{const day=m.date?new Date(m.date).toLocaleDateString(undefined,{year:'numeric',month:'long',day:'numeric'}):'';const previous=i>0&&messages[i-1].date?new Date(messages[i-1].date).toLocaleDateString(undefined,{year:'numeric',month:'long',day:'numeric'}):'';return <div key={m.imsgId ?? m.media?.messageId ?? i}>{day&&day!==previous&&<div className="ui-chat-day">{day}</div>}<div className={`ui-chat-row ${m.fromMe?'ui-chat-outgoing':'ui-chat-incoming'}`}><ChatBubble message={m} group={selected.account==='imessage'||selected.id.endsWith('@g.us')} imsgChatId={selected.account==='imessage'?selected.id:undefined} onOpenLink={url=>{void openLink(url);}}/></div></div>;})}</div>:messages.map((m,i)=><article className="ui-message" key={i}><div className="ui-message-head"><strong>{m.sender||'Unknown sender'}</strong><time>{date(m.date)}</time></div>{isMail(selected.account)&&<AttachmentChips account={selected.account} gmailId={m.gmailId} names={m.attachments}/>}{m.html?<MailFrame html={m.html} onOpenLink={url=>{void openLink(url);}}/>:<div className="ui-message-body"><MessageText text={m.text} onOpenLink={url=>{void openLink(url);}}/></div>}{!chat&&(m.media||m.link)?<MessageAttachment media={m.media} link={m.link} onShow={messageId=>rpc.call('media',{account:selected.account,kind:'message',id:messageId,index:0})} onOpenLink={url=>{void openLink(url);}}/>:null}</article>)}
      </div>
      {threaded?<form className="ui-chat-composer" onSubmit={event=>{event.preventDefault(); pinnedBottom.current=true; void session.submit();}}><div className="ui-promptbox">{<textarea id="ui-reply-text" value={text} aria-label={`${accounts[selected.account].label} reply`} onChange={e=>session.setDraft(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault(); pinnedBottom.current=true; void session.submit();}}} rows={2} placeholder={sendable?'Write a reply…':'Write a draft…'}/>}{sendable?<button type="submit" className="ui-prompt-send" disabled={busy||!text.trim()} aria-label="Send"><Icon name="ArrowUp" aria-hidden="true"/></button>:null}</div>{sendable?null:<p className="ui-notice">Kept as a draft on this machine; this source cannot send from here.</p>}</form>:null}
      {status&&<p role="status" className="ui-notice">{status}</p>}
    </section>:<><div className="ui-list"><header className="ui-mail-bar"><FilterMenu value={filter} onChange={next=>session.setFilter(next)} /><span className="ui-search-wrap"><input className="ui-search" value={query} onChange={event=>session.setQuery(event.target.value)} placeholder="Search" aria-label="Search inbox" />{query!==''&&<button type="button" className="ui-search-clear" onClick={()=>session.setQuery('')} aria-label="Clear the search" title="Clear search"><Icon name="CircleX" aria-hidden="true"/></button>}</span><ItemMenu label="this inbox" busy={refreshingInbox} marker={errors.length?`Some messages couldn't load: ${errors.join(' ')}`:undefined} actions={[
          { label: 'New', run: () => setCompose(!compose) },
          { label: 'Refresh', run: () => void session.refresh(allSources), title: refreshTitle },
        ]}/></header>{audit.length>0&&<details className="ui-send-log"><summary title="The send gate's last decisions; a refusal means the adapter was never reached">{audit.some(entry=>entry.decision==='allowed')?`${audit.filter(entry=>entry.decision==='allowed').length} sent, ${audit.filter(entry=>entry.decision==='refused').length} refused`:`${audit.length} refused, nothing sent`}</summary><ul>{audit.map(entry=><li key={`${entry.at}-${entry.conversationId}-${entry.decision}`} className={entry.decision==='refused'?'is-refused':'is-allowed'}><time>{new Date(entry.at).toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'})}</time><span className="ui-send-log-decision">{entry.decision==='refused'?'Refused':'Sent'}</span><span className="ui-send-log-account">{accounts[entry.account].label}</span>{entry.reason&&<span className="ui-send-log-reason">{entry.reason}</span>}</li>)}</ul></details>}{shown.length===0?<p className="ui-empty">{query.trim()?'No conversations match this search.':filter==='unread'?'No unread messages in this view.':'No conversations in this view.'}</p>:shown.map(i=><div className={`ui-row ${i.unread?'is-unread':''}`} key={`${i.account}:${i.id}`}><div className="ui-row-open"><button type="button" className="ui-row-open-hit" onClick={()=>void session.open(i)} aria-label={`Open ${i.title||i.preview||'conversation'}`}/><ContactAvatar name={i.account==='whatsapp'||i.account==='imessage'?i.title:(i.sender||'Unknown sender')} account={i.account} participants={i.participants} avatarUrl={i.avatarUrl}/><span className="ui-sr">{accounts[i.account].label}</span><div className="ui-row-copy"><div className="ui-row-top"><strong className="ui-row-name">{i.account==='whatsapp'||i.account==='imessage'?i.title:(i.sender||'Unknown sender')}</strong><span className="ui-row-meta"><time className="ui-row-time">{date(i.date)}</time>{i.account==='linkedin'&&isInvitationId(i.id)&&(canAnswerInvitation(capabilities,i.account)?<InvitationChip item={i} busy={busy} onAnswer={(item,action)=>void session.answer(item,action)}/>:<span className="ui-chip">Invitation</span>)}</span></div><p><span className="ui-row-snippet">{i.preview||'No preview available'}</span></p></div></div><div className="ui-row-side"><div className="ui-row-actions"><ItemMenu label={i.title||i.preview||'this conversation'} busy={busy} actions={[
      { label: 'Add to chat', run: () => tag(i) },
      ...(isConversationRow(i)&&canMarkRead(capabilities,i.account)?[{ label: i.unread?'Mark read':'Mark unread', run: () => void session.mark(i, i.unread?'read':'unread') }]:[]),
    ]}/></div></div></div>)}</div><p className="ui-footnote">Showing the latest 20 threads per Gmail and Messages account, 50 WhatsApp chats, and the latest 20 LinkedIn conversations.</p></>}
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
/**
 * The inbox is filtered by one control rather than five. The sources stack under it on hover or
 * focus, each with its own icon, so the filter keeps its shape whichever source is chosen and the
 * bar stops carrying a row of buttons that only one of them can be.
 */
function FilterMenu({value,onChange}:{value:InboxFilter; onChange:(next:InboxFilter)=>void}) {
  const sources = ['whatsapp','personal','business','imessage','linkedin'] as const;
  return <span className="ui-menu ui-menu-start">
    <button type="button" className="ui-icon-button" aria-haspopup="menu" aria-label={`Filter: ${value==='all'?'all conversations':value==='unread'?'unread':accounts[value].label}`} title="Filter this inbox"><Icon name="ListView" aria-hidden="true"/></button>
    <span className="ui-menu-list" role="menu">
      <button type="button" role="menuitem" className="ui-menu-item" aria-pressed={value==='all'} onClick={()=>onChange('all')}><Icon name="LayoutList" aria-hidden="true"/>All</button>
      <button type="button" role="menuitem" className="ui-menu-item" aria-pressed={value==='unread'} onClick={()=>onChange('unread')}><Icon name="Mail" aria-hidden="true"/>Unread</button>
      {sources.map(key=><button type="button" key={key} role="menuitem" className="ui-menu-item" aria-pressed={value===key} onClick={()=>onChange(key)}><AppIcon account={key}/>{accounts[key].label}</button>)}
    </span>
  </span>;
}

/** What the list is narrowed to: everything, the unread, or one source. */
type InboxFilter = 'all' | 'unread' | Account;

type MenuAction = { label: string; run: () => void; title?: string; disabled?: boolean };

/**
 * One control per row instead of one per action: a few dots that open their list under the cursor,
 * or under keyboard focus. The list is the row's whole vocabulary, so a source that cannot do
 * something simply never contributes its entry.
 */
function ItemMenu({label,busy,actions,marker}:{label:string; busy:boolean; actions:MenuAction[]; marker?:string}) {
  return <span className="ui-menu">
    <button type="button" className="ui-icon-button" disabled={busy} aria-haspopup="menu" aria-label={`More actions for ${label}`} title={marker??'More actions'}><Icon name="MoreHorizontal" aria-hidden="true"/></button>
    {marker&&<span className="ui-menu-marker" aria-hidden="true"/>}
    <span className="ui-menu-list" role="menu" aria-label={`Actions for ${label}`}>
      {actions.map(action=><button key={action.label} type="button" role="menuitem" className="ui-menu-item" disabled={busy||action.disabled===true} title={action.title} onClick={event=>{event.stopPropagation();action.run();}}>{action.label}</button>)}
    </span>
  </span>;
}

function isConversationRow(item: Item): boolean {
  return !(item.account === 'linkedin' && isInvitationId(item.id));
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
export default definePluginApp(app => {
  app.slots.experimental_tab({ id: 'inbox', title: 'Inbox', icon: 'unified-inbox/inbox', context: { kind: 'thread' }, availability: 'fixed', layout: 'flush', component: Inbox });
});
