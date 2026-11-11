/** A rectangle in viewport coordinates. */
export type BarBox = { top: number; right: number; bottom: number; left: number };

/**
 * Where the reaction bar sits, relative to the bubble.
 * It stays inside the thread pane. It prefers the top edge of the bubble, overlapping
 * that edge so the pointer can reach it, and moves fully inside when the top is clipped.
 */
export function reactionBarPosition(input: {
  bubble: BarBox;
  view: BarBox;
  bar: { width: number; height: number };
}): { top: number; left: number } {
  const gap = 4;
  const overlap = 8;
  const { bubble, view, bar } = input;
  const above = bubble.top - bar.height + overlap;
  const aboveFits = above >= view.top + gap && above + bar.height <= view.bottom - gap;
  let top = above;
  if (!aboveFits) {
    top = Math.max(bubble.top, view.top) + gap;
    const limit = view.bottom - gap - bar.height;
    if (top > limit) top = limit;
  }
  const minLeft = view.left + gap;
  const maxLeft = Math.max(minLeft, view.right - gap - bar.width);
  const centered = (bubble.left + bubble.right) / 2 - bar.width / 2;
  const left = Math.min(Math.max(centered, minLeft), maxLeft);
  return { top: top - bubble.top, left: left - bubble.left };
}
