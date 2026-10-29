import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';

export const IMSG_IMAGE_LIMIT = 6 * 1024 * 1024;
const imageTypes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export function isImsgImage(mime: unknown): mime is string {
  return typeof mime === 'string' && imageTypes.has(mime.toLowerCase());
}

function matchesImage(bytes: Buffer, mime: string) {
  if (mime === 'image/png') return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mime === 'image/jpeg') return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mime === 'image/gif') return ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'));
  return mime === 'image/webp' && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
}

// Only paths from a freshly fetched Messages history record are passed here.
// The RPC caller never supplies a path. Resolve the real path before opening and
// refuse symlink escapes, non-regular files, oversized files and active formats.
export async function readImsgImage(filename: string, mime: string, root = join(homedir(), 'Library/Messages/Attachments')) {
  if (!isImsgImage(mime)) throw new Error('This attachment type cannot be displayed here.');
  const normalizedMime = mime.toLowerCase();
  const path = filename.startsWith('~/') ? join(homedir(), filename.slice(2)) : filename;
  if (!isAbsolute(path)) throw new Error('This attachment is unavailable.');
  let file;
  try {
    const [base, resolved] = await Promise.all([realpath(root), realpath(path)]);
    const rel = relative(base, resolved);
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Outside attachment directory');
    file = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await file.stat();
    if (!stat.isFile() || stat.size <= 0 || stat.size > IMSG_IMAGE_LIMIT) throw new Error('Invalid attachment size');
    const bytes = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!result.bytesRead) break;
      offset += result.bytesRead;
    }
    if (offset !== stat.size || !matchesImage(bytes.subarray(0, offset), normalizedMime)) throw new Error('Invalid attachment content');
    return { dataUrl: `data:${normalizedMime};base64,${bytes.subarray(0, offset).toString('base64')}`, mime: normalizedMime };
  } catch {
    throw new Error('This attachment is unavailable or cannot be displayed safely.');
  } finally {
    await file?.close();
  }
}
