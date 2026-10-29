type EmailScrollRegion = {
  clientHeight: number;
  scrollHeight: number;
  style: { setProperty(name: string, value: string, priority?: string): void };
};

type EmailOverflow = { overflow?: string; overflowY?: string };

/** Remove independently scrolling regions from email markup so its content joins the parent document flow. */
export function expandEmailScrollRegions<T extends EmailScrollRegion>(
  elements: Iterable<T>,
  getOverflow: (element: T) => EmailOverflow,
): number {
  let expanded = 0;
  for (const element of elements) {
    const overflow = getOverflow(element);
    if (!['auto', 'scroll', 'overlay'].includes(overflow.overflowY || overflow.overflow || '')) continue;
    element.style.setProperty('overflow', 'visible', 'important');
    element.style.setProperty('height', 'auto', 'important');
    element.style.setProperty('max-height', 'none', 'important');
    expanded++;
  }
  return expanded;
}
