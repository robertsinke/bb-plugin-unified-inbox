import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { definePluginApp, experimental_Icon as Icon, ThreadChat, useBbNavigate, useComposers, useRpc, useSdk } from '@get-bb/plugin-sdk/app';
import { z } from 'zod';
import type { ExperimentalBadge } from '@get-bb/plugin-sdk/app';
import type { rpcContract } from './server';
import { mailDocument, sanitizeMailMarkup } from './src/mail-html';
import type { WhatsAppMedia } from './src/whatsapp-media';
import './inbox.css';
import './chat.css';
import './layout.css';
import { siGmail, siWhatsapp } from 'simple-icons';
import { createMediaCache } from './src/media-cache';
import { messagesAfterSend } from './src/sent-message';
import { isInvitationId } from './src/linkedin-inbox';
import { inboxDraftKey, readInboxDraft, writeInboxDraft } from './src/inbox-drafts';
import { expandEmailScrollRegions } from './src/mail-scroll';
import { MENTION_PROVIDER, mentionId, threadComposer } from './src/inbox-mention';
import { browserTabId, focusedBrowserId, messageParts, panelStateFocusedOn, panelStateKey, tabsAfterLink } from './src/message-links';
import { canAnswerInvitation, canArchive, canMarkRead, canSend, type CapabilityMap } from './src/ui-capabilities';
import type { Account } from './src/adapters/types';

