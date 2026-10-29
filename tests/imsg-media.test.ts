import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { IMSG_IMAGE_LIMIT, readImsgImage } from '../src/imsg-media.ts';

test('only reads bounded, matching images inside the attachment root', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'imsg-media-test-'));
  const root = join(dir, 'attachments');
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
  try {
    await mkdir(root);
    await writeFile(join(root, 'photo'), png);
    await writeFile(join(dir, 'secret'), png);
    await symlink(join(dir, 'secret'), join(root, 'escape'));
    await writeFile(join(root, 'large'), Buffer.alloc(IMSG_IMAGE_LIMIT + 1));
    assert.equal((await readImsgImage(join(root, 'photo'), 'image/png', root)).dataUrl, `data:image/png;base64,${png.toString('base64')}`);
    for (const [path, mime] of [[join(dir, 'secret'), 'image/png'], [join(root, 'escape'), 'image/png'], [join(root, 'large'), 'image/png'], [join(root, 'photo'), 'image/jpeg'], [join(root, 'photo'), 'image/svg+xml'], [root, 'image/png'], ['relative', 'image/png']]) {
      await assert.rejects(readImsgImage(path, mime, root));
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
