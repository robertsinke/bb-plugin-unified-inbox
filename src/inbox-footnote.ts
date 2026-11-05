// What the conversation list loads before the owner presses anything, in each source's own numbers.
// The sentence used to be written into the panel ("the newest 20 threads per Gmail and Messages
// account"), which went stale the moment Gmail declared a page of ten and Messages declared one at
// all; a source that cannot page is not named here, because it has no page to promise.
import type { Account, SourceMap } from './adapters/types.ts';
import { sourceLabel } from './source-label.ts';

export function loadFootnote(sources: SourceMap | null): string {
  const pages = sources
    ? (Object.keys(sources) as Account[]).flatMap(account => {
      const size = sources[account]?.pageSize;
      return size ? [`${size} ${sourceLabel(sources, account)}`] : [];
    })
    : [];
  if (!pages.length) return '';
  return `The newest page of every source loads first (${pages.join(', ')}), and a source with more says so beside Show older.`;
}
