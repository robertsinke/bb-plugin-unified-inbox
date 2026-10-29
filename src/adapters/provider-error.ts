// ProviderError normalization (Migration state 1, task T2).
// The rule: a ProviderError message carries a fixed template, the failure
// code, and a safe hint classification — never raw provider stderr/stdout.
// Any text that does pass through (exception messages) is scrubbed of
// credential-shaped substrings first.
import type { Account, ProviderError } from './types.ts';

/** Maximum length of a redacted ProviderError message (see types.ts). */
const MESSAGE_LIMIT = 300;

/**
 * Words that classify a provider failure without leaking payload. Mirrors and
 * extends the gws hint list in server.ts gmail(); all entries are lowercase.
 */
const SAFE_HINTS = [
  'broken pipe',
  'credentials',
  'denied',
  'discovery',
  'expired',
  'interaction',
  'invalid',
  'keychain',
  'keyring',
  'locked',
  'no such file',
  'not found',
  'panic',
  'resource temporarily unavailable',
  'timeout',
  'token',
  'unauthorized',
  'unavailable',
] as const;

/** Labeled secrets: `Authorization: Bearer …`, `password=hunter2…`, `"key": "…"`. */
const LABELED_SECRET = /\b(?:authorization|bearer|key|password|secret|token)\b["']?\s*[:=]?\s*["']?([^\s"',;]+)/gi;
/** Google OAuth access-token prefixes. */
const OAUTH_TOKEN = /\bya29\.[A-Za-z0-9._-]+/g;
/** JWTs and other long opaque runs (session keys, base64 blobs). */
const OPAQUE_RUN = /[A-Za-z0-9+/_=-]{24,}/g;

/**
 * Scrub credential-shaped substrings from arbitrary text: labeled secrets,
 * `ya29.`/`eyJ`-style tokens, and opaque runs of 24+ characters. Keeps codes,
 * hint words, and structure; collapses whitespace; truncates to 300 characters.
 */
export function redactProviderText(input: string): string {
  const scrubbed = input
    .replace(LABELED_SECRET, (match, _value, offset: number) => {
      const label = match.slice(0, match.length - _value.length);
      return `${label.trim()}[redacted]`;
    })
    .replace(OAUTH_TOKEN, '[redacted]')
    .replace(OPAQUE_RUN, (run: string) => (run.startsWith('[redacted]') ? run : '[redacted]'));
  return scrubbed.replace(/\s+/g, ' ').trim().slice(0, MESSAGE_LIMIT);
}

/** Lowercase hint words present anywhere in the diagnostic text, deduped and sorted. */
function classify(diagnostic: string): string[] {
  const lower = diagnostic.toLowerCase();
  return [...new Set(SAFE_HINTS.filter(hint => lower.includes(hint)))].sort();
}

/** Failure code from an exec/system error, mirroring gmail()'s code handling. */
function errorCode(cause: unknown): string {
  const error = cause as NodeJS.ErrnoException;
  if (error && (typeof error.code === 'string' || typeof error.code === 'number')) return String(error.code);
  return 'unknown';
}

/**
 * Normalize any thrown cause into a safe ProviderError. The message is
 * synthesized: `<source> <account> request failed (<code>[; <hints>])[<detail>]`.
 * - code: the exception's system/exec code, else `unknown`.
 * - hints: SAFE_HINTS words found in stderr/stdout/cause text — classification only.
 * - detail: the redacted first line of the cause text (Error message or string), when present.
 * Raw stderr/stdout never enter the message; if an exception message must
 * survive, redactProviderText scrubs it first.
 */
export function toProviderError(account: Account, source: ProviderError['source'], cause: unknown): ProviderError {
  const error = cause as NodeJS.ErrnoException & { stderr?: string; stdout?: string };
  const causeText = error instanceof Error ? error.message : typeof cause === 'string' ? cause : '';
  const diagnostic = `${error?.stderr ?? ''} ${error?.stdout ?? ''} ${causeText}`;
  const hints = classify(diagnostic);
  const code = errorCode(cause);
  const template = `${source} ${account} request failed (${code}${hints.length > 0 ? `; ${hints.join(', ')}` : ''})`;
  const rawDetail = causeText;
  const detail = rawDetail ? redactProviderText(rawDetail.split('\n')[0] ?? '') : '';
  const message = detail && detail !== template ? `${template}: ${detail}`.slice(0, MESSAGE_LIMIT) : template.slice(0, MESSAGE_LIMIT);
  return { account, source, message };
}