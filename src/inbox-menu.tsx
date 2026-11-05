// The ⋯ control every row and the inbox header share. It is one button that opens its list under
// the cursor, or under keyboard focus, and the list is that surface's whole vocabulary: a source
// that cannot do something simply never contributes an entry.
//
// The header's list also carries what the list is narrowed to. That is a group rather than an
// action — choosing one changes what the list shows, it does not act on a conversation — so it is
// marked off from the actions below it and named to assistive technology as a group.
import type { ReactNode } from 'react';
import { experimental_Icon as Icon } from '@get-bb/plugin-sdk/app';

import type { Account, SourceMap } from './adapters/types.ts';
import type { InboxFilter } from './inbox-session.ts';
import { sourceLabel } from './source-label.ts';

export type MenuAction = {
  label: string;
  run: () => void;
  title?: string;
  disabled?: boolean;
  /** The entry is the current choice of its group — the active filter. */
  pressed?: boolean;
  icon?: ReactNode;
};

/** Entries that are one choice among several, set apart from the actions that follow them. */
export type MenuGroup = { heading: string; actions: MenuAction[] };

/** What the list is narrowed to, in the words both the trigger and the entries use. */
export function filterLabel(sources: SourceMap | null, filter: InboxFilter): string {
  return filter === 'all' ? 'all conversations' : filter === 'unread' ? 'unread' : sourceLabel(sources, filter);
}

/** The filter entries, in one fixed order: everything, the unread, then each source as it declares itself. */
export const FILTER_ORDER: readonly Account[] = ['whatsapp', 'gmail-personal', 'gmail-business', 'imessage', 'linkedin'];

export function filterActions({ filter, onFilter, sources, sourceIcon }: {
  filter: InboxFilter;
  onFilter: (next: InboxFilter) => void;
  sources: SourceMap | null;
  /** A source's own mark; the panel owns that drawing, not this menu. */
  sourceIcon: (account: Account) => ReactNode;
}): MenuAction[] {
  return [
    { label: 'All', icon: <Icon name="LayoutList" aria-hidden="true" />, pressed: filter === 'all', run: () => onFilter('all') },
    { label: 'Unread', icon: <Icon name="Mail" aria-hidden="true" />, pressed: filter === 'unread', run: () => onFilter('unread') },
    ...FILTER_ORDER.map(account => ({
      label: sourceLabel(sources, account),
      icon: sourceIcon(account),
      pressed: filter === account,
      run: () => onFilter(account),
    })),
  ];
}

/**
 * What the trigger says. The control is the inbox's, so it is named for the inbox rather than for
 * one action, and a narrowed list says so in the name — otherwise the filter it now holds would
 * only be discoverable by opening the menu.
 */
export function menuTrigger(sources: SourceMap | null, filter: InboxFilter, extra = ''): { label: string; marker?: string } {
  const narrowed = filter === 'all' ? '' : `filtered to ${filterLabel(sources, filter)}`;
  return {
    label: narrowed ? `this inbox, ${narrowed}` : 'this inbox',
    marker: [narrowed, extra].filter(Boolean).join(' · ') || undefined,
  };
}

export function ItemMenu({ label, actions, group, marker }: {
  label: string;
  actions: MenuAction[];
  group?: MenuGroup;
  /** A sentence the trigger carries as a dot, for state worth seeing without opening the list. */
  marker?: string;
}) {
  return <span className="ui-menu">
    <button type="button" className="ui-icon-button" aria-haspopup="menu" aria-label={`More actions for ${label}`} title={marker ?? 'More actions'}><Icon name="MoreHorizontal" aria-hidden="true" /></button>
    {marker && <span className="ui-menu-marker" aria-hidden="true" />}
    <span className="ui-menu-list" role="menu" aria-label={`Actions for ${label}`}>
      {group && <>
        <span className="ui-menu-group" role="group" aria-label={group.heading}>
          {group.actions.map(action => <MenuItem key={action.label} action={action} />)}
        </span>
        <span className="ui-menu-sep" role="separator" />
      </>}
      {/* The menu stays usable while the inbox refreshes: that heartbeat runs every few seconds, so
          a menu disabled by it is a menu the owner can almost never open. Actions that must not run
          mid-flight say so themselves — the session guards `mark` on `busy`, and `refresh` skips a
          source it is already reading. */}
      {actions.map(action => <MenuItem key={action.label} action={action} />)}
    </span>
  </span>;
}

function MenuItem({ action }: { action: MenuAction }) {
  return <button
    type="button"
    role="menuitem"
    className="ui-menu-item"
    disabled={action.disabled === true}
    title={action.title}
    aria-pressed={action.pressed}
    onClick={event => { event.stopPropagation(); action.run(); }}
  >{action.icon}{action.label}</button>;
}
