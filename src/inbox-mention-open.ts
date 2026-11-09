import { mentionOpenTarget } from './inbox-mention.ts';

/** The host dispatches this when a plugin mention pill is clicked. */
export const PLUGIN_MENTION_OPEN_EVENT = 'bb:plugin-mention-open';

export type PluginMentionOpenDetail = {
  pluginId: string;
  itemId: string;
  label: string;
};

export type InboxMentionOpen = {
  account: string;
  id: string;
  label: string;
};

const PLUGIN_ID = 'unified-inbox';
const STASH = '__bbPluginMentionOpen';

let pending: InboxMentionOpen | null = null;
const listeners = new Set<(target: InboxMentionOpen) => void>();
let installed = false;

export function pluginMentionOpenDetail(resource: {
  kind: string;
  pluginId?: string;
  label?: string;
  itemId?: string;
  provider?: string;
  id?: string;
}): PluginMentionOpenDetail | null {
  if (resource.kind !== 'plugin' || !resource.pluginId) return null;
  const itemId = resource.itemId
    ?? (resource.provider && resource.id ? `${resource.provider}:${resource.id}` : null);
  if (!itemId) return null;
  return { pluginId: resource.pluginId, itemId, label: resource.label ?? '' };
}

/** Keep the click until the inbox panel is on screen, then hand it over. */
export function noteInboxMentionOpen(detail: PluginMentionOpenDetail): InboxMentionOpen | null {
  if (detail.pluginId !== PLUGIN_ID) return null;
  const target = mentionOpenTarget(detail.itemId);
  if (!target) return null;
  const next = { ...target, label: detail.label };
  if (listeners.size === 0) {
    pending = next;
    return next;
  }
  pending = null;
  for (const listener of listeners) listener(next);
  return next;
}

export function takeInboxMentionOpen(): InboxMentionOpen | null {
  const current = pending;
  pending = null;
  return current;
}

export function subscribeInboxMentionOpen(listener: (target: InboxMentionOpen) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** A pill carries the mention resource even when the host draws it as plain text. */
export function inboxMentionFromResourceAttribute(raw: string | null): PluginMentionOpenDetail | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const record = parsed as { kind?: unknown; pluginId?: unknown; itemId?: unknown; label?: unknown };
  if (record.kind !== 'plugin' || record.pluginId !== PLUGIN_ID || typeof record.itemId !== 'string') return null;
  if (!mentionOpenTarget(record.itemId)) return null;
  return {
    pluginId: PLUGIN_ID,
    itemId: record.itemId,
    label: typeof record.label === 'string' ? record.label : '',
  };
}

function revealInboxTab(): void {
  document.querySelector<HTMLElement>('[aria-label="Show inbox panel"]')?.click();
}

function inboxMentionFromClick(event: MouseEvent): PluginMentionOpenDetail | null {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return null;
  const target = event.target;
  if (!(target instanceof Element)) return null;
  const pill = target.closest('[data-prompt-mention="true"]');
  if (!pill) return null;
  const selection = window.getSelection();
  if (selection && !selection.isCollapsed && selection.anchorNode && pill.contains(selection.anchorNode)) return null;
  return inboxMentionFromResourceAttribute(pill.getAttribute('data-prompt-mention-resource'));
}

function hostStash(): PluginMentionOpenDetail | null {
  if (typeof window === 'undefined') return null;
  const detail = (window as Window & { [STASH]?: PluginMentionOpenDetail })[STASH];
  delete (window as Window & { [STASH]?: PluginMentionOpenDetail })[STASH];
  if (!detail || typeof detail.pluginId !== 'string' || typeof detail.itemId !== 'string') return null;
  return { pluginId: detail.pluginId, itemId: detail.itemId, label: typeof detail.label === 'string' ? detail.label : '' };
}

type WindowHandlers = Window & {
  [STASH]?: PluginMentionOpenDetail;
  __bbInboxMentionClick?: (event: MouseEvent) => void;
  __bbInboxMentionEvent?: (event: Event) => void;
};

export function installInboxMentionOpenListener(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  const host = window as WindowHandlers;
  if (host.__bbInboxMentionEvent) window.removeEventListener(PLUGIN_MENTION_OPEN_EVENT, host.__bbInboxMentionEvent);
  if (host.__bbInboxMentionClick) window.removeEventListener('click', host.__bbInboxMentionClick);
  host.__bbInboxMentionEvent = (event: Event) => {
    const detail = (event as CustomEvent<PluginMentionOpenDetail>).detail;
    if (!detail || typeof detail.pluginId !== 'string' || typeof detail.itemId !== 'string') return;
    delete host[STASH];
    noteInboxMentionOpen({ pluginId: detail.pluginId, itemId: detail.itemId, label: typeof detail.label === 'string' ? detail.label : '' });
  };
  host.__bbInboxMentionClick = (event: MouseEvent) => {
    const detail = inboxMentionFromClick(event);
    if (!detail) return;
    const shown = listeners.size > 0;
    noteInboxMentionOpen(detail);
    if (!shown) revealInboxTab();
  };
  window.addEventListener(PLUGIN_MENTION_OPEN_EVENT, host.__bbInboxMentionEvent);
  window.addEventListener('click', host.__bbInboxMentionClick);
  const waiting = hostStash();
  if (waiting) noteInboxMentionOpen(waiting);
}
