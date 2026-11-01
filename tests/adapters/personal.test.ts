// Personal Gmail: every declared capability is proven against the adapter's
// own accept/refuse behaviour, with the gws runner stubbed.
import assert from 'node:assert/strict';
import test from 'node:test';
import { harness, refused } from './harness.ts';

test('personal Gmail: declared capabilities match what action and send accept', async () => {
  const h = harness();
  try {
    const adapter = h.registry.personal;
    const caps = adapter.capabilities();
    assert.deepEqual(caps, { send: true, markRead: true, archive: true, invitations: false, media: false, attachments: true, threads: false, followsList: true });

    // send: true — the adapter accepts a personal draft and the stub runner gets it.
    const receipt = await adapter.send!({ kind: 'gmail', account: 'personal', to: 'ada@example.com', subject: 'Dinner', text: 'Six works.' }, {});
    assert.deepEqual(receipt, { status: 'Sent.' });
    assert.deepEqual(h.calls, ['gmail:personal:send']);
    assert.equal(h.sent.length, 1);
    assert.match(String(h.sent[0].raw), /Subject: Dinner/);

    // markRead: true — read and unread both reach the source.
    h.calls.length = 0;
    assert.deepEqual(await adapter.action('read', 't1'), { status: 'Updated.' });
    assert.deepEqual(await adapter.action('unread', 't1'), { status: 'Updated.' });
    assert.deepEqual(h.calls, ['gmail:personal:threads:modify', 'gmail:personal:threads:modify']);

    // archive: true — archive reaches the source.
    h.calls.length = 0;
    assert.deepEqual(await adapter.action('archive', 't1'), { status: 'Archived.' });
    assert.deepEqual(h.calls, ['gmail:personal:threads:modify']);

    // media: false — refused before any source call.
    await refused(h.calls, () => adapter.media({ kind: 'message', id: 'm1', index: 0 }), /no media to open/);

    // attachments: true — the Gmail attachment request returns a bounded file.
    h.calls.length = 0;
    const file = await adapter.media({ kind: 'attachment', id: 'm-att', filename: 'notes.txt' });
    assert.deepEqual(h.calls, ['gmail:personal:messages:get']);
    assert.equal(file.filename, 'notes.txt');
    assert.equal(file.mime, 'text/plain');
    assert.equal(file.size, 5);
    assert.equal(file.dataUrl, `data:text/plain;base64,${Buffer.from('hello').toString('base64')}`);

    // Actions the declaration does not cover are refused at the boundary too.
    await refused(h.calls, () => adapter.action('reply', 't1', { text: 'hi' }), /not supported/);
    await refused(h.calls, () => adapter.action('confirm', 't1', { text: 'hi' }), /not supported/);
    await refused(h.calls, () => adapter.action('reject', 't1', {}), /not supported/);

    // Every call carried the personal credential directory.
    assert.ok(h.calls.every(call => call.startsWith('gmail:personal:')));
  } finally { h.close(); }
});
