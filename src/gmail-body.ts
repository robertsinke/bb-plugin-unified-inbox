type MimePart = {
  mimeType?: string;
  filename?: string;
  body?: { data?: string; attachmentId?: string; size?: number };
  parts?: MimePart[];
};

export type GmailBodies = { text: string; html: string; htmlAttachmentId?: string; htmlAttachmentSize?: number };

/** First text/plain and text/html parts. HTML stored only as an attachment id is reported separately. */
export function pickGmailBodies(payload: MimePart | undefined): GmailBodies {
  let text = '';
  let html = '';
  let htmlAttachmentId: string | undefined;
  let htmlAttachmentSize: number | undefined;
  const walk = (node: MimePart | undefined) => {
    if (!node) return;
    const type = node.mimeType || '';
    const data = node.body?.data;
    if (!text && type === 'text/plain' && data) text = Buffer.from(data, 'base64url').toString('utf8');
    if (type === 'text/html' && !html) {
      if (data) html = Buffer.from(data, 'base64url').toString('utf8');
      else if (!htmlAttachmentId && node.body?.attachmentId) {
        htmlAttachmentId = node.body.attachmentId;
        if (typeof node.body.size === 'number') htmlAttachmentSize = node.body.size;
      }
    }
    for (const part of node.parts ?? []) walk(part);
  };
  walk(payload);
  return { text, html, ...(htmlAttachmentId ? { htmlAttachmentId, ...(htmlAttachmentSize !== undefined ? { htmlAttachmentSize } : {}) } : {}) };
}
