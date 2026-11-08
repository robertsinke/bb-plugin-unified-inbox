export type AttentionVerdict = 'yes' | 'no';

/** One word, the same length class as the invitation pill. This file stays free of server imports. */
export function attentionWords(verdict: AttentionVerdict): string {
  return verdict === 'yes' ? 'Needed' : 'None';
}

/** The sentence behind the one-word chip. */
export function attentionTitle(verdict: AttentionVerdict): string {
  return verdict === 'yes' ? 'Needs attention' : 'No attention needed';
}
