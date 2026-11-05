import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakePluginHost, makePluginAgentConfigurationContext } from '@get-bb/plugin-sdk/testing';
import { registerInboxAgentTools } from '../src/inbox-agent-tools.ts';
import type { MessageMedia } from '../src/adapters/types.ts';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jG3sAAAAASUVORK5CYII=';

function fixture() {
  const { bb, harness } = createFakePluginHost({ pluginId: 'unified-inbox' });
  const messages = [
    { sender: 'Contact', text: 'Pickup information', date: 100, media: { kind: 'image', messageId: 'photo-1', available: true, cached: true } as MessageMedia },
    { sender: 'Contact', text: 'x'.repeat(21_000), date: 200, html: '<p>private HTML</p>', gmailId: 'mail-1', attachments: ['photo.png'] },
    { sender: 'Contact', text: '', date: 300, imsgId: '42', imsgAttachments: [{ index: 0, name: 'photo.png', available: true }] },
  ];
  let loads = 0;
  let opens = 0;
  let payload = { dataUrl: `data:image/png;base64,${png}`, mime: 'image/png' };
  const fresh = { lastAttemptAt: 100, lastSuccessAt: 100, lastError: null, cacheFallback: false };
  const gateway = {
    cached: () => ({
      items: [{ account: 'whatsapp' as const, id: 'chat-1', title: 'Contact', preview: 'Pickup information', date: 100, unread: true, sender: 'Contact' }, { account: 'gmail-personal' as const, id: 'chat-2', title: 'Other', preview: '', date: 200, unread: false }],
      freshness: { whatsapp: fresh, 'gmail-personal': fresh, 'gmail-business': fresh, imessage: fresh, linkedin: fresh },
      more: { whatsapp: false, 'gmail-personal': false, 'gmail-business': false, imessage: false, linkedin: false },
    }),
    search: (_input: { query: string }) => ({
      ids: [{ account: 'whatsapp' as const, id: 'chat-1', score: 1 }],
      // A hit the cache never held still carries the row it matched.
      items: [{ account: 'whatsapp' as const, id: 'chat-1', title: 'Grace', preview: '', date: 1, unread: false }],
      truncated: false,
    }),
    search_status: () => ({ size: 2, updatedAt: 100, ready: true }),
    sources: () => ({
      'gmail-personal': { label: 'Personal Gmail', icon: 'Mail', pollIntervalMs: 45_000, pageSize: 10 },
      'gmail-business': { label: 'Inhouse Gmail', icon: 'Mail', pollIntervalMs: 45_000, pageSize: 10 },
      whatsapp: { label: 'WhatsApp', icon: 'MessageCircle', pollIntervalMs: 45_000, pageSize: 50 },
      imessage: { label: 'Messages', icon: 'MessageCircle', pollIntervalMs: 45_000 },
      linkedin: { label: 'LinkedIn', icon: 'Linkedin', pollIntervalMs: 45_000 },
    }),
    sync: async (_input: unknown) => ({ items: [], updatedAt: 123, more: false }),
    open: async (_input: unknown) => { opens++; return { messages, updatedAt: 100, cacheFallback: false }; },
    cached_open: async (_input: unknown) => ({ messages, updatedAt: 90, cacheFallback: true }),
    media: async (_input: unknown) => { loads++; return payload; },
  };
  registerInboxAgentTools(bb, gateway);
  return { harness, messages, get loads() { return loads; }, get opens() { return opens; }, setPayload(value: typeof payload) { payload = value; } };
}

function json(result: unknown): any {
  assert.equal(typeof result, 'string');
  return JSON.parse(result as string);
}

test('native tools are selected and expose only read operations', async t => {
  const f = fixture();
  t.after(() => f.harness.lifecycle.dispose());
  const config = await f.harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext());
  assert.deepEqual(config.tools.map(tool => tool.name), ['inbox_list', 'inbox_search', 'inbox_refresh', 'inbox_read', 'inbox_view_image']);
  assert.deepEqual(config.skills, []);
});

test('list pages the cache and search returns the matching excerpt', async t => {
  const f = fixture();
  t.after(() => f.harness.lifecycle.dispose());
  const first = json(await f.harness.behavior.callAgentTool('inbox_list', { limit: 1 }));
  assert.equal(first.items[0].id, 'chat-2');
  assert.equal(first.items[0].date, new Date(200).toISOString());
  assert.equal(first.nextOffset, 1);
  assert.equal(first.coverage.accounts.find((row: { account: string }) => row.account === 'whatsapp').olderAvailable, true);
  assert.equal(first.coverage.accounts.find((row: { account: string }) => row.account === 'imessage').olderAvailable, false);
  const unread = json(await f.harness.behavior.callAgentTool('inbox_list', { account: 'whatsapp', unread: true }));
  assert.equal(unread.items[0].id, 'chat-1');
  assert.equal(unread.items[0].participants, 'Contact');
  const found = json(await f.harness.behavior.callAgentTool('inbox_search', { query: 'Pickup', account: 'whatsapp' }));
  assert.equal(found.matches[0].id, 'chat-1');
  assert.match(found.matches[0].excerpts[0].text, /Pickup/);
  assert.equal(found.coverage.truncated, false);
  assert.equal(found.coverage.indexedConversations, 2);
  assert.equal(found.nextOffset, null);
  assert.deepEqual(json(await f.harness.behavior.callAgentTool('inbox_refresh', { account: 'whatsapp' })), { account: 'whatsapp', updatedAt: new Date(123).toISOString(), conversations: 0, stale: false, error: null, olderAvailable: false });
});

