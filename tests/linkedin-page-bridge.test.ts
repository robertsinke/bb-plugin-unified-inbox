import assert from 'node:assert/strict';
import test from 'node:test';
import { readLinkedInPage, readRegisteredLinkedInPage, registerLinkedInPage } from '../src/linkedin-page-bridge.ts';

test('registers only BB Browser tabs already on the LinkedIn origin', async () => {
  let expression = '';
  let world = '';
  const page = { evaluate: async (value: string, options?: { world?: string }) => {
    expression = value;
    world = options?.world ?? '';
    return { ok: true, payload: { conversations: [], invitations: [] } };
  } };
  const dispose = registerLinkedInPage('li-tab-a', 'https://www.linkedin.com/feed/', page);
  try {
    assert.deepEqual(await readRegisteredLinkedInPage({ mode: 'list' }), { conversations: [], invitations: [] });
    assert.equal(world, 'isolated');
    assert.match(expression, /messengerConversations/);
  } finally { dispose(); }
  await assert.rejects(readRegisteredLinkedInPage({ mode: 'list' }), /Open LinkedIn in a BB Browser tab/);
});

test('refuses an ambiguous inbox read when multiple LinkedIn tabs are open', async () => {
  const page = { evaluate: async () => ({ ok: true, payload: { conversations: [], invitations: [] } }) };
  const first = registerLinkedInPage('li-tab-1', 'https://www.linkedin.com/feed/', page);
  const second = registerLinkedInPage('li-tab-2', 'https://www.linkedin.com/messaging/', page);
  try { await assert.rejects(readRegisteredLinkedInPage({ mode: 'list' }), /Several LinkedIn tabs are open/); }
  finally { first(); second(); }
});

test('toolbar read uses only its own LinkedIn page and propagates sanitized page errors', async () => {
  const page = { evaluate: async () => ({ ok: false, error: 'LinkedIn 403 for /voyager/api/me' }) };
  await assert.rejects(readLinkedInPage(page, 'https://www.linkedin.com/messaging/', { mode: 'list' }), /LinkedIn 403/);
  await assert.rejects(readLinkedInPage(page, 'https://example.com/', { mode: 'list' }), /Open LinkedIn in a BB Browser tab/);
});
