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
  if (!error.account) return error.message;
  const label = sourceLabel(sources, error.account);
  // A failure read back from the cache keeps the sentence the source wrote, and a source may open
  // that sentence with its own name ("LinkedIn did not answer in time."). The name goes in once, so
  // no line reads "LinkedIn LinkedIn did not answer in time.".
  return error.message.startsWith(`${label} `) ? error.message : `${label} ${error.message}`;
}

export function InboxErrors({ errors, sources }: { errors: readonly InboxError[]; sources: SourceMap | null }) {
  if (!errors.length) return null;
  return (
    <div className="ui-errors" role="status">
      {errors.map((error, index) => <p key={index}>{errorLine(error, sources)}</p>)}
    </div>
  );
}
