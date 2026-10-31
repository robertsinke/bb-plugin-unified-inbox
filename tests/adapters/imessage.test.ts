// Messages: send and local read state are enabled; archive is refused. Media
// and attachments open through the Messages-specific entry point. The imsg
// client is stubbed and the attachment is a temporary file, never a real one.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { harness, refused, IMSG_ID, WHATSAPP_ID } from './harness.ts';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lK3Q6wAAAABJRU5ErkJggg==', 'base64');

test('Messages: declared capabilities match what action and its attachment entry point accept', async () => {
  const home = await mkdtemp(join(tmpdir(), 'inbox-imsg-'));
  const attachments = join(home, 'Library/Messages/Attachments', 'a');
  await mkdir(attachments, { recursive: true });
  const photo = join(attachments, 'photo.png');
  await writeFile(photo, PNG);

  const previousHome = process.env.HOME;
  process.env.HOME = home;
  const h = harness({
    imsgHistory: () => ({
      messages: [{
        id: 1, guid: 'g-1', sender: '+15551234567', sender_name: 'Ada', text: 'Hello',
        created_at: '2024-01-01T00:00:00Z', is_from_me: false,
        attachments: [{ filename: photo, mime_type: 'image/png', total_bytes: PNG.length }],
      }],
    }),
  });
  try {
    const adapter = h.registry.imessage;
    const caps = adapter.capabilities();
    assert.deepEqual(caps, { send: true, markRead: true, archive: false, media: true, attachments: true });

    // send: true — a reply reaches the stubbed imsg send method.
    h.calls.length = 0;
    assert.deepEqual(await adapter.action('reply', IMSG_ID, { text: 'On my way' }), { status: 'Sent.' });
    assert.deepEqual(h.calls, ['imsg:send']);

    // markRead: true — both directions are local, because Messages has no read state.
    h.calls.length = 0;
    assert.deepEqual(await adapter.action('read', IMSG_ID), { status: 'Marked read.' });
    assert.equal(h.cache.keptUnread('imessage', IMSG_ID), false);
    assert.deepEqual(await adapter.action('unread', IMSG_ID), { status: 'Marked unread.' });
    assert.equal(h.cache.keptUnread('imessage', IMSG_ID), true);
    assert.deepEqual(h.calls, []);

    // archive: false, refused before any source call, whatever the conversation id.
    for (const id of [IMSG_ID, WHATSAPP_ID]) {
      await refused(h.calls, () => adapter.action('archive', id), /not supported for Messages/);
    }

    // media: true and attachments: true — served through the Messages entry point.
    h.calls.length = 0;
    const image = await adapter.imsgMedia!(IMSG_ID, '1', 0);
    assert.deepEqual(h.calls, ['imsg:messages.history']);
    assert.equal(image.mime, 'image/png');
    assert.equal(image.dataUrl, `data:image/png;base64,${PNG.toString('base64')}`);

    // Actions outside the declaration are refused.
    await refused(h.calls, () => adapter.action('confirm', IMSG_ID, { proposalId: 1, text: 'hi' }), /not supported for Messages/);
    await refused(h.calls, () => adapter.action('reject', IMSG_ID, { proposalId: 1 }), /not supported for Messages/);
  } finally {
    process.env.HOME = previousHome;
    h.close();
    await rm(home, { recursive: true, force: true });
  }
});
