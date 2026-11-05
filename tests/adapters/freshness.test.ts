import assert from 'node:assert/strict';
import test from 'node:test';
import { harness, LINKEDIN_ID } from './harness.ts';
import { gmailSummaryCursor } from '../../src/sync-plan.ts';

for (const account of ['gmail-personal', 'gmail-business'] as const) {
  test(`${account}: failed profile read rejects sync without destroying cached rows`, async () => {
    const h = harness({ gmailCall: () => { throw new Error('offline'); } });
    try {
      h.cache.save(account, [{ account, id: 't', title: 'Subject', preview: 'Old', date: 1, unread: true }]);
      await assert.rejects(h.registry[account].sync());
      assert.equal(h.cache.list()[0].preview, 'Old');
    } finally { h.close(); }
  });

  test(`${account}: a current list cursor cannot validate a stale body; failed open declares fallback`, async () => {
    let fail = false;
    const h = harness({ gmailCall: (_account, call) => {
      if (fail) throw new Error('offline');
      assert.equal(call.method, 'threadGet');
      return { id: 't', messages: [{ id: 'new', internalDate: '2', snippet: 'New body', payload: { headers: [], mimeType: 'text/plain', body: { data: Buffer.from('New body').toString('base64url') } } }] };
    } });
    try {
      h.cache.saveThread(account, 't', [{ sender: 'Ada', text: 'Old body', date: 1, gmailId: 'old', attachments: [] }], 1);
      h.cache.setCursor(account, gmailSummaryCursor('current-list'));
      const live = await h.registry[account].open('t');
      assert.equal(live.messages[0].text, 'New body');
      const verifiedAt = h.cache.threadUpdatedAt(account, 't');
      fail = true;
      const fallback = await h.registry[account].open('t');
      assert.equal(fallback.cacheFallback, true);
      assert.equal(fallback.messages[0].text, 'New body');
      assert.equal(h.cache.threadUpdatedAt(account, 't'), verifiedAt);
    } finally { h.close(); }
  });
}

test('LinkedIn failed body read declares cache fallback without changing verification time', async () => {
  const h = harness({ linkedInThread: async () => { throw new Error('offline'); } });
  try {
    h.cache.saveThread('linkedin', LINKEDIN_ID, [{ sender: 'Ada', text: 'Old', date: 1 }], 123);
    const result = await h.registry.linkedin.open(LINKEDIN_ID);
    assert.equal(result.cacheFallback, true);
    assert.equal(result.messages[0].text, 'Old');
    assert.equal(h.cache.threadUpdatedAt('linkedin', LINKEDIN_ID), 123);
  } finally { h.close(); }
});