test('read pages text and returns reusable media references for all three address types', async t => {
  const f = fixture();
  t.after(() => f.harness.lifecycle.dispose());
  const result = json(await f.harness.behavior.callAgentTool('inbox_read', { account: 'whatsapp', id: 'chat-1' }));
  assert.equal(f.opens, 1);
  assert.equal(f.loads, 0);
  assert.equal(result.title, 'Contact');
  assert.equal(result.returnedMessages, 3);
  assert.deepEqual(result.messages[0].media, [{ description: 'image', viewable: true, reference: { kind: 'message', id: 'photo-1', index: 0 } }]);
  assert.deepEqual(result.messages[1].media, [{ description: 'image, photo.png', viewable: true, reference: { kind: 'attachment', id: 'mail-1', filename: 'photo.png' } }]);
  assert.deepEqual(result.messages[2].media, [{ description: 'image, photo.png', viewable: true, reference: { kind: 'imsg', chatId: 'chat-1', messageId: '42', index: 0 } }]);
  assert.equal(result.messages[1].html, undefined);
  assert.equal(result.messages[1].text.length, 20_000);
  assert.equal(result.messages[1].nextTextOffset, 20_000);
  const rest = json(await f.harness.behavior.callAgentTool('inbox_read', { account: 'whatsapp', id: 'chat-1', cached: true, offset: 1, limit: 1, textOffset: 20_000 }));
  assert.equal(rest.messages[0].text.length, 1000);
  assert.equal(rest.messages[0].nextTextOffset, null);
  assert.equal(rest.nextOffset, 2);
  assert.equal(rest.cacheFallback, true);
  assert.equal(f.opens, 1);
});

test('image tool returns native image content with provenance, not a JSON data URL', async t => {
  const f = fixture();
  t.after(() => f.harness.lifecycle.dispose());
  const result = await f.harness.behavior.callAgentTool('inbox_view_image', { account: 'whatsapp', id: 'chat-1', media: { kind: 'message', id: 'photo-1' } });
  assert.equal(typeof result, 'object');
  if (typeof result === 'string') throw new Error('Expected native image result');
  assert.deepEqual(result.content[1], { type: 'image', data: png, mimeType: 'image/png' });
  assert.match(JSON.stringify(result.content[0]), /chat-1/);
  assert.equal(f.loads, 1);
});

test('unrelated media and videos fail before retrieval', async t => {
  const f = fixture();
  t.after(() => f.harness.lifecycle.dispose());
  await assert.rejects(() => f.harness.behavior.callAgentTool('inbox_view_image', { account: 'whatsapp', id: 'chat-1', media: { kind: 'message', id: 'other' } }), /does not belong/);
  f.messages[0].media!.kind = 'video';
  await assert.rejects(() => f.harness.behavior.callAgentTool('inbox_view_image', { account: 'whatsapp', id: 'chat-1', media: { kind: 'message', id: 'photo-1' } }), /Video inspection/);
  assert.equal(f.loads, 0);
});

test('unsupported MIME, invalid base64 and oversized images are refused', async t => {
  const f = fixture();
  t.after(() => f.harness.lifecycle.dispose());
  for (const payload of [
    { dataUrl: 'data:image/svg+xml;base64,PHN2Zz4=', mime: 'image/svg+xml' },
    { dataUrl: `data:image/png;base64,${png}`, mime: 'image/jpeg' },
    { dataUrl: 'data:image/png;base64,a', mime: 'image/png' },
    { dataUrl: `data:image/png;base64,${Buffer.alloc(6 * 1024 * 1024 + 1).toString('base64')}`, mime: 'image/png' },
  ]) {
    f.setPayload(payload);
    await assert.rejects(() => f.harness.behavior.callAgentTool('inbox_view_image', { account: 'whatsapp', id: 'chat-1', media: { kind: 'message', id: 'photo-1' } }), /supported image|encoding|limit/);
  }
});

test('cancelled calls stop before any adapter reads or media loads', async t => {
  const f = fixture();
  t.after(() => f.harness.lifecycle.dispose());
  const controller = new AbortController();
  controller.abort();
  for (const [name, input] of [
    ['inbox_read', { account: 'whatsapp', id: 'chat-1' }],
    ['inbox_view_image', { account: 'whatsapp', id: 'chat-1', media: { kind: 'message', id: 'photo-1' } }],
  ] as const) {
    await assert.rejects(() => f.harness.behavior.callAgentTool(name, input, { signal: controller.signal }), /abort/i);
  }
  assert.equal(f.opens, 0);
  assert.equal(f.loads, 0);
});

test('tool schemas reject arbitrary URLs, unknown accounts and unbounded pages', async t => {
  const f = fixture();
  t.after(() => f.harness.lifecycle.dispose());
  await assert.rejects(() => f.harness.behavior.callAgentTool('inbox_list', { account: 'unknown' }));
  await assert.rejects(() => f.harness.behavior.callAgentTool('inbox_list', { query: 'Pickup' }));
  await assert.rejects(() => f.harness.behavior.callAgentTool('inbox_search', {}));
  await assert.rejects(() => f.harness.behavior.callAgentTool('inbox_read', { account: 'whatsapp', id: 'chat-1', limit: 1000 }));
  await assert.rejects(() => f.harness.behavior.callAgentTool('inbox_view_image', { account: 'whatsapp', id: 'chat-1', media: { kind: 'message', id: 'photo-1', url: 'https://example.org' } }));
  assert.equal(f.loads, 0);
});
