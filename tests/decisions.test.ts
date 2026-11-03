// The ADR folder has a convention (decisions/README.md) and nothing enforced it, so a decision could ship
// without the one line that tells a later reader whether its details still match the code. This is that
// check: the metadata contract, and the README that states it. It reads files as text, like the source-name
// rule in tests/adapters.test.ts, because the contract is a shape, not a runtime behaviour.
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

const DIR = new URL('../decisions/', import.meta.url).pathname;
const DATE = /\b\d{4}-\d{2}-\d{2}\b/;

test('every decision carries the metadata a reader needs, including when it was last verified', async () => {
  const files = (await readdir(DIR)).filter(name => /^\d{4}-.*\.md$/.test(name));
  assert.ok(files.length >= 4, 'the four accepted decisions are present');

  const problems: string[] = [];
  for (const name of files) {
    const text = await readFile(join(DIR, name), 'utf8');
    const number = name.slice(0, 4);
    const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
    const first = body.split('\n').find(line => line.trim() !== '') ?? '';

    // The file's number and its title have to agree, or a link says 0004 and the heading says something else.
    if (!first.startsWith(`# ${number}`)) problems.push(`${name}: title must start with "# ${number}"`);
    if (!/^- \*\*Status:\*\* |^- Status: /m.test(text)) problems.push(`${name}: no Status line`);
    if (!/- \*\*Date:\*\* \d{4}-\d{2}-\d{2}|- Date: \d{4}-\d{2}-\d{2}/.test(text)) problems.push(`${name}: no ISO Date`);
    // The line exists so a rotted detail is visible before it is believed. A decision with no code shape
    // says so in the value; it does not omit the key.
    const verified = /^- \*\*Verified against the code:\*\* (.+)$/m.exec(text)?.[1] ?? '';
    if (!verified) problems.push(`${name}: no "Verified against the code" line`);
    else if (!DATE.test(verified)) problems.push(`${name}: the verified line needs an ISO date`);
  }
  assert.deepEqual(problems, []);
});

test('the folder states the convention, so a new decision is written to a rule and not to taste', async () => {
  const readme = await readFile(join(DIR, 'README.md'), 'utf8');
  for (const rule of ['Verified against the code', 'Supersedes:', 'frozen']) {
    assert.ok(readme.includes(rule), `decisions/README.md must state: ${rule}`);
  }
  assert.ok(readme.includes('PLUGIN_OVERVIEW.md'), 'and it must name the one document that stays current');
});
