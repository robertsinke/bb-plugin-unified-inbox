// The failures the list holds, as the owner reads them: one line per failure, each named by the
// source that owned it. The session keeps `{ account, message }` apart so clearing one source's
// line is a lookup; this is where the two become a sentence again.
import type { SourceMap } from './adapters/types.ts';
import type { InboxError } from './inbox-session.ts';
import { sourceLabel } from './source-label.ts';

/**
 * One failure in words. A line with an account reads "{source} {message}" — its message is the verb
 * phrase that follows the subject ("could not refresh. …"). A failure no single source owns is a
 * whole sentence of its own.
 */
export function errorLine(error: InboxError, sources: SourceMap | null): string {
  return error.account ? `${sourceLabel(sources, error.account)} ${error.message}` : error.message;
}

export function InboxErrors({ errors, sources }: { errors: readonly InboxError[]; sources: SourceMap | null }) {
  if (!errors.length) return null;
  return (
    <div className="ui-errors" role="status">
      {errors.map((error, index) => <p key={index}>{errorLine(error, sources)}</p>)}
    </div>
  );
}
