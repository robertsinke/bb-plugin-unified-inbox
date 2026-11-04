// A `current`-status document is one an agent is meant to trust, so its pointers must still point. Three
// kinds, all mechanical: a path (must exist), a commit sha (must resolve), and a snake_case identifier (must
// appear somewhere in the code). The last one is what caught `linkin_replay`, a method name that looks right
// and does not exist.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import test from 'node:test';
import { CLI_BUDGET_MS } from './cli-budget.ts';

const repo = new URL('..', import.meta.url).pathname;
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', timeout: CLI_BUDGET_MS });
const tracked = git('ls-files').split('\n').filter(Boolean);
const current = tracked.filter(f => f.endsWith('.md') && /^status: current/m.test(readFileSync(repo + f, 'utf8')));
const code = ['src', 'tests', 'server.ts', 'app.tsx']
  .flatMap(p => tracked.filter(f => f.startsWith(p + '/') || f === p))
  .filter(f => /\.(ts|tsx|css)$/.test(f))
  .map(f => readFileSync(repo + f, 'utf8'))
  .join('\n');

// Ids that are BB's, not this repo's: threads, projects, automations, tracker keys.
const FOREIGN = /^(thr|proj|env|auto|arun|msg|run|host|INBOX|OQ)_/;

test('every pointer in a current document resolves', () => {
  assert.ok(current.length >= 2, `expected current-status documents, found ${current.length}`);
  const problems: string[] = [];

  for (const file of current) {
    const text = readFileSync(repo + file, 'utf8');

    for (const [, path] of text.matchAll(/`([\w./-]+\.(?:ts|tsx|md|json|sql|css))`/g)) {
      if (!existsSync(repo + path) && !tracked.some(f => f.endsWith('/' + path))) problems.push(`${file}: no such path \`${path}\``);
    }

    for (const [, sha] of text.matchAll(/`([0-9a-f]{7})`/g)) {
      try {
        git('cat-file', '-e', `${sha}^{commit}`);
      } catch {
        problems.push(`${file}: no such commit \`${sha}\``);
      }
      }

    for (const [, id] of text.matchAll(/`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`/g)) {
      if (!FOREIGN.test(id) && !code.includes(id) && !basename(file).includes(id)) problems.push(`${file}: \`${id}\` appears nowhere in the code`);
    }
  }

  assert.deepEqual(problems, [], problems.join('\n'));
});
