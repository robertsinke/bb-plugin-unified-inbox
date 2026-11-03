// docs/_index.md is generated, so it can only be trusted while it matches the files on disk. This fails the
// moment a document is added, renamed or re-dated without rebuilding it — the one failure mode a generated
// index has, and the reason it is worth having.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { render } from '../_tools/docs-index.ts';

test('docs/_index.md matches the documents on disk', async () => {
  const { index, count } = await render();
  const current = await readFile(new URL('../docs/_index.md', import.meta.url), 'utf8');
  assert.equal(
    current,
    index,
    `docs/_index.md is stale (${count} documents) — run: node --experimental-strip-types _tools/docs-index.ts`,
  );
});
