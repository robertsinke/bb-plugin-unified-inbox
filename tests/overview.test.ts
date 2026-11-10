import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const overview = readFileSync(new URL('../PLUGIN_OVERVIEW.md', import.meta.url), 'utf8');
const language = readFileSync(new URL('../UBIQUITOUS_LANGUAGE.md', import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { bb: { description: string } };

test('the store page is a short buyer description', () => {
  assert.equal(overview.length <= 4000, true);
  assert.equal(overview.split('\n').some(line => line.startsWith('# ')), false);
  assert.equal(overview.split('\n').some(line => line.trim().startsWith('|')), false);
  assert.equal(/<[a-z!/]/i.test(overview), false);
  const links = [...overview.matchAll(/\]\(([^)]+)\)/g)].map(match => match[1]);
  assert.equal(links.every(link => link.startsWith('https://')), true);
  assert.equal(overview.includes('/Users/'), false);
  assert.equal(overview.includes('~/'), false);
  assert.equal(overview.includes('docs/'), false);
  for (const word of ['Gmail', 'WhatsApp', 'Messages', 'LinkedIn', 'Desktop OAuth client', 'Full Disk Access']) {
    assert.equal(overview.includes(word), true, word);
  }
  for (const word of ['Decisions', 'push-notifications', 'Needed', 'None']) {
    assert.equal(overview.includes(word), false, word);
  }
  assert.equal(overview.includes('mute'), true);
  assert.equal(manifest.bb.description.includes('early development'), false);
});

test('the Mute row names the conversation, keeps the row, and does not ask Decisions', () => {
  const row = language.split('\n').find(line => line.includes('**Mute**') && line.includes('|'));
  assert.ok(row, 'the language file has a Mute row');
  assert.equal(row.includes('conversation'), true);
  assert.equal(row.includes('stays in the list'), true);
  assert.equal(row.includes('The Decisions plugin is not asked'), true);
});
