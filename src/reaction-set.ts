// The only copy of the shared reactions. Adapters and the panel import this list.
// Emphasis (‼️) and question (❓) are not on it: a send of either is refused.

export const REACTION_SET = [
  { label: 'heart', emoji: '❤️' },
  { label: 'like', emoji: '👍' },
  { label: 'dislike', emoji: '👎' },
  { label: 'laugh', emoji: '😂' },
] as const;

export type ReactionLabel = (typeof REACTION_SET)[number]['label'];
export type ReactionEmoji = (typeof REACTION_SET)[number]['emoji'];

export function isReactionEmoji(value: unknown): value is ReactionEmoji {
  return typeof value === 'string' && REACTION_SET.some(item => item.emoji === value);
}
