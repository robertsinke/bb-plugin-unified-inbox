// A file the panel will not hand to the browser inline is written to the owner's Downloads folder and
// answered with where it went. Server side only: this needs the disk, and `adapters/media.ts` is reached
// by the panel bundle, which cannot see it.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { ATTACHMENT_LIMIT, SAVE_LIMIT, attachmentMime, attachmentPayload } from './adapters/media.ts';
import type { MediaPayload } from './adapters/types.ts';

/** Where a file too large to hand to the browser lands: the owner's Downloads, never the plugin's data dir. */
function downloadsDir(): string {
  return process.env.UNIFIED_INBOX_DOWNLOADS_DIR || join(homedir(), 'Downloads');
}

/** A sender names the file, so it is taken as a name only: no path, no overlong name, never a traversal. */
function safeName(filename: string): string {
  return basename(String(filename).replaceAll('\\', '/')).slice(0, 200) || 'Attachment';
}

/** Writes beside what is already there rather than over it: the owner's folder is not a cache. */
function saveToDownloads(bytes: Uint8Array, filename: string): string {
  const dir = downloadsDir();
  mkdirSync(dir, { recursive: true });
  const extension = extname(filename);
  const stem = basename(filename, extension);
  let path = join(dir, filename);
  for (let copy = 1; existsSync(path); copy += 1) path = join(dir, `${stem} (${copy})${extension}`);
  writeFileSync(path, bytes, { mode: 0o600 });
  return path;
}

/**
 * The one answer for a file the panel is asked to save: inline up to the attachment ceiling, and written
 * to the Downloads folder above it. Shared by Gmail attachments and WhatsApp documents, so a file cannot
 * arrive through the looser of two paths.
 */
export function savedPayload(
  bytes: Uint8Array,
  options: { mime?: string; filename: string },
): MediaPayload {
  // A sender chooses its size, so there is still a bound — but it exists to stop a runaway download.
  if (bytes.byteLength > SAVE_LIMIT) throw new Error('This attachment is too large to save.');
  if (bytes.byteLength <= ATTACHMENT_LIMIT) return attachmentPayload(bytes, options);
  const filename = safeName(options.filename);
  return { savedPath: saveToDownloads(bytes, filename), mime: attachmentMime(options.mime), filename, size: bytes.byteLength };
}
