import assert from 'node:assert/strict';
import test from 'node:test';
import { createLinkedInPageAccess } from '../src/linkedin-chrome.ts';
import { createLinkedInPageSession } from '../src/linkedin-page-session.ts';

function fixture() {
  const page = { recipient: 'verified-recipient', draft: 'Unsent draft', recorder: ['armed'] };
  let stops = 0;
  let idlePaused = false;
  const access = createLinkedInPageAccess({
    load: async () => page,
    stop: async () => { stops++; },
    pauseIdle: () => { idlePaused = true; },
    keepWarm: () => { idlePaused = false; },
  });
  return { page, access, stops: () => stops, paused: () => idlePaused };
}

test('failed background read preserves compose and recorder for a queued send', async () => {
  const f = fixture();
  let release!: () => void;
  let entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const read = f.access.read(async page => {
    assert.equal(page, f.page);
    assert.equal(f.paused(), true);
    entered();
    await new Promise<void>(done => { release = done; });
    throw new Error('read timeout');
  });
  const rejected = assert.rejects(read, /read timeout/);
  await ready;
  let sent = false;
  const send = f.access.write(async page => {
    assert.equal(f.stops(), 0, 'read errors cannot stop/replace the browser');
    assert.equal(page, f.page);
    assert.deepEqual(page, { recipient: 'verified-recipient', draft: 'Unsent draft', recorder: ['armed'] });
    assert.equal(f.paused(), true, 'idle teardown stays paused while sending');
    sent = true;
  });
  await Promise.resolve();
  assert.equal(sent, false, 'read and send cannot use the page concurrently');
  release();
  await Promise.all([send, rejected]);
  assert.equal(sent, true);
  assert.equal(f.paused(), false);
});

test('background reads cannot interrupt an active interactive operation', async () => {
  const f = fixture();
  const events: string[] = [];
  let release!: () => void;
  let entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const send = f.access.write(async () => {
    events.push('send-start');
    entered();
    await new Promise<void>(resolve => { release = resolve; });
    events.push('send-end');
  });
  await ready;
  const read = f.access.read(async () => { events.push('read'); });
  await Promise.resolve();
  assert.deepEqual(events, ['send-start']);
  assert.equal(f.paused(), true);
  release();
  await Promise.all([send, read]);
  assert.deepEqual(events, ['send-start', 'send-end', 'read']);
});

test('a read the browser did not answer resets the page', async () => {
  const f = fixture();
  await assert.rejects(
    f.access.read(async () => { throw new Error('The LinkedIn browser did not answer Runtime.evaluate.'); }),
    /did not answer/,
  );
  assert.equal(f.stops(), 1);
  await assert.rejects(f.access.read(async () => { throw new Error('LinkedIn 500 for /voyager/api/me'); }), /500/);
  assert.equal(f.stops(), 1, 'a refused response leaves the page in place');
});

test('interactive failures still reset the browser before the next operation', async () => {
  const f = fixture();
  await assert.rejects(f.access.write(async () => { throw new Error('failed send'); }), /failed send/);
  assert.equal(f.stops(), 1);
  assert.equal(f.paused(), false);
});

test('list/probe use the non-destructive read path; recorder operations stay interactive', async () => {
  let reads = 0;
  let interactive = 0;
  const session = createLinkedInPageSession(async () => {
    interactive++;
    return [];
  }, async () => {
    reads++;
    throw new Error('provider unavailable');
  });
  await assert.rejects(session.probe(), /provider unavailable/);
  await assert.rejects(session.list(), /provider unavailable/);
  assert.equal(reads, 2);
  assert.equal(interactive, 0);
  await session.clearRecorded();
  assert.equal(interactive, 1);
});
