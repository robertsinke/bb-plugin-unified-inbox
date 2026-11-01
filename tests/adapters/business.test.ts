// Business Gmail: the same declaration as personal Gmail, proven against the
// business adapter and its own credential directory. Every source is stubbed.
import assert from 'node:assert/strict';
import test from 'node:test';
import { harness, refused } from './harness.ts';

test('business Gmail: declared capabilities match what action and send accept', async () => {
  const h = harness();
  try {
    const adapter = h.registry.business;
    const caps = adapter.capabilities();
    assert.deepEqual(caps, { send: true, markRead: true, archive: true, invitations: false, media: false, attachments: true, threads: false, followsList: true });

    // send: true, through the business account only.
    assert.deepEqual(
      await adapter.send!({ kind: 'gmail', account: 'business', to: 'ada@example.com', subject: 'Dinner', text: 'Six works.' }, {}),
      { status: 'Sent.' },
    );
    assert.deepEqual(h.calls, ['gmail:business:send']);
    assert.equal(h.sent[0].account, 'business');

    // A draft for the other account is refused before the runner is called.
    await refused(h.calls, () => adapter.send!({ kind: 'gmail', account: 'personal', to: 'ada@example.com', subject: 'Dinner', text: 'Six works.' }, {}), /another account/);

    // markRead: true.
    h.calls.length = 0;
    assert.deepEqual(await adapter.action('read', 't1'), { status: 'Updated.' });
    assert.deepEqual(await adapter.action('unread', 't1'), { status: 'Updated.' });
    assert.deepEqual(h.calls, ['gmail:business:threads:modify', 'gmail:business:threads:modify']);

    // archive: true.
    h.calls.length = 0;
    assert.deepEqual(await adapter.action('archive', 't1'), { status: 'Archived.' });
    assert.deepEqual(h.calls, ['gmail:business:threads:modify']);

    // media: false, refused before source I/O.
    await refused(h.calls, () => adapter.media('business', 'm1', 0), /no media to open/);

    // attachments: true.
    h.calls.length = 0;
    const file = await adapter.gmailAttachment!('m-att', 'notes.txt');
    assert.deepEqual(h.calls, ['gmail:business:messages:get']);
    assert.equal(file.filename, 'notes.txt');
    assert.equal(file.dataUrl, `data:text/plain;base64,${Buffer.from('hello').toString('base64')}`);

    // Actions outside the declaration are refused.
    await refused(h.calls, () => adapter.action('reply', 't1', { text: 'hi' }), /not supported/);
    await refused(h.calls, () => adapter.action('confirm', 't1', { text: 'hi' }), /not supported/);
    await refused(h.calls, () => adapter.action('reject', 't1', {}), /not supported/);

    // No call in this test used the personal credential directory.
    assert.ok(h.calls.every(call => call.startsWith('gmail:business:')));
  } finally { h.close(); }
});
