const DROPPED = 'script|iframe|object|embed|form|link|meta|base|noscript';

/** Strip active markup before an email is placed in a sandboxed frame. */
export function sanitizeMailMarkup(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(new RegExp(`<(${DROPPED})\\b[^>]*>[\\s\\S]*?<\\/\\1>`, 'gi'), '')
    .replace(new RegExp(`<(${DROPPED})\\b[^>]*\\/?>`, 'gi'), '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s(href|src|action)\s*=\s*(["'])\s*javascript:[\s\S]*?\2/gi, '')
    .replace(/\s(href|src)\s*=\s*(["'])\s*data:(?!image\/)[\s\S]*?\2/gi, '');
}

const DRAWN_MAIL_IMAGE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** A data URL the frame may draw. SVG and every other type stay a chip. */
export function drawnMailImage(dataUrl: string | undefined): string | null {
  if (!dataUrl?.startsWith('data:image/')) return null;
  const mime = dataUrl.slice('data:'.length, dataUrl.indexOf(';')).toLowerCase();
  return DRAWN_MAIL_IMAGE.has(mime) ? dataUrl : null;
}

/** Point `cid:` images at data URLs this message already fetched. Other sources stay as written. */
export function assignCidSources(root: ParentNode, images: Readonly<Record<string, string>>): void {
  for (const image of root.querySelectorAll('img')) {
    const src = image.getAttribute('src') ?? '';
    if (!src.toLowerCase().startsWith('cid:')) continue;
    const id = src.slice(4).replace(/^<|>$/g, '');
    const data = drawnMailImage(images[id]);
    if (data) image.setAttribute('src', data);
  }
}

export function mailDocument(body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><base target="_blank"><style>html,body{margin:0;height:auto!important;min-height:0!important;overflow:visible!important;background:#fff;color:#111;font:14px/1.45 -apple-system,BlinkMacSystemFont,sans-serif}img{max-width:100%;height:auto}a{color:#15c}</style></head><body>${body}</body></html>`;
}
