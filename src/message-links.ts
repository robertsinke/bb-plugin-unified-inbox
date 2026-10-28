const urlPattern = /https?:\/\/[^\s<>"']+/gi;

function trimUrl(raw: string): { url: string; rest: string } {
  let url = raw;
  let rest = '';
  while (url.length) {
    const last = url.at(-1) ?? '';
    if (!/[),.;:!?\]}>]/.test(last)) break;
    if (last === ')' && (url.match(/\(/g)?.length ?? 0) >= (url.match(/\)/g)?.length ?? 0)) break;
    rest = last + rest;
    url = url.slice(0, -1);
  }
  return { url, rest };
}

export function messageParts(text: string): { kind: 'text' | 'link'; value: string }[] {
  const parts: { kind: 'text' | 'link'; value: string }[] = [];
  let cursor = 0;
  for (const match of text.matchAll(urlPattern)) {
    const start = match.index ?? 0;
    if (start > cursor) parts.push({ kind: 'text', value: text.slice(cursor, start) });
    const { url, rest } = trimUrl(match[0]);
    if (url) parts.push({ kind: 'link', value: url });
    if (rest) parts.push({ kind: 'text', value: rest });
    cursor = start + match[0].length;
  }
  if (cursor < text.length) parts.push({ kind: 'text', value: text.slice(cursor) });
  if (!parts.length) parts.push({ kind: 'text', value: text });
  return parts;
}

type LinkTab = { id: string; kind: string; pluginId?: string; tabId?: string; url?: string; title?: string | null; environmentId?: string | null };

export function browserTabId(token: string) {
  return `browser:${encodeURIComponent(token)}:none`;
}

export function tabsAfterLink<T extends LinkTab>(tabs: readonly T[], url: string, browserId: string): T[] {
  const next = [...tabs];
  if (!next.some(tab => tab.kind === 'plugin-fixed' && tab.pluginId === 'unified-inbox' && tab.tabId === 'inbox')) {
    next.push({ id: 'plugin-fixed:unified-inbox:inbox', kind: 'plugin-fixed', pluginId: 'unified-inbox', tabId: 'inbox' } as T);
  }
  if (!next.some(tab => tab.kind === 'browser' && tab.url === url)) {
    next.push({ id: browserId, kind: 'browser', url, title: null, environmentId: null } as T);
  }
  return next;
}

export function focusedBrowserId(tabs: readonly LinkTab[], url: string, browserId: string) {
  return tabs.find(tab => tab.kind === 'browser' && tab.url === url)?.id ?? browserId;
}

export function panelStateKey(threadId: string) {
  return `bb.thread.fixedPanelTabsState-${encodeURIComponent(threadId)}-1`;
}

export function panelStateFocusedOn(raw: string | null, browserId: string, url: string, now: number) {
  let tabs: unknown[] = [];
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as { secondary?: { tabs?: unknown[] } };
      if (Array.isArray(parsed.secondary?.tabs)) tabs = parsed.secondary.tabs;
    } catch { /* an unreadable record keeps the new browser tab only */ }
  }
  const present = tabs.some(tab => !!tab && typeof tab === 'object' && (tab as { id?: unknown }).id === browserId);
  return {
    version: 1,
    lastUsedAt: now,
    secondary: {
      tabs: present ? tabs : [...tabs, { id: browserId, kind: 'browser', url, title: null, environmentId: null }],
      activeTabId: browserId,
      isOpen: true,
    },
  };
}
