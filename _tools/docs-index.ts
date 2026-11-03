// _tools/docs-index.ts — rebuild docs/_index.md from what is on disk.
//
// The index is generated, never hand-edited: it is the one page an agent greps to find a document it does
// not know the name of. Status comes from each file's own frontmatter or metadata block, so the index can
// only say what the files say.
//
//   node --experimental-strip-types _tools/docs-index.ts          writes docs/_index.md
//   node --experimental-strip-types _tools/docs-index.ts --check  exits 1 if the file is stale
//
// Verbatim upstream captures (docs/research/*/sources/) are evidence, not documents: they are counted,
// never listed.

import { readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const OUT = join(ROOT, 'docs/_index.md');
const SHELVES = ['plans', 'research', 'bugs', 'solutions'];

/** Every document the index covers: the shelves, the specs, the decisions, and the two root documents. */
type Doc = { path: string; title: string; description: string; status: string; date: string };

async function walk(dir: string, out: string[] = []): Promise<string[]> {
  for (const entry of await readdir(join(ROOT, dir), { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'sources') continue;
      await walk(path, out);
    } else if (entry.name.endsWith('.md') && !['_index.md', 'CONTEXT.md', 'README.md'].includes(entry.name)) {
      out.push(path);
    }
  }
  return out;
}

const DATE = /\b(\d{4}-\d{2}-\d{2})\b/;

/** Title, description, status and date as the file states them — frontmatter first, then a bold Date line. */
function facts(text: string) {
  const head = text.startsWith('---') ? text.slice(0, text.indexOf('\n---', 3)) : '';
  const title = /^title:\s*"?(.+?)"?\s*$/m.exec(head)?.[1] ?? /^#\s+(.+)$/m.exec(text)?.[1] ?? '';
  const description =
    /^description:\s*"?(.+?)"?\s*$/m.exec(head)?.[1] ??
    /^\*\*Scope:\*\*\s*(.+)$/m.exec(text)?.[1] ??
    '';
  const status =
    /^status:\s*(\S+)/m.exec(head)?.[1] ??
    /^-? ?\*{0,2}Status:\*{0,2}\s*([^\n*]+)/m.exec(text)?.[1]?.trim() ??
    'unstated';
  const date = /^date:\s*(\d{4}-\d{2}-\d{2})/m.exec(head)?.[1] ?? DATE.exec(text)?.[1] ?? '';
  return { title: title.trim(), description: description.trim(), status, date };
}

const clean = (value: string) => value.replace(/\|/g, '/').replace(/\s+/g, ' ').slice(0, 110);

export async function render(): Promise<{ index: string; count: number; captured: number }> {
  const files = [
    'README.md',
    'PLUGIN_OVERVIEW.md',
    ...(await walk('docs')),
    ...(await walk('specs')),
    ...(await walk('decisions')),
  ];

  const rows: Doc[] = [];
  for (const path of files) {
    const text = await readFile(join(ROOT, path), 'utf8');
    const { title, description, status, date } = facts(text);
    rows.push({ path, title: clean(title || path), description: clean(description), status: clean(status), date });
  }

  const sources = (await readdir(join(ROOT, 'docs/research'), { withFileTypes: true }))
    .filter(entry => entry.isDirectory())
    .reduce(async (count: Promise<number>, entry) => {
      const dir = join(ROOT, 'docs/research', entry.name, 'sources');
      return (await count) + (existsSync(dir) ? (await readdir(dir)).length : 0);
    }, Promise.resolve(0) as Promise<number>);
  const captured = await sources;

  const groups: [string, (file: Doc) => boolean][] = [
    ['Current', file => !file.path.startsWith('docs/') && !file.path.startsWith('specs/') && !file.path.startsWith('decisions/')],
    ['Decisions', file => file.path.startsWith('decisions/')],
    ['Specs', file => file.path.startsWith('specs/')],
    ['Plans', file => file.path.startsWith('docs/plans/')],
    ['Research', file => file.path.startsWith('docs/research/')],
    ['Bugs', file => file.path.startsWith('docs/bugs/')],
    ['Solutions', file => file.path.startsWith('docs/solutions/')],
  ];

  const lines = [
    '# docs/_index.md — every document, one page',
    '',
    '**Generated** by `node --experimental-strip-types _tools/docs-index.ts` from the files on disk — do not edit by hand. Status and date',
    'are what each file states about itself. `docs/research/*/sources/` holds ' +
      `${captured} verbatim upstream captures and is not listed here.`,
    '',
    'Which shelf answers which question: `docs/CONTEXT.md`. How to work in this repo: `AGENTS.md`.',
    '',
  ];

  for (const [heading, match] of groups) {
    const set = rows.filter(match).sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '') || a.path.localeCompare(b.path));
    if (!set.length) continue;
    lines.push(`## ${heading}`, '', '| document | status | date | says |', '| --- | --- | --- | --- |');
    for (const row of set) {
      const link = `[\`${row.path}\`](${relative('docs', row.path)})`;
      lines.push(`| ${link} | ${row.status} | ${row.date} | ${row.description} |`);
    }
    lines.push('');
  }

  const index = lines.join('\n');
  return { index, count: rows.length, captured };
}

const invokedDirectly = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (!invokedDirectly) { /* imported by the staleness test */ } else {
const target = process.argv[2];
const { index } = await render();

if (target === '--check') {
  const current = existsSync(OUT) ? await readFile(OUT, 'utf8') : '';
  if (current !== index) {
    console.error('docs/_index.md is stale — run: node _tools/docs-index.ts');
    process.exit(1);
  }
  console.log('docs/_index.md is current');
} else {
  await writeFile(OUT, index);
  console.log(`wrote docs/_index.md (${index.split('\n').length} lines)`);
}
}