type Item = {account: Account; id:string; title:string; preview:string; date:number; unread:boolean; sender?:string; avatarUrl?:string; participants?:string[]};
type Message = {link?:string; edited?:boolean; replyContext?:boolean; imsgId?:string; imsgAttachments?:{index:number;name:string;available:boolean}[]; sender:string; text:string; date:number; fromMe?:boolean; media?:WhatsAppMedia; html?:string; to?:string; cc?:string; replyTo?:string; subject?:string; messageId?:string; references?:string; suggestedTo?:string; suggestedCc?:string; reactions?:{sender:string;label:string}[]; attachments?:string[]; gmailId?:string};
type MailDraft = {account:'personal'|'business'; to:string; cc:string; subject:string; text:string; threadId?:string; inReplyTo?:string; references?:string};
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
      const result = await rpc.call('media', { messageId: media.messageId });
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
      const result = await rpc.call('attachment', { account, gmailId, filename: name });
      const link = document.createElement('a');
      link.href = result.dataUrl;
      link.download = result.filename;
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
    try { const result = await rpc.call('imsg_media', { chatId, messageId, index: attachment.index }); setSrc(result.dataUrl); setState('idle'); }
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
  const [items,setItems]=useState<Item[]>([]); const [errors,setErrors]=useState<string[]>([]);
  const [capabilities,setCapabilities]=useState<CapabilityMap|null>(null);
  const [selected,setSelected]=useState<Item|null>(null); const [messages,setMessages]=useState<Message[]>([]);
  const [status,setStatus]=useState(''); const [text,setText]=useState(''); const [busy,setBusy]=useState(false);
  const [opening,setOpening]=useState(false);
  const [filter,setFilter]=useState<InboxFilter>('all'); const [compose,setCompose]=useState(false); const [mail,setMail]=useState<MailDraft|null>(null); const [mailStatus,setMailStatus]=useState('');
  const [query,setQuery]=useState(''); const [hits,setHits]=useState<{account:Account; id:string}[]|null>(null);
  const [refreshedAt,setRefreshedAt]=useState<Partial<Record<Account, number>>>({}); const [refreshingInbox,setRefreshingInbox]=useState(false);
  const [proposal,setProposal]=useState<{id:number; text:string; chatId:string}|null>(null);
  const request=useRef(0); const refreshing=useRef(new Set<Account>()); const threadScroll=useRef<HTMLDivElement>(null); const replyDrafts=useRef(new Map<string,string>());
  const pendingDrafts=useRef(new Map<string,string>()); const draftTimers=useRef(new Map<string,number>());
  const pinnedBottom=useRef(true); const activeThread=useRef('');
  function draftStorage() { try { return window.localStorage; } catch { return undefined; } }
  function readComposerDraft(account:Account,id:string) {
    const key=inboxDraftKey({account,id});
    if(pendingDrafts.current.has(key))return pendingDrafts.current.get(key)||'';
    return readInboxDraft(draftStorage(),key) ?? replyDrafts.current.get(key) ?? '';
  }
  function persistComposerDraft(key:string) {
    const timer=draftTimers.current.get(key);
    if(timer!==undefined){window.clearTimeout(timer);draftTimers.current.delete(key);}
    const value=pendingDrafts.current.get(key);
    if(value!==undefined && writeInboxDraft(draftStorage(),key,value))pendingDrafts.current.delete(key);
  }
  function flushComposerDrafts() { for(const key of pendingDrafts.current.keys())persistComposerDraft(key); }
  function saveComposerDraft(account:Account,id:string,value:string) {
    const key=inboxDraftKey({account,id});
    if(value)replyDrafts.current.set(key,value);else replyDrafts.current.delete(key);
    pendingDrafts.current.set(key,value);
    const oldTimer=draftTimers.current.get(key);
    if(oldTimer!==undefined)window.clearTimeout(oldTimer);
    draftTimers.current.set(key,window.setTimeout(()=>persistComposerDraft(key),250));
  }
  function clearComposerDraft(account:Account,id:string) {
    const key=inboxDraftKey({account,id});
    const timer=draftTimers.current.get(key);
    if(timer!==undefined){window.clearTimeout(timer);draftTimers.current.delete(key);}
    replyDrafts.current.delete(key);
    pendingDrafts.current.set(key,'');
    if(writeInboxDraft(draftStorage(),key,'') )pendingDrafts.current.delete(key);
  }
  useEffect(()=>{
    const onVisibility=()=>{if(document.visibilityState==='hidden')flushComposerDrafts();};
    window.addEventListener('pagehide',flushComposerDrafts);
    document.addEventListener('visibilitychange',onVisibility);
    return()=>{window.removeEventListener('pagehide',flushComposerDrafts);document.removeEventListener('visibilitychange',onVisibility);flushComposerDrafts();};
  },[]);
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
  useEffect(()=>{
    let alive=true;
    void rpc.call('capabilities',null).then(declared=>{if(alive)setCapabilities(declared);}).catch(()=>{ /* the sources stay offerless rather than guessing what they can do */ });
    return()=>{alive=false;};
  },[rpc]);
  const refresh=useCallback(async(sources:Account[]=['whatsapp','personal','business','imessage'])=>{
    const pending=sources.filter(account=>!refreshing.current.has(account));
    if(!pending.length)return;
    for (const account of pending) refreshing.current.add(account);
    setRefreshingInbox(true);
    try {
      await Promise.all(pending.map(async account=>{
        try {
          const listed=account==='linkedin' ? await rpc.call('linkedin_sync',null) : await rpc.call('list_source',{account});
          setItems(old=>[...old.filter(item=>item.account!==account),...listed.items].sort((a,b)=>b.date-a.date));
          setRefreshedAt(old=>({...old,[account]:Date.now()}));
          setErrors(old=>old.filter(error=>!error.startsWith(accounts[account].label)));
        } catch(error) {const detail=account==='linkedin'&&error instanceof Error?` ${error.message}`:'';setErrors(old=>old.some(error=>error.startsWith(accounts[account].label))?old:[...old,account==='imessage'?'Messages could not refresh. Check that imsg is installed and BB has Full Disk Access. Previously loaded messages may be stale.':`${accounts[account].label} could not refresh.${detail} Previously loaded messages may be stale.`]);}
      }));
    } finally { for (const account of pending) refreshing.current.delete(account); setRefreshingInbox(refreshing.current.size>0); }
  },[rpc]);
  function refreshManually(){void refresh(['whatsapp','personal','business','imessage','linkedin']);}
  useEffect(()=>{let alive=true; void (async()=>{try {const cached=await rpc.call('cached',null); if(alive)setItems(cached.items);} catch { /* the next sync still fills the list */ } if(alive)void refresh();})(); const whatsappTimer=window.setInterval(()=>{if(document.visibilityState==='visible')void refresh(['whatsapp','imessage']);},8000); const gmailTimer=window.setInterval(()=>{if(document.visibilityState==='visible')void refresh(['personal','business']);},45000); return()=>{alive=false;window.clearInterval(whatsappTimer);window.clearInterval(gmailTimer);};},[refresh,rpc]);
  useEffect(()=>{
    const q=query.trim();
    if(!q){setHits(null);return;}
    let alive=true;
    const timer=window.setTimeout(()=>{void rpc.call('search',{query:q}).then(result=>{if(alive)setHits(result.ids);}).catch(()=>{if(alive)setHits([]);});},150);
    return()=>{alive=false;window.clearTimeout(timer);};
  },[query,rpc]);
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
    } catch (error) { setStatus(error instanceof Error ? error.message : 'Could not open that link in the browser.'); }
  }
  useEffect(()=>{
    if(!selected)return;
    const current=items.find(item=>item.account===selected.account&&item.id===selected.id);
    if(!current||(current.date===selected.date&&current.preview===selected.preview))return;
    const seq=++request.current;
    setSelected(current);
    if(current.account==='linkedin')return;
    void rpc.call('open',{account:current.account,id:current.id}).then(result=>{if(seq===request.current)setMessages(result.messages);}).catch(()=>{ /* the messages already on screen stay */ });
  },[items,rpc,selected]);
  useEffect(()=>{
    if (!selected || selected.account !== 'whatsapp') return;
    const id=selected.id;
    let running=false, active=true;
    const timer=window.setInterval(()=>{
      if(document.visibilityState!=='visible' || running) return;
      const seq=request.current;
      running=true;
      void rpc.call('open',{account:'whatsapp',id}).then(result=>{if(active && seq===request.current)setMessages(result.messages);}).catch(()=>{}).finally(()=>{running=false;});
    },5000);
    return()=>{active=false;window.clearInterval(timer);};
  },[selected?.account,selected?.id,rpc]);
  useEffect(()=>{
    if (!selected || selected.account !== 'imessage') return;
    const id=selected.id;
    let running=false, active=true;
    const timer=window.setInterval(()=>{
      if(document.visibilityState!=='visible' || running) return;
      const seq=request.current;
      running=true;
      void rpc.call('open',{account:'imessage',id}).then(result=>{if(active && seq===request.current)setMessages(result.messages);}).catch(()=>{}).finally(()=>{running=false;});
    },8000);
    return()=>{active=false;window.clearInterval(timer);};
  },[selected?.account,selected?.id,rpc]);
  async function dropProposal() {
    const current = proposal;
    if (!current) return;
    setProposal(null);
    setText(current.text);
    try { await rpc.call('action', { account: 'whatsapp', id: current.chatId, action: 'reject', proposalId: current.id }); } catch { setStatus('Could not cancel the unsent message.'); }
  }
  async function open(i:Item) {
    if (proposal && proposal.chatId !== i.id) await dropProposal();
    const seq=++request.current; setSelected(i); setStatus(''); setText(readComposerDraft(i.account,i.id)); setOpening(true);
    try {
      const remembered=await rpc.call('cached_open',{account:i.account,id:i.id});
      if(seq===request.current && remembered.messages.length){ setMessages(remembered.messages); setOpening(false); }
      else if(seq===request.current) setMessages([]);
      const messagesToShow=await rpc.call('open',{account:i.account,id:i.id}).then(result=>result.messages);
      if(seq===request.current) setMessages(messagesToShow);
      if (canMarkRead(capabilities,i.account) && i.unread && seq===request.current) {
        void rpc.call('action', { account: i.account, id: i.id, action: 'read' }).then(() => {
          if (seq !== request.current) return;
          setItems(old => old.map(item => item.account===i.account && item.id===i.id ? { ...item, unread: false } : item));
          setSelected(cur => cur && cur.account===i.account && cur.id===i.id ? { ...cur, unread: false } : cur);
        }).catch(() => { /* the conversation stays unread if the source rejects the update */ });
      }
    } catch(error) {if(seq===request.current) setStatus(error instanceof Error?error.message:'Could not load this conversation.');} finally {if(seq===request.current) setOpening(false);}
  }
  function back(){ void dropProposal(); ++request.current;setSelected(null);setStatus('');setOpening(false);}
  function tag(item: Item) {
    const target = threadComposer(composers, threadId);
    if (!target) { setStatus('Open a thread beside the inbox to tag this conversation.'); return; }
    try {
      target.insert({ provider: MENTION_PROVIDER, id: mentionId(item.account, item.id), label: item.title || item.preview || 'Inbox conversation' }, { at: 'end', block: true });
      target.focus();
      requestAnimationFrame(() => target.focus());
    } catch (error) { setStatus(error instanceof Error ? error.message : 'Could not tag this conversation.'); }
  }
  async function answer(i:Item, action:'confirm'|'reject') {
    if(busy||!selected)return;
    setBusy(true); setStatus('');
    try{
      const result = await rpc.call('action', { account: i.account, id: i.id, action });
      setStatus(result.status);
      try { const listed = await rpc.call('list_source', { account: i.account }); setItems(old => [...listed.items, ...old.filter(item => item.account !== i.account)].sort((a,b)=>b.date-a.date)); } catch { /* the status already says what happened */ }
    } catch (e) { setStatus(e instanceof Error ? e.message : 'The invitation was not answered.'); }
    finally { setBusy(false); }
  }
  async function mark(i:Item, action:'read'|'unread'|'archive') {
    if(busy)return;
    if(action==='archive'&&!window.confirm('Archive this Gmail conversation?'))return;
    const unread=action==='unread';
    setItems(old=>action==='archive'?old.filter(item=>!(item.account===i.account&&item.id===i.id)):old.map(item=>item.account===i.account&&item.id===i.id?{...item,unread}:item));
    setSelected(cur=>cur&&cur.account===i.account&&cur.id===i.id?action==='archive'?null:{...cur,unread}:cur);
    try { await rpc.call('action',{account:i.account,id:i.id,action}); }
    catch(e){ setItems(old=>old.map(item=>item.account===i.account&&item.id===i.id?i:item)); setStatus(e instanceof Error?e.message:'Could not update this conversation.'); }
  }
  async function proposeSend() {
    if(!selected||selected.account!=='whatsapp'||busy||!text.trim()||proposal)return;
    const draft = text.trim();
    setBusy(true); setStatus('');
    try {
      const r = await rpc.call('action', { account: 'whatsapp', id: selected.id, action: 'reply', text: draft });
      if (!r.proposalId) throw new Error('WhatsAgent did not create a proposal. Nothing was sent.');
      setProposal({ id: r.proposalId, text: r.text || draft, chatId: selected.id });
    } catch (e) { setStatus(e instanceof Error ? e.message : 'Could not prepare the message.'); }
    finally { setBusy(false); }
  }
  async function confirmSend() {
    if(!proposal||!selected||busy)return;
    const sentText = proposal.text;
    const chatId = proposal.chatId;
    setBusy(true); setStatus('');
    try {
      await rpc.call('action', { account: 'whatsapp', id: chatId, action: 'confirm', proposalId: proposal.id, text: sentText });
      setProposal(null);
      pinnedBottom.current=true;
      clearComposerDraft('whatsapp',chatId);
      setText('');
      const sentAt = Date.now();
      setMessages(old => messagesAfterSend(old, sentText, sentAt));
      try { const opened = await rpc.call('open', { account: 'whatsapp', id: chatId }); setMessages(messagesAfterSend(opened.messages, sentText, sentAt)); } catch { /* the bubble already on screen stays */ }
      try { const listed = await rpc.call('list_source', { account: 'whatsapp' }); setItems(old => [...listed.items, ...old.filter(item => item.account !== 'whatsapp')].sort((a,b) => b.date-a.date)); } catch { /* the open chat does not depend on the list */ }
    } catch (e) { setProposal(null); setText(sentText); setStatus(e instanceof Error ? e.message : 'The message was not sent.'); }
    finally { setBusy(false); }
  }
  function submitComposer() {
    if(!selected||busy)return;
    // Without a send capability the box only keeps a draft, so nothing here can reach the source.
    if(!sendable||!text.trim())return;
    if(selected.account==='whatsapp'){ if(proposal) void confirmSend(); else void proposeSend(); return; }
    void sendMessage();
  }
  async function sendMessage() {
    if(!selected||selected.account==='whatsapp'||busy||!sendable||!text.trim())return;
    const chatId = selected.id, draft = text.trim(), account = selected.account;
    setBusy(true); setStatus('');
    try {
      const result = await rpc.call('action', { account, id: chatId, action: 'reply', text: draft });
      pinnedBottom.current = true;
      clearComposerDraft(account, chatId);
      setText('');
      const sentAt = Date.now();
      setMessages(old => messagesAfterSend(old, draft, sentAt));
      setStatus(result.status);
      try { const opened = await rpc.call('open', { account, id: chatId }); setMessages(messagesAfterSend(opened.messages, draft, sentAt)); } catch { /* the bubble already on screen stays */ }
      try { const listed = await rpc.call('list_source', { account: 'imessage' }); setItems(old => [...listed.items, ...old.filter(item => item.account !== 'imessage')].sort((a,b) => b.date-a.date)); } catch { /* the open chat does not depend on the list */ }
    } catch (e) { setText(draft); setStatus(e instanceof Error ? e.message : 'The message was not sent.'); }
    finally { setBusy(false); }
  }
  function startMail(mode:'new'|'reply'|'replyAll'|'forward', account:'personal'|'business') {
    const m=messages.at(-1); const subject=m?.subject||selected?.title||'';
    const replyTo=m?.suggestedTo||'';
    const cc=mode==='replyAll' ? m?.suggestedCc||'' : '';
    setMail({account,to:mode==='reply'||mode==='replyAll'?replyTo:'',cc,subject:mode==='new'?'':mode==='forward'?`Fwd: ${subject.replace(/^fwd:\s*/i,'')}`:`Re: ${subject.replace(/^re:\s*/i,'')}`,text:mode==='forward'?`\n\n---------- Forwarded message ----------\nFrom: ${m?.sender||''}\n\n${m?.text||''}`:'',...(mode==='reply'||mode==='replyAll'?{threadId:selected?.id,inReplyTo:m?.messageId,references:[m?.references,m?.messageId].filter(Boolean).join(' ')}:{})});setCompose(false);setMailStatus('');
  }
  async function sendMail() {
    if(!mail||busy||!mail.to.trim()||!mail.text.trim())return;
    if(!window.confirm(`Send from ${accounts[mail.account].label} to ${mail.to}?`))return;
    setBusy(true);setMailStatus('Sending…');try {const result=await rpc.call('send_gmail',mail);setMailStatus(result.status);setMail(null);setStatus(result.status);}catch(e){setMailStatus(e instanceof Error?e.message:'Send outcome unknown. Check Gmail Sent before retrying.');}finally{setBusy(false);}
  }
  const latestRefresh=Math.max(0,...Object.values(refreshedAt).filter((value): value is number => typeof value==='number'));
  const refreshTitle=latestRefresh?`Last refresh ${new Date(latestRefresh).toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})}; LinkedIn reads only from an already-open BB Browser tab`:'Refresh inbox; LinkedIn reads only from an already-open BB Browser tab';
  const filtered=items.filter(i=>filter==='all'||(filter==='unread'?i.unread:i.account===filter));
  const shown=hits===null?filtered:hits.flatMap(hit=>{const item=filtered.find(row=>row.account===hit.account&&row.id===hit.id);return item?[item]:[];});
  const chat=chatLayout(selected?.account);
  // LinkedIn's messages are messages too, so it takes the composer and (in slice G) the bubble layout; Gmail stays a document.
  const threaded=chat||selected?.account==='linkedin';
  const sendable=!!selected&&canSend(capabilities,selected.account);
  return <div className={`ui-inbox ${selected?'ui-inbox-detail':''}`}>
    
    {compose && <div className="ui-compose-menu"><strong>Choose an account</strong><div className="ui-actions"><button onClick={()=>startMail('new','personal')}>Personal Gmail</button><button onClick={()=>startMail('new','business')}>Inhouse Gmail</button></div><p>New WhatsApp chats aren't supported here yet.</p></div>}
    {mail && !mail.threadId && <section className="ui-reply"><h3>New email · {accounts[mail.account].label}</h3><p>Sending is not enabled yet. This draft is a preview; attachments and rich formatting are not included.</p><label>To<input value={mail.to} onChange={e=>setMail({...mail,to:e.target.value})}/></label><label>Cc<input value={mail.cc} onChange={e=>setMail({...mail,cc:e.target.value})}/></label><label>Subject<input value={mail.subject} onChange={e=>setMail({...mail,subject:e.target.value})}/></label><label>Message<textarea rows={6} value={mail.text} onChange={e=>setMail({...mail,text:e.target.value})}/></label><div className="ui-mail-actions"><button className="ui-text-button" disabled={true} onClick={()=>void sendMail()}>Sending unavailable</button><button className="ui-text-button" disabled={busy} onClick={()=>{if(!mail.text.trim()||window.confirm('Discard this draft?'))setMail(null);}}>Discard</button></div>{mailStatus&&<p role="status">{mailStatus}</p>}</section>}

    {selected ? <section className="ui-detail"><header className="ui-conversation-header"><button className="ui-icon-button" onClick={back} aria-label="Back to inbox" title="Back to inbox"><Icon name="ArrowLeft" aria-hidden="true"/></button><ContactAvatar name={selected.account==='whatsapp'||selected.account==='imessage'?selected.title:(selected.sender||selected.title)} account={selected.account} participants={selected.participants} avatarUrl={selected.avatarUrl}/><div className="ui-conversation-title"><h3>{selected.title}{selected.account==='linkedin'&&isInvitationId(selected.id)&&(canAnswerInvitation(capabilities,selected.account)?<InvitationChip item={selected} busy={busy} onAnswer={answer}/>:<span className="ui-chip">Invitation</span>)}</h3>{selected.account!=='whatsapp'&&selected.sender&&<span className="ui-conversation-meta">{selected.sender}</span>}</div><div className="ui-conversation-actions"><ItemMenu label={selected.title||'this conversation'} busy={busy} actions={[
          ...(isMail(selected.account)?[
            { label: 'Reply', run: () => startMail('reply', selected.account as 'personal'|'business'), title: 'Reply to this conversation', disabled: opening&&!messages.length },
            { label: 'Reply all', run: () => startMail('replyAll', selected.account as 'personal'|'business'), title: 'Reply to everyone on this thread', disabled: opening&&!messages.length },
            { label: 'Forward', run: () => startMail('forward', selected.account as 'personal'|'business'), title: 'Forward this conversation', disabled: opening&&!messages.length },
          ]:[]),
          { label: 'Add to chat', run: () => tag(selected) },
          ...(isConversationRow(selected)&&canMarkRead(capabilities,selected.account)?[{ label: selected.unread?'Mark read':'Mark unread', run: () => void mark(selected, selected.unread?'read':'unread') }]:[]),
          ...(canArchive(capabilities,selected.account)?[{ label: 'Archive', run: () => void mark(selected,'archive') }]:[]),
        ]}/></div></header>{mail && mail.threadId===selected.id && <section className="ui-reply ui-reply-inline"><h3>{mail.subject||'Reply'}</h3><label>To<input value={mail.to} onChange={e=>setMail({...mail,to:e.target.value})}/></label><label>Cc<input value={mail.cc} onChange={e=>setMail({...mail,cc:e.target.value})}/></label><label>Subject<input value={mail.subject} onChange={e=>setMail({...mail,subject:e.target.value})}/></label><label>Message<textarea rows={6} value={mail.text} onChange={e=>setMail({...mail,text:e.target.value})}/></label><div className="ui-mail-actions"><button className="ui-text-button" disabled={true} onClick={()=>void sendMail()}>Sending unavailable</button><button className="ui-text-button" disabled={busy} onClick={()=>{if(!mail.text.trim()||window.confirm('Discard this draft?'))setMail(null);}}>Discard</button></div>{mailStatus&&<p role="status">{mailStatus}</p>}</section>}<div className="ui-thread-scroll" ref={threadScroll} tabIndex={0} aria-label="Conversation messages" onScroll={event=>{const el=event.currentTarget;pinnedBottom.current=el.scrollHeight-el.scrollTop-el.clientHeight<48;}}>
      {opening?<p className="ui-empty" role="status">Loading conversation…</p>:chat?<div className="ui-chat" aria-label={selected.account==='imessage'?'Messages conversation':'WhatsApp messages'}>{messages.length===0?<p className="ui-empty">No messages in this conversation.</p>:messages.map((m,i)=>{const day=m.date?new Date(m.date).toLocaleDateString(undefined,{year:'numeric',month:'long',day:'numeric'}):'';const previous=i>0&&messages[i-1].date?new Date(messages[i-1].date).toLocaleDateString(undefined,{year:'numeric',month:'long',day:'numeric'}):'';return <div key={m.imsgId ?? m.media?.messageId ?? i}>{day&&day!==previous&&<div className="ui-chat-day">{day}</div>}<div className={`ui-chat-row ${m.fromMe?'ui-chat-outgoing':'ui-chat-incoming'}`}><ChatBubble message={m} group={selected.account==='imessage'||selected.id.endsWith('@g.us')} imsgChatId={selected.account==='imessage'?selected.id:undefined} onOpenLink={url=>{void openLink(url);}}/></div></div>;})}</div>:messages.map((m,i)=><article className="ui-message" key={i}><div className="ui-message-head"><strong>{m.sender||'Unknown sender'}</strong><time>{date(m.date)}</time></div>{isMail(selected.account)&&<AttachmentChips account={selected.account} gmailId={m.gmailId} names={m.attachments}/>}{m.html?<MailFrame html={m.html} onOpenLink={url=>{void openLink(url);}}/>:<div className="ui-message-body"><MessageText text={m.text} onOpenLink={url=>{void openLink(url);}}/></div>}{!chat&&(m.media||m.link)?<MessageAttachment media={m.media} link={m.link} onShow={messageId=>rpc.call('media',{account:selected.account,messageId,index:0})} onOpenLink={url=>{void openLink(url);}}/>:null}</article>)}
      </div>
      {threaded?<form className="ui-chat-composer" onSubmit={event=>{event.preventDefault(); void submitComposer();}}><div className="ui-promptbox">{proposal&&proposal.chatId===selected.id?<p className="ui-prompt-preview">{proposal.text}</p>:<textarea id="ui-reply-text" value={text} aria-label={`${accounts[selected.account].label} reply`} onChange={e=>{setText(e.target.value);saveComposerDraft(selected.account,selected.id,e.target.value);}} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault(); void submitComposer();}}} rows={2} placeholder={sendable?'Write a reply…':'Write a draft…'}/>}{proposal&&proposal.chatId===selected.id?<button type="button" className="ui-prompt-cancel" disabled={busy} onClick={()=>void dropProposal()}>Don't send</button>:null}{sendable?<button type="submit" className="ui-prompt-send" disabled={busy||(!proposal&&!text.trim())} aria-label={proposal?'Send this WhatsApp message':'Send'}><Icon name="ArrowUp" aria-hidden="true"/></button>:null}</div>{sendable?null:<p className="ui-notice">Kept as a draft on this machine; this source cannot send from here.</p>}</form>:null}
      {status&&<p role="status" className="ui-notice">{status}</p>}
    </section>:<><div className="ui-list"><header className="ui-mail-bar"><FilterMenu value={filter} onChange={setFilter} /><span className="ui-search-wrap"><input className="ui-search" value={query} onChange={event=>setQuery(event.target.value)} placeholder="Search" aria-label="Search inbox" />{query!==''&&<button type="button" className="ui-search-clear" onClick={()=>setQuery('')} aria-label="Clear the search" title="Clear search"><Icon name="CircleX" aria-hidden="true"/></button>}</span><ItemMenu label="this inbox" busy={refreshingInbox} marker={errors.length?`Some messages couldn't load: ${errors.join(' ')}`:undefined} actions={[
          { label: 'New', run: () => setCompose(!compose) },
          { label: 'Refresh', run: refreshManually, title: refreshTitle },
        ]}/></header>{shown.length===0?<p className="ui-empty">{query.trim()?'No conversations match this search.':filter==='unread'?'No unread messages in this view.':'No conversations in this view.'}</p>:shown.map(i=><div className={`ui-row ${i.unread?'is-unread':''}`} key={`${i.account}:${i.id}`}><div className="ui-row-open"><button type="button" className="ui-row-open-hit" onClick={()=>void open(i)} aria-label={`Open ${i.title||i.preview||'conversation'}`}/><ContactAvatar name={i.account==='whatsapp'||i.account==='imessage'?i.title:(i.sender||'Unknown sender')} account={i.account} participants={i.participants} avatarUrl={i.avatarUrl}/><span className="ui-sr">{accounts[i.account].label}</span><div className="ui-row-copy"><div className="ui-row-top"><strong className="ui-row-name">{i.account==='whatsapp'||i.account==='imessage'?i.title:(i.sender||'Unknown sender')}</strong><span className="ui-row-meta"><time className="ui-row-time">{date(i.date)}</time>{i.account==='linkedin'&&isInvitationId(i.id)&&(canAnswerInvitation(capabilities,i.account)?<InvitationChip item={i} busy={busy} onAnswer={answer}/>:<span className="ui-chip">Invitation</span>)}</span></div><p><span className="ui-row-snippet">{i.preview||'No preview available'}</span></p></div></div><div className="ui-row-side"><div className="ui-row-actions"><ItemMenu label={i.title||i.preview||'this conversation'} busy={busy} actions={[
      { label: 'Add to chat', run: () => tag(i) },
      ...(isConversationRow(i)&&canMarkRead(capabilities,i.account)?[{ label: i.unread?'Mark read':'Mark unread', run: () => void mark(i, i.unread?'read':'unread') }]:[]),
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

const CHAT_THREAD_KEY = 'unified-inbox.chat-thread';
const SPLIT_KEY = 'unified-inbox.split';
function rememberThreadId(id: string) { try { localStorage.setItem(CHAT_THREAD_KEY, id); } catch { /* private browsing */ } }
function storedMailWidth() {
  try {
    const stored = Number(localStorage.getItem(SPLIT_KEY));
    if (Number.isFinite(stored) && stored >= 280 && stored <= 840) return stored;
  } catch { /* private browsing */ }
  return 420;
}
const threadBotResult = z.object({
  botId: z.string().nullable(),
  explicit: z.boolean(),
  detached: z.boolean(),
  bots: z.array(z.object({ id: z.string(), name: z.string(), role: z.string(), hidden: z.boolean() })),
});
const setBotResult = z.object({ ok: z.literal(true), threadIds: z.array(z.string()) });
const donnaBots = z.object({
  bots: z.array(z.object({ id: z.string(), name: z.string(), mainThreadId: z.string().nullable().optional() })),
  threadBindings: z.array(z.object({ threadId: z.string(), botId: z.string() })).optional(),
});

function ThreadBotPicker({ threadId }: { threadId: string }) {
  const sdk = useSdk();
  const [state, setState] = useState<z.infer<typeof threadBotResult> | null>(null);
  const [pending, setPending] = useState(false);
  const [note, setNote] = useState('');
  const load = useCallback(() => sdk.plugins.callRpc({
    pluginId: 'bots-sidebar',
    method: 'thread_bot',
    input: { threadId },
    outputSchema: threadBotResult,
  }).then(setState).catch(() => setState(null)), [sdk, threadId]);
  useEffect(() => { setState(null); setNote(''); void load(); }, [load]);
  if (!state) return null;
  const current = state.bots.find(bot => bot.id === state.botId);
  const shown = state.bots.filter(bot => !bot.hidden || bot.id === state.botId);
  const title = note || (current ? `${current.name}${state.explicit ? '' : ', inherited from the parent conversation'}` : state.detached ? 'Removed from its bot' : 'Not assigned to a bot');
  return <select className="ui-thread-bot" aria-label="Bot for this thread" title={title} disabled={pending} value={state.botId ?? ''} onFocus={() => { void load(); }} onChange={event => {
    const botId = event.target.value || null;
    setPending(true);
    setNote('');
    void sdk.plugins.callRpc({ pluginId: 'bots-sidebar', method: 'conversation_set_bot', input: { threadId, botId }, outputSchema: setBotResult })
      .then(() => load())
      .catch(error => setNote(error instanceof Error ? error.message : 'Could not change the bot'))
      .finally(() => setPending(false));
  }}>
    <option value="">No bot</option>
    {shown.map(bot => <option key={bot.id} value={bot.id}>{bot.name}</option>)}
  </select>;
}

function InboxWorkspace() {
  const sdk = useSdk();
  const navigate = useBbNavigate();
  const [threads, setThreads] = useState<{id:string; title:string}[]>([]);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [chatError, setChatError] = useState('');
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const rows = await sdk.threads.list({ limit: 40 });
        if (!alive) return;
        const sorted = [...rows].sort((a, b) => b.updatedAt - a.updatedAt).map(thread => ({ id: thread.id, title: thread.title || thread.titleFallback || 'Untitled thread' }));
        let donnaId: string | null = null;
        try {
          const listed = await sdk.plugins.callRpc({ pluginId: 'bots-sidebar', method: 'bots_list', input: null, outputSchema: donnaBots });
          const donna = listed.bots.find(bot => bot.name.trim().toLowerCase() === 'donna');
          if (donna) {
            donnaId = donna.mainThreadId ?? null;
            if (!donnaId) {
              const bound = new Set((listed.threadBindings ?? []).filter(row => row.botId === donna.id).map(row => row.threadId));
              donnaId = [...rows].filter(thread => bound.has(thread.id)).sort((a, b) => b.updatedAt - a.updatedAt)[0]?.id ?? null;
            }
          }
        } catch { /* keep the newest thread when Donna cannot be resolved */ }
        if (donnaId && !sorted.some(thread => thread.id === donnaId)) {
          try {
            const thread = await sdk.threads.get({ threadId: donnaId });
            sorted.unshift({ id: thread.id, title: thread.title || thread.titleFallback || 'Donna' });
          } catch { donnaId = null; }
        }
        if (!alive) return;
        setThreads(sorted);
        setThreadId(donnaId ?? sorted[0]?.id ?? null);
      } catch { if (alive) setChatError('Could not load threads.'); }
    })();
    return () => { alive = false; };
  }, [sdk]);
  function choose(id: string) { setThreadId(id); rememberThreadId(id); }
  const [mailWidth, setMailWidth] = useState(storedMailWidth);
  const widthRef = useRef(mailWidth);
  function resize(next: number) {
    const clamped = Math.min(840, Math.max(280, next));
    widthRef.current = clamped;
    setMailWidth(clamped);
  }
  useEffect(() => { if (threadId) void sdk.threads.markRead({ threadId }).catch(() => { /* opening the thread is enough if the read state is already clear */ }); }, [sdk, threadId]);
  return <div className="ui-workspace" style={{ ['--ui-mail-width' as string]: `${mailWidth}px` }}>
    <section className="ui-workspace-chat" aria-label="Thread">
      <header className="ui-workspace-chat-bar">
        <select className="ui-thread-picker" value={threadId ?? ''} onChange={event => choose(event.target.value)} disabled={threads.length === 0} aria-label="Thread shown beside the inbox" title="Choose which thread stays beside the inbox">{threads.length === 0 ? <option value="">No threads yet</option> : threads.map(thread => <option key={thread.id} value={thread.id}>{thread.title}</option>)}</select>
        {threadId && <ThreadBotPicker threadId={threadId} />}
        {threadId && <button type="button" className="ui-thread-open" onClick={() => navigate.toThread(threadId)} aria-label="Open this thread on its own" title="Leave the inbox and open this thread"><Icon name="ArrowUpRight" aria-hidden="true"/></button>}
      </header>
      <div className="ui-workspace-chat-body">
        {chatError ? <p className="ui-empty" role="alert">{chatError}</p> : threadId ? <ThreadChat threadId={threadId} variant="full" layout="contained" /> : <p className="ui-empty">Start a thread to keep the conversation beside the inbox.</p>}
      </div>
    </section>
    <div className="ui-split" role="separator" aria-orientation="vertical" aria-label="Resize inbox" aria-valuenow={mailWidth} aria-valuemin={280} aria-valuemax={840} tabIndex={0} onPointerDown={event => {
      if (event.button !== 0) return;
      const handle = event.currentTarget;
      const startX = event.clientX;
      const startW = widthRef.current;
      handle.setPointerCapture(event.pointerId);
      const move = (ev: PointerEvent) => resize(startW - (ev.clientX - startX));
      const up = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        try { localStorage.setItem(SPLIT_KEY, String(widthRef.current)); } catch { /* private browsing */ }
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
    }} onKeyDown={event => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      resize(widthRef.current + (event.key === 'ArrowLeft' ? 24 : -24));
      try { localStorage.setItem(SPLIT_KEY, String(widthRef.current)); } catch { /* private browsing */ }
    }} />
    <div className="ui-workspace-mail"><Inbox threadId={threadId} /></div>
  </div>;
}
function useInboxBadge(): ExperimentalBadge | null {
  const rpc = useRpc<typeof rpcContract>();
  const [count, setCount] = useState(0);
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        await Promise.all((['whatsapp', 'personal', 'business', 'imessage'] as const).map(account => rpc.call('list_source', { account })));
        const cached = await rpc.call('cached', null);
        if (alive) setCount(cached.items.filter(item => item.unread).length);
      } catch { /* a later refresh can still update the count */ }
    };
    void tick();
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void tick(); }, 20000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [rpc]);
  if (count < 1) return null;
  return { count, label: count === 1 ? '1 unread message' : `${count} unread messages` };
}
export default definePluginApp(app => {
  app.slots.navPanel({ id: 'inbox', title: 'Inbox', icon: 'unified-inbox/inbox', path: 'inbox', component: InboxWorkspace, experimental_useBadge: useInboxBadge });
  app.slots.experimental_tab({ id: 'inbox', title: 'Inbox', icon: 'unified-inbox/inbox', context: { kind: 'thread' }, availability: 'fixed', layout: 'flush', component: Inbox });
});
