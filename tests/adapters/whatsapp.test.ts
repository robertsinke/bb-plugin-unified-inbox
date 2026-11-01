// WhatsApp: the send flag is the propose → confirm flow, read/unread are
// local state, media is served through the loopback API, and archive is refused.
// Every runner and HTTP response is stubbed.
import assert from 'node:assert/strict';
import test from 'node:test';
import { harness, refused, LINKEDIN_ID, WHATSAPP_ID } from './harness.ts';

test('WhatsApp: declared capabilities match what action and media accept', async () => {
  const h = harness();
  const originalFetch = globalThis.fetch;
  const fetched: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    fetched.push(url);
    if (url.includes('/api/proposals/')) return new Response('{}');
    return new Response(new Uint8Array([1, 2, 3]).buffer, { headers: { 'content-type': 'image/png' } });
  }) as typeof globalThis.fetch;
  try {
    const adapter = h.registry.whatsapp;
    const caps = adapter.capabilities();
    assert.deepEqual(caps, { send: true, markRead: true, archive: false, invitations: false, media: true, attachments: false, threads: true, confirmSend: true, followsList: true });

    // send: true — reply proposes, confirm accepts, reject withdraws. No live client.
    h.calls.length = 0;
    assert.deepEqual(await adapter.action('reply', WHATSAPP_ID, { text: 'On my way' }), {
      status: 'Review this message before it sends.', proposalId: 7, text: 'On my way',
    });
    assert.deepEqual(h.calls, ['whatsapp:propose-send']);
    assert.deepEqual(await adapter.action('reject', WHATSAPP_ID, { proposalId: 7 }), { status: 'Not sent.' });
    assert.deepEqual(h.calls, ['whatsapp:propose-send', 'whatsapp:reject-proposal']);
    assert.deepEqual(await adapter.action('confirm', WHATSAPP_ID, { proposalId: 7, text: 'On my way' }), { status: 'Sending.' });
    assert.deepEqual(h.calls, ['whatsapp:propose-send', 'whatsapp:reject-proposal', 'whatsapp:get-messages', 'whatsapp:runtime']);
    assert.equal(fetched.filter(url => url.includes('/api/proposals/')).length, 1);

    // markRead: true — read reaches WhatsAgent, unread is local only.
    h.calls.length = 0;
    assert.deepEqual(await adapter.action('read', WHATSAPP_ID), { status: 'Marked read in WhatsAgent (no WhatsApp read receipt).' });
    assert.deepEqual(h.calls, ['whatsapp:mark-read']);
    h.calls.length = 0;
    assert.deepEqual(await adapter.action('unread', WHATSAPP_ID), { status: 'Marked unread.' });
    assert.deepEqual(h.calls, []);
    assert.equal(h.cache.keptUnread('whatsapp', WHATSAPP_ID), true);

    // archive: false — refused before any source call, whatever the conversation id.
    for (const id of [WHATSAPP_ID, LINKEDIN_ID]) {
      await refused(h.calls, () => adapter.action('archive', id), /not supported by WhatsAgent/);
    }

    // media: true — the stubbed loopback API serves a bounded data URL.
    h.calls.length = 0;
    const image = await adapter.media('whatsapp', 'm1', 0);
    assert.deepEqual(h.calls, ['whatsapp:load-media', 'whatsapp:runtime']);
    assert.equal(image.mime, 'image/png');
    assert.equal(image.dataUrl, `data:image/png;base64,${Buffer.from([1, 2, 3]).toString('base64')}`);

    // attachments: false — there is no attachment entry point to lie about.
    assert.equal(adapter.gmailAttachment, undefined);
    assert.equal(adapter.imsgMedia, undefined);
  } finally {
    globalThis.fetch = originalFetch;
    h.close();
  }
});
