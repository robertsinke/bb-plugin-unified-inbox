// A source says what it is once, in the adapter that knows its own transport: its name, its icon,
// how often the panel polls it, and how many rows an older page is worth. These tests are the ones
// that stop the four hand-kept tables growing back — a label written twice, or a source that
// forgets to say how it is paced, fails here rather than in production.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { registrySources } from '../src/adapters/index.ts';
import { sourceDeclarationSchema } from '../src/adapters/source.ts';
import { accounts } from '../src/adapters/types.ts';
import type { Account } from '../src/adapters/types.ts';
import { harness } from './adapters/harness.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Everything the panel and the gateway are built from: the two entry points, then all of src/. */
function sourceTexts(): { path: string; text: string }[] {
  const files = [
    'server.ts',
    'app.tsx',
    ...readdirSync(join(ROOT, 'src'), { recursive: true, encoding: 'utf8' })
      .filter(name => name.endsWith('.ts') || name.endsWith('.tsx'))
      .map(name => join('src', name)),
  ];
  return files.map(path => ({ path, text: readFileSync(join(ROOT, path), 'utf8') }));
}

test('each source is named in one place: its own declaration', () => {
  const h = harness();
  try {
    const texts = sourceTexts();
    // The files that each held a copy of every source's name while there was no declaration.
    const wasATable = ['server.ts', 'app.tsx', 'src/gateway.ts', 'src/inbox-session.ts', 'src/inbox-mention.ts'];
    for (const account of accounts) {
      const label = h.registry[account].source.label;
      const declared = texts.filter(file => file.text.includes(`label: '${label}'`));
      assert.equal(declared.length, 1, `"${label}" is declared once, in ${declared.map(file => file.path).join(' and ') || 'no file'}`);
      assert.ok(declared[0].path.startsWith('src/adapters/'), `${label} is declared by the adapter that owns the source`);
      for (const table of wasATable) {
        const file = texts.find(candidate => candidate.path === table);
        assert.ok(file, `${table} is still one of the files this scans`);
        // A name is a value in a pair: `personal: 'Personal Gmail'`, `mentionLabels[...] = {…}`. The
        // bare word is not the offence — WhatsApp's own sender fallback is a sender, not a source.
        assert.doesNotMatch(file.text, new RegExp(`:\\s*'${label}'`), `${table} keeps no copy of "${label}"`);
      }
    }
  } finally { h.close(); }
});

test('every source declares a name, an icon and a cadence, and a page size only when it can page', () => {
  const h = harness();
  try {
    assert.deepEqual(Object.keys(registrySources(h.registry)).sort(), [...accounts].sort(), 'the registry hands over one declaration per source');
    // The sources whose `list` takes a cursor back: Gmail's two mailboxes and WhatsApp's offsets.
    const canPage: Account[] = ['personal', 'business', 'whatsapp'];
    for (const account of accounts) {
      const declared = h.registry[account].source;
      assert.ok(declared.label.trim().length > 0, `${account} says what a person calls it`);
      assert.ok(declared.icon.trim().length > 0, `${account} says which icon is drawn beside it`);
      assert.ok(Number.isInteger(declared.pollIntervalMs) && declared.pollIntervalMs > 0, `${account} says how often the panel polls it`);
      if (declared.watchIntervalMs !== undefined) assert.ok(declared.watchIntervalMs > 0, `${account}'s watch cadence is a real interval`);
      if (canPage.includes(account)) {
        assert.ok(Number.isInteger(declared.pageSize) && (declared.pageSize ?? 0) > 0, `${account} pages, so it says how many rows a page is`);
      } else {
        assert.equal(declared.pageSize, undefined, `${account} cannot page, so it declares no page size`);
      }
      assert.equal(sourceDeclarationSchema.safeParse(declared).success, true, `${account}'s declaration is one the gateway can hand the panel`);
    }

    // Two sources may not share a name: a name is how a failure line says whose it is.
    assert.equal(new Set(accounts.map(account => h.registry[account].source.label)).size, accounts.length);

    // And the wire refuses a declaration it would not know what to do with.
    const personal = { ...h.registry.personal.source };
    assert.equal(sourceDeclarationSchema.safeParse({ ...personal, telepathy: true }).success, false, 'an invented field is refused');
    assert.equal(sourceDeclarationSchema.safeParse({ ...personal, pollIntervalMs: 0 }).success, false, 'a cadence of zero is not a cadence');
    assert.equal(sourceDeclarationSchema.safeParse({ ...personal, label: '' }).success, false, 'a nameless source is refused');
  } finally { h.close(); }
});
