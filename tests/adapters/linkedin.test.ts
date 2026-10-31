// LinkedIn: every capability is false, so every write is refused at the adapter
// boundary — for a LinkedIn id and for ids from other sources alike. The live
// read is stubbed and never reached by an action.
import assert from 'node:assert/strict';
import test from 'node:test';
import { harness, refused, IMSG_ID, LINKEDIN_ID, WHATSAPP_ID } from './harness.ts';

const REFUSAL = /read-only here/;

test('LinkedIn: declared capabilities match what action and media accept', async () => {
  const h = harness();
  try {
    const adapter = h.registry.linkedin;
    const caps = adapter.capabilities();
    assert.deepEqual(caps, { send: false, markRead: false, archive: false, media: false, attachments: false });

    // send: false — no generic send method and no reply action.
    assert.equal(adapter.send, undefined);
    await refused(h.calls, () => adapter.action('reply', LINKEDIN_ID, { text: 'hi' }), REFUSAL);

    // markRead: false and archive: false — refused for every state action.
    for (const kind of ['read', 'unread', 'archive', 'confirm', 'reject'] as const) {
      await refused(h.calls, () => adapter.action(kind, LINKEDIN_ID, { text: 'hi', proposalId: 1 }), REFUSAL);
    }

    // media: false — refused before any source call.
    await refused(h.calls, () => adapter.media('linkedin', LINKEDIN_ID, 0), /no media/);

    // attachments: false — there is no attachment entry point.
    assert.equal(adapter.gmailAttachment, undefined);
    assert.equal(adapter.imsgMedia, undefined);

    // The refusal is the capability boundary, not the conversation id: ids from
    // other sources are refused the same way, and nothing reaches the source.
    for (const id of [LINKEDIN_ID, WHATSAPP_ID, IMSG_ID, 't1']) {
      await refused(h.calls, () => adapter.action('read', id), REFUSAL);
      await refused(h.calls, () => adapter.action('archive', id), REFUSAL);
    }
  } finally { h.close(); }
});
