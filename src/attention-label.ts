export type AttentionVerdict = 'yes' | 'no' | 'unsettled';

/** One word, the same length class as the invitation pill. This file stays free of server imports. */
export function attentionWords(verdict: AttentionVerdict): string {
  if (verdict === 'yes') return 'Needed';
  if (verdict === 'no') return 'None';
  return 'Unclear';
}

/** The sentence behind the one-word chip. */
export function attentionTitle(verdict: AttentionVerdict): string {
  if (verdict === 'yes') return 'Needs attention';
  if (verdict === 'no') return 'No attention needed';
  return 'Attention is not clear';
}
