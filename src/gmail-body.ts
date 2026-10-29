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

/** Attachment filenames only; never reads or stores the file bodies. */
export function pickGmailAttachments(payload: MimePart | undefined): string[] {
  const names: string[] = [];
  const walk = (node: MimePart | undefined) => {
    if (!node) return;
    const filename = String(node.filename || '').trim().replace(/\s+/g, ' ');
    if (filename && !names.includes(filename) && names.length < 20) names.push(filename.slice(0, 255));
    for (const part of node.parts ?? []) walk(part);
  };
  walk(payload);
  return names;
}

export type GmailAttachmentPart = { attachmentId?: string; data?: string; mimeType: string; filename: string; size?: number };

/** Finds one attachment by its normalized filename, without reading the file. */
export function findGmailAttachment(payload: MimePart | undefined, filename: string): GmailAttachmentPart | undefined {
  const wanted = filename.trim().replace(/\s+/g, ' ');
  let found: GmailAttachmentPart | undefined;
  const walk = (node: MimePart | undefined) => {
    if (!node || found) return;
    const name = String(node.filename || '').trim().replace(/\s+/g, ' ');
    if (name && name === wanted && (node.body?.attachmentId || node.body?.data)) {
      found = {
        ...(node.body?.attachmentId ? { attachmentId: node.body.attachmentId } : {}),
        ...(node.body?.data ? { data: node.body.data } : {}),
        mimeType: String(node.mimeType || 'application/octet-stream'),
        filename: name,
        ...(typeof node.body?.size === 'number' ? { size: node.body.size } : {}),
      };
      return;
    }
    for (const part of node.parts ?? []) walk(part);
  };
  walk(payload);
  return found;
}
