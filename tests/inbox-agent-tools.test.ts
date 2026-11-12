import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakePluginHost, makePluginAgentConfigurationContext } from '@get-bb/plugin-sdk/testing';
import { registerInboxAgentTools } from '../src/inbox-agent-tools.ts';
import { NO_CAPABILITIES } from '../src/adapters/capability.ts';
import type { Account, Capabilities, MessageMedia } from '../src/adapters/types.ts';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jG3sAAAAASUVORK5CYII=';

function declared(quoteReply: boolean): Capabilities {
  return { ...NO_CAPABILITIES, send: true, react: quoteReply, reactRemove: quoteReply, quoteReply };
}

function fixture() {
  const { bb, harness } = createFakePluginHost({ pluginId: 'unified-inbox' });
  const messages: Array<{ sender: string; text: string; date: number; messageId?: string; reactions?: { sender: string; label: string }[]; quote?: { targetId?: string; sender?: string; text?: string }; media?: MessageMedia; html?: string; gmailId?: string; attachments?: string[]; imsgId?: string; imsgAttachments?: { index: number; name: string; available: boolean }[] }> = [
    { sender: 'Contact', text: 'Pickup information', date: 100, media: { kind: 'image', messageId: 'photo-1', available: true, cached: true } as MessageMedia },
    { sender: 'Contact', text: 'x'.repeat(21_000), date: 200, html: '<p>private HTML</p>', gmailId: 'mail-1', attachments: ['photo.png'] },
    { sender: 'Contact', text: '', date: 300, imsgId: '42', imsgAttachments: [{ index: 0, name: 'photo.png', available: true }] },
  ];
  let loads = 0;
  let opens = 0;
  const actions: unknown[] = [];
  let actionError: Error | null = null;
  const quoteReply: Record<Account, boolean> = { whatsapp: true, imessage: true, linkedin: false, 'gmail-personal': false, 'gmail-business': false };
  let payload: { dataUrl?: string; mime: string; filename?: string; size?: number; savedPath?: string; url?: string } = { dataUrl: `data:image/png;base64,${png}`, mime: 'image/png' };
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
    capabilities: () => Object.fromEntries((Object.keys(quoteReply) as Account[]).map(name => [name, declared(quoteReply[name])])) as Record<Account, Capabilities>,
    action: async (input: unknown) => {
      actions.push(input);
      if (actionError) throw actionError;
      return { status: 'sent' };
    },
  };
  const agentTools = registerInboxAgentTools(bb, gateway);
  return { harness, agentTools, messages, actions, get loads() { return loads; }, get opens() { return opens; }, setPayload(value: typeof payload) { payload = value; }, failAction(error: Error) { actionError = error; } };
}

function json(result: unknown): any {
  assert.equal(typeof result, 'string');
  return JSON.parse(result as string);
}

test('mention context masks identifiers and preserves references for agent reads', async t => {
  const f = fixture();
  t.after(() => f.harness.lifecycle.dispose());
  const context = await f.agentTools.protectMention('Source account: gmail-personal\nConversation id: maria@gmail.com\nCall +31 6 12345678', 'gmail-personal', 'maria@gmail.com');
  assert.doesNotMatch(context, /maria@gmail\.com|12345678/);
  const id = /Conversation id: (inbox-ref-[a-z-]+)/.exec(context)?.[1];
  assert.ok(id);
  const result = json(await f.harness.behavior.callAgentTool('inbox_read', { account: 'gmail-personal', id }));
  assert.equal(result.id, id);
});

test('agent read masks contacts and retains working opaque media references', async t => {
  const f = fixture();
  t.after(() => f.harness.lifecycle.dispose());
  f.messages[0].sender = 'Olivia <maria@gmail.com>';
  f.messages[0].text = 'WHO still needs a place? Call +31 6 12345678';
  f.messages[0].media = { kind: 'image', messageId: 'maria@gmail.com', available: true, cached: true } as MessageMedia;
  const result = json(await f.harness.behavior.callAgentTool('inbox_read', { account: 'whatsapp', id: 'chat-1' }));
  assert.doesNotMatch(JSON.stringify(result), /maria@gmail\.com|12345678/);
  assert.match(result.messages[0].text, /WHO still needs a place/);
  const ref = result.messages[0].media[0].reference;
  assert.match(ref.id, /^inbox-ref-/);
  const attachment = await f.harness.behavior.callAgentTool('inbox_view_attachment', { account: 'whatsapp', id: 'chat-1', media: ref });
  assert.ok(attachment);
  assert.equal(f.loads, 1);
});

