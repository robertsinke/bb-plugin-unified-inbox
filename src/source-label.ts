// The panel's one reading of a source's declared name. The declarations arrive over `sources`
// (src/adapters/source.ts holds their schema); this module is what app.tsx and the error line use,
// so no copy of the names lives on the panel side. Type-only import: nothing from src/adapters is
// loaded at runtime here.
import type { Account, SourceMap } from './adapters/types.ts';

/**
 * The name a person knows a source by, as that source declared it. A source whose declaration
 * never arrived is named by its account key rather than by a name invented here — a third spelling
 * is worse than an obvious placeholder.
 */
export function sourceLabel(sources: SourceMap | null, account: Account): string {
  return sources?.[account]?.label ?? account;
}
