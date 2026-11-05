import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ATTACHMENT_LIMIT, SAVE_LIMIT } from '../src/adapters/media.ts';
import { savedPayload } from '../src/media-save.ts';

/** One ceiling for what the browser is handed, a second one for what the disk keeps. */
function withDownloads(run: (dir: string) => void): void {
  const downloads = mkdtempSync(join(tmpdir(), 'inbox-downloads-'));
  const before = process.env.UNIFIED_INBOX_DOWNLOADS_DIR;
  process.env.UNIFIED_INBOX_DOWNLOADS_DIR = downloads;
  try {
    run(downloads);
  } finally {
    if (before === undefined) delete process.env.UNIFIED_INBOX_DOWNLOADS_DIR;
    else process.env.UNIFIED_INBOX_DOWNLOADS_DIR = before;
    rmSync(downloads, { recursive: true, force: true });
  }
}

test('a file over the inline ceiling lands in the Downloads folder instead of a data URL', () => {
  withDownloads((downloads) => {
    const bytes = new Uint8Array(ATTACHMENT_LIMIT + 1).fill(7);
    const saved = savedPayload(bytes, { mime: 'text/html', filename: '../../page.html' });
    assert.equal(saved.savedPath, join(downloads, 'page.html'), 'the sender names a file, never a path');
    assert.deepEqual([...readFileSync(saved.savedPath!)], [...bytes], 'and what lands is what was sent');
    assert.equal('dataUrl' in saved, false, 'the bytes are not also carried back through the RPC');
    assert.equal(saved.mime, 'text/html');

    // The owner's folder is not a cache: a second file of the same name sits beside the first.
    assert.equal(savedPayload(bytes, { filename: 'page.html' }).savedPath, join(downloads, 'page (1).html'));

    // Nothing already there is overwritten.
    writeFileSync(join(downloads, 'keep.txt'), 'mine');
    savedPayload(bytes, { filename: 'keep.txt' });
    assert.equal(readFileSync(join(downloads, 'keep.txt'), 'utf8'), 'mine');
    assert.equal(existsSync(join(downloads, 'keep (1).txt')), true);
  });
});

test('a file that fits is still handed over inline, and a runaway download is still refused', () => {
  withDownloads((downloads) => {
    const small = savedPayload(new Uint8Array([1, 2, 3]), { mime: 'application/pdf', filename: 'Contract.pdf' });
    assert.equal(small.dataUrl, 'data:application/pdf;base64,AQID');
    assert.equal(small.savedPath, undefined);
    assert.throws(() => savedPayload(new Uint8Array(SAVE_LIMIT + 1), { filename: 'huge.zip' }), /too large to save/);
    assert.equal(readdirSync(downloads).length, 0, 'a refusal writes nothing');
  });
});