test('native tools include the five read tools and the two send tools', async t => {
  const f = fixture();
  t.after(() => f.harness.lifecycle.dispose());
  const config = await f.harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext());
  assert.deepEqual(config.tools.map(tool => tool.name), ['inbox_list', 'inbox_search', 'inbox_refresh', 'inbox_read', 'inbox_view_attachment', 'inbox_react', 'inbox_reply']);
  assert.deepEqual(config.skills, []);
  const list = config.tools.find(tool => tool.name === 'inbox_list');
  assert.match(list?.instructions ?? '', /inbox_react and inbox_reply send, and the read tools still do not/);
  assert.match(list?.instructions ?? '', /These tools do not authorize sending/);
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
  assert.deepEqual(result.messages[0].media, [{ description: 'image', type: 'image', viewable: true, reference: { kind: 'message', id: 'photo-1', index: 0 } }]);
  assert.deepEqual(result.messages[1].media, [{ description: 'image, photo.png', type: 'image', viewable: true, reference: { kind: 'attachment', id: 'mail-1', filename: 'photo.png' } }]);
  assert.deepEqual(result.messages[2].media, [{ description: 'image, photo.png', type: 'image', viewable: true, reference: { kind: 'imsg', chatId: 'chat-1', messageId: '42', index: 0 } }]);
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

test('a picture comes back as an image, with a note that it is untrusted', async t => {
  const f = fixture();
  t.after(() => f.harness.lifecycle.dispose());
  const result = await f.harness.behavior.callAgentTool('inbox_view_attachment', { account: 'whatsapp', id: 'chat-1', media: { kind: 'message', id: 'photo-1' } });
  assert.equal(typeof result, 'object');
  if (typeof result === 'string') throw new Error('Expected native image result');
  assert.deepEqual(result.content[1], { type: 'image', data: png, mimeType: 'image/png' });
  assert.match(JSON.stringify(result.content[0]), /chat-1/);
  assert.equal(f.loads, 1);
});

test('an unknown file is refused before retrieval, and a video comes back as a video', async t => {
  const f = fixture();
  t.after(() => f.harness.lifecycle.dispose());
  await assert.rejects(() => f.harness.behavior.callAgentTool('inbox_view_attachment', { account: 'whatsapp', id: 'chat-1', media: { kind: 'message', id: 'other' } }), /does not belong/);
  assert.equal(f.loads, 0);
  f.messages[0].media!.kind = 'video';
  f.setPayload({ dataUrl: 'data:video/mp4;base64,AAAA', mime: 'video/mp4', filename: 'clip.mp4' });
  const video = json(await f.harness.behavior.callAgentTool('inbox_view_attachment', { account: 'whatsapp', id: 'chat-1', media: { kind: 'message', id: 'photo-1' } }));
  assert.equal(video.type, 'video');
  assert.equal(video.included, true);
  assert.equal(f.loads, 1);
});

test('a mismatched type, bad encoding, or oversized image is refused, and SVG is not shown as a picture', async t => {
  const f = fixture();
  t.after(() => f.harness.lifecycle.dispose());
  f.setPayload({ dataUrl: 'data:image/svg+xml;base64,PHN2Zz4=', mime: 'image/svg+xml' });
  const svg = json(await f.harness.behavior.callAgentTool('inbox_view_attachment', { account: 'whatsapp', id: 'chat-1', media: { kind: 'message', id: 'photo-1' } }));
  assert.equal(svg.included, true);
  assert.equal(svg.data, 'PHN2Zz4=');
  for (const payload of [
    { dataUrl: `data:image/png;base64,${png}`, mime: 'image/jpeg' },
    { dataUrl: 'data:image/png;base64,a', mime: 'image/png' },
    { dataUrl: `data:image/png;base64,${Buffer.alloc(6 * 1024 * 1024 + 1).toString('base64')}`, mime: 'image/png' },
  ]) {
    f.setPayload(payload);
    await assert.rejects(() => f.harness.behavior.callAgentTool('inbox_view_attachment', { account: 'whatsapp', id: 'chat-1', media: { kind: 'message', id: 'photo-1' } }), /encoding|limit|does not match|not encoded/);
  }
});

test('one attachment tool returns a picture as an image and any other file with its type', async t => {
  const f = fixture();
  t.after(() => f.harness.lifecycle.dispose());
  const picture = await f.harness.behavior.callAgentTool('inbox_view_attachment', { account: 'whatsapp', id: 'chat-1', media: { kind: 'message', id: 'photo-1' } });
  if (typeof picture === 'string' || picture.content[0].type !== 'text') throw new Error('Expected an image result');
  assert.equal(JSON.parse(picture.content[0].text).type, 'image');
  assert.deepEqual(picture.content[1], { type: 'image', data: png, mimeType: 'image/png' });

  const pdf = Buffer.from('%PDF-1.4').toString('base64');
  f.messages.push({ sender: 'Contact', text: 'invoice', date: 400, gmailId: 'mail-2', attachments: ['invoice.pdf'] });
  f.setPayload({ dataUrl: `data:application/pdf;base64,${pdf}`, mime: 'application/pdf', filename: 'invoice.pdf' });
  const file = json(await f.harness.behavior.callAgentTool('inbox_view_attachment', { account: 'gmail-personal', id: 'chat-1', media: { kind: 'attachment', id: 'mail-2', filename: 'invoice.pdf' } }));
  assert.equal(file.type, 'pdf');
  assert.equal(file.included, true);
  assert.equal(file.data, pdf);

  const note = Buffer.from('hello').toString('base64');
  f.messages.push({ sender: 'Contact', text: '', date: 500, gmailId: 'mail-3', attachments: ['note.txt'] });
  f.setPayload({ dataUrl: `data:text/plain;base64,${note}`, mime: 'text/plain', filename: 'note.txt' });
  const text = json(await f.harness.behavior.callAgentTool('inbox_view_attachment', { account: 'gmail-personal', id: 'chat-1', media: { kind: 'attachment', id: 'mail-3', filename: 'note.txt' } }));
  assert.equal(text.type, 'text');
  assert.equal(text.text, 'hello');
  assert.equal(text.data, undefined);

  f.setPayload({ dataUrl: '', mime: 'application/pdf', filename: 'big.pdf', savedPath: '/tmp/big.pdf', size: 9_000_000 });
  f.messages.push({ sender: 'Contact', text: '', date: 600, gmailId: 'mail-4', attachments: ['big.pdf'] });
  const large = json(await f.harness.behavior.callAgentTool('inbox_view_attachment', { account: 'gmail-personal', id: 'chat-1', media: { kind: 'attachment', id: 'mail-4', filename: 'big.pdf' } }));
  assert.equal(large.type, 'pdf');
  assert.equal(large.included, false);
  assert.equal(large.savedPath, '/tmp/big.pdf');
  assert.equal(large.data, undefined);
});

test('cancelled calls stop before any adapter reads or media loads', async t => {
  const f = fixture();
  t.after(() => f.harness.lifecycle.dispose());
  const controller = new AbortController();
  controller.abort();
  for (const [name, input] of [
    ['inbox_read', { account: 'whatsapp', id: 'chat-1' }],
    ['inbox_view_attachment', { account: 'whatsapp', id: 'chat-1', media: { kind: 'message', id: 'photo-1' } }],
  ] as const) {
    await assert.rejects(() => f.harness.behavior.callAgentTool(name, input, { signal: controller.signal }), /abort/i);
  }
  assert.equal(f.opens, 0);
  assert.equal(f.loads, 0);
});

test('react and reply call action once, and a targeted reply cannot become a conversation reply', async t => {
  const f = fixture();
  t.after(() => f.harness.lifecycle.dispose());
  f.messages.push({
    sender: 'Ada',
    text: 'See you there',
    date: 400,
    messageId: 'li-msg-1',
    reactions: [{ sender: 'Ada', label: '👍' }],
    quote: { targetId: 'earlier', sender: 'Bob', text: 'hello' },
  });
  const read = json(await f.harness.behavior.callAgentTool('inbox_read', { account: 'linkedin', id: 'chat-1' }));
  const row = read.messages.find((message: { messageId?: string }) => message.messageId === 'li-msg-1');
  assert.deepEqual(row.reactions, [{ sender: 'Ada', label: '👍' }]);
  assert.deepEqual(row.quote, { targetId: 'earlier', sender: 'Bob', text: 'hello' });
  assert.equal(row.messageId, 'li-msg-1');

  const reacted = json(await f.harness.behavior.callAgentTool('inbox_react', { account: 'whatsapp', id: 'chat-1', messageId: row.messageId, emoji: '👍' }));
  assert.equal(reacted.status, 'sent');
  const removed = json(await f.harness.behavior.callAgentTool('inbox_react', { account: 'whatsapp', id: 'chat-1', messageId: row.messageId, emoji: '😂', remove: true }));
  assert.equal(removed.status, 'sent');
  const replied = json(await f.harness.behavior.callAgentTool('inbox_reply', { account: 'imessage', id: 'chat-1', messageId: row.messageId, text: 'ok' }));
  assert.equal(replied.status, 'sent');
  assert.deepEqual(f.actions, [
    { account: 'whatsapp', id: 'chat-1', action: 'react', messageId: 'li-msg-1', emoji: '👍', allow: 'send' },
    { account: 'whatsapp', id: 'chat-1', action: 'react', messageId: 'li-msg-1', emoji: '😂', remove: true, allow: 'send' },
    { account: 'imessage', id: 'chat-1', action: 'reply', text: 'ok', messageId: 'li-msg-1', allow: 'send' },
  ]);

  for (const emoji of ['‼️', '❓']) {
    await assert.rejects(() => f.harness.behavior.callAgentTool('inbox_react', { account: 'whatsapp', id: 'chat-1', messageId: 'li-msg-1', emoji }), /four|heart|emoji/i);
  }
  for (const account of ['linkedin', 'gmail-personal', 'gmail-business'] as const) {
    await assert.rejects(() => f.harness.behavior.callAgentTool('inbox_reply', { account, id: 'chat-1', messageId: 'li-msg-1', text: 'ok' }), /cannot reply to one message/);
  }
  assert.equal(f.actions.length, 3);

  f.failAction(new Error('This source refused the send.'));
  await assert.rejects(() => f.harness.behavior.callAgentTool('inbox_react', { account: 'whatsapp', id: 'chat-1', messageId: 'li-msg-1', emoji: '❤️' }), /refused the send/);
  assert.equal(f.actions.length, 4);
});

test('tool schemas reject arbitrary URLs, unknown accounts and unbounded pages', async t => {
  const f = fixture();
  t.after(() => f.harness.lifecycle.dispose());
  await assert.rejects(() => f.harness.behavior.callAgentTool('inbox_list', { account: 'unknown' }));
  await assert.rejects(() => f.harness.behavior.callAgentTool('inbox_list', { query: 'Pickup' }));
  await assert.rejects(() => f.harness.behavior.callAgentTool('inbox_search', {}));
  await assert.rejects(() => f.harness.behavior.callAgentTool('inbox_read', { account: 'whatsapp', id: 'chat-1', limit: 1000 }));
  await assert.rejects(() => f.harness.behavior.callAgentTool('inbox_view_attachment', { account: 'whatsapp', id: 'chat-1', media: { kind: 'attachment', id: 'mail-1', filename: 'photo.png', url: 'https://example.org' } }));
  assert.equal(f.loads, 0);
});
