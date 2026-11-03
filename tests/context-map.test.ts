// src/CONTEXT.md claims to be a map, and a map with a dead link is worse than no map: a reader follows it,
// finds nothing, and concludes the map is out of date. So every path it names must exist — the map can be
// wrong about *behaviour* (that is a code review's job) but it cannot rot silently when a file is renamed or
// deleted.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('every path named in src/CONTEXT.md exists', async () => {
  const map = await read('src/CONTEXT.md');
  const paths = new Set(
    [...map.matchAll(/`((?:src|tests|decisions|_tools)\/[^`]+)`/g)].map(m => m[1]).filter(p => /\.[a-z]+$/.test(p)),
  );
  assert.ok(paths.size > 8, `expected the map to name its modules, found ${paths.size}`);
  for (const path of paths) {
    assert.ok(existsSync(new URL(`../${path}`, import.meta.url)), `${path} is named in src/CONTEXT.md but does not exist`);
  }
});

test('the root entry file points at the code map', async () => {
  const agents = await read('AGENTS.md');
  assert.match(agents, /src\/CONTEXT\.md/, 'AGENTS.md must route a reader to src/CONTEXT.md');
  assert.match(agents, /docs\/_index\.md/, 'AGENTS.md must route a reader to the generated index');
});
