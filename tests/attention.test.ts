import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { attentionFromAnswer, attentionPush, attentionScore, attentionVerdict, createAttentionStore, decisionToShow, DEFAULT_WORDING, focusMessages, lineKey, watchNewConversations } from '../src/attention.ts';
import { createInboxCache } from '../src/inbox-cache.ts';

const row = (preview: string, date = 2) => ({
  account: 'gmail-personal' as const,
  id: 't1',
  title: 'Dinner',
  preview,
  date,
  unread: true,
});

test('a saved Needed or None stays hidden when the Decisions plugin is not installed', () => {
  assert.equal(decisionToShow(false, 'yes'), null);
  assert.equal(decisionToShow(false, 'no'), null);
  assert.equal(decisionToShow(true, 'yes'), 'yes');
  assert.equal(decisionToShow(true, 'no'), 'no');
  assert.equal(decisionToShow(true, null), null);
});

test('a score of 0.7 or more is needed, and every lower score is none', () => {
  assert.equal(attentionVerdict(0.7), 'yes');
  assert.equal(attentionVerdict(0.91), 'yes');
  assert.equal(attentionVerdict(0.69), 'no');
  assert.equal(attentionVerdict(0.5), 'no');
  assert.equal(attentionVerdict(0.3), 'no');
  assert.equal(attentionVerdict(0.1), 'no');
  assert.throws(() => attentionFromAnswer({}), /no yes\/no answer/);
  assert.deepEqual(attentionFromAnswer({ line_1: { noul: 0.2 }, line_2: { noul: 0.91 } }), { verdict: 'yes', noul: 0.91 });
  assert.deepEqual(attentionFromAnswer({ line_1: { noul: 0.1 }, line_2: { noul: 0.2 } }), { verdict: 'no', noul: 0.2 });
  const open = { n: 1, text: 'can you reply?', mine: false };
  const done = { n: 2, text: 'Definitely!', mine: true };
  assert.equal(attentionScore([open, done], { [lineKey(open.text, false)]: 0.91, [lineKey(done.text, true)]: 0.09 }), 0.09);
  assert.equal(attentionScore([open, done], { [lineKey(open.text, false)]: 0.91, [lineKey(done.text, true)]: 0.4 }), 0.4);
  assert.equal(attentionScore([open, { ...done, text: 'I will send the file' }], { [lineKey(open.text, false)]: 0.1, [lineKey('I will send the file', true)]: 0.8 }), 0.8);
  assert.equal(attentionScore([open], { [lineKey(open.text, false)]: 0.91 }), 0.91);
  const older = Array.from({ length: 10 }, (_, index) => ({ n: index + 1, text: `old ${index}`, mine: false }));
  const recent = Array.from({ length: 8 }, (_, index) => ({ n: index + 11, text: `new ${index}`, mine: false }));
  const saved = Object.fromEntries(recent.map(line => [lineKey(line.text, false), 0.1]));
  assert.deepEqual(focusMessages([...older, ...recent], saved, null).map(line => line.text), recent.map(line => line.text));
  const anchor = lineKey(recent[0].text, false);
  const grown = focusMessages([...older, ...recent, { n: 19, text: 'just arrived', mine: false }], saved, anchor);
  assert.equal(grown[0].text, recent[0].text);
  assert.equal(grown.at(-1)?.text, 'just arrived');
});

test('a stored unclear row is read as needed or none from its score', () => {
  const db = new Database(':memory:');
  const store = createAttentionStore(db);
  try {
    const insert = db.prepare('INSERT INTO inbox_attention (account, id, verdict, noul, state_hash) VALUES (?, ?, ?, ?, ?)');
    insert.run('whatsapp', 'low', 'unsettled', 0.55, 'h');
    insert.run('whatsapp', 'high', 'unsettled', 0.8, 'h');
    assert.equal(store.get('whatsapp', 'low')?.verdict, 'no');
    assert.equal(store.get('whatsapp', 'high')?.verdict, 'yes');
  } finally {
    db.close();
  }
});

test('clearing a needed label stays none until a new line arrives', () => {
  const db = new Database(':memory:');
  const store = createAttentionStore(db);
  try {
    store.put('whatsapp', 'chat', { verdict: 'yes', noul: 0.91, stateHash: 'same', lines: { abc: 0.91 }, anchor: 'abc' });
    assert.equal(store.dismiss('whatsapp', 'chat'), true);
    const cleared = store.get('whatsapp', 'chat');
    assert.equal(cleared?.verdict, 'no');
    assert.equal(cleared?.noul, 0.3);
    assert.equal(cleared?.stateHash, 'same');
    assert.equal(cleared?.lines?.abc, 0.3);
    assert.equal(store.dismiss('whatsapp', 'chat'), false);
    assert.equal(store.restore('whatsapp', 'chat'), true);
    const restored = store.get('whatsapp', 'chat');
    assert.equal(restored?.verdict, 'yes');
    assert.equal(restored?.noul, 0.91);
    assert.equal(restored?.lines?.abc, 0.91);
    assert.equal(restored?.dismissed, false);
    assert.equal(store.restore('whatsapp', 'chat'), false);
  } finally {
    db.close();
  }
});

test('a closing reply you already sent is kept without asking again', async () => {
  const db = new Database(':memory:');
  const cache = createInboxCache(db);
  const store = createAttentionStore(db);
  const open = { sender: 'Ada', text: 'can you reply?', fromMe: false };
  const done = { sender: 'You', text: 'Definitely!', fromMe: true };
  cache.save('whatsapp', [{ account: 'whatsapp', id: 'chat', title: 'Ada', preview: 'Definitely!', date: 2, unread: false }]);
  cache.saveThread('whatsapp', 'chat', [open, done]);
  store.put('whatsapp', 'chat', {
    verdict: 'yes',
    noul: 0.58,
    stateHash: 'old',
    lines: { [lineKey(open.text, false)]: 0.58, [lineKey(done.text, true)]: 0.09 },
    anchor: null,
    taskAsked: true,
  });
  const watch = watchNewConversations({
    cache,
    store,
    debounceMs: 0,
    ask: async () => { throw new Error('already scored'); },
  });
  try {
    await settle();
    assert.equal(store.get('whatsapp', 'chat')?.verdict, 'no');
    assert.equal(store.get('whatsapp', 'chat')?.noul, 0.09);
  } finally {
    watch.stop();
    db.close();
  }
});

test('a line that already has a score is not asked again', async () => {
  const db = new Database(':memory:');
  const cache = createInboxCache(db);
  const store = createAttentionStore(db);
  const asked: string[][] = [];
  let round = 0;
  const watch = watchNewConversations({
    cache,
    store,
    debounceMs: 0,
    ask: async input => {
      round += 1;
      const keys = Object.keys(input.questions).sort();
      asked.push(keys);
      if (round === 1) return { answers: { line_1: { noul: 0.91 }, line_2: { noul: 0.1 } } };
      return { answers: Object.fromEntries(keys.map(key => [key, { noul: 0.12 }])) };
    },
  });
  try {
    watch.arrived('whatsapp', 'chat', { sender: 'Ada', text: 'can you reply?' });
    watch.arrived('whatsapp', 'chat', { sender: 'Ada', text: 'just an update' });
    await settle();
    cache.saveThread('whatsapp', 'chat', [
      { sender: 'Ada', text: 'can you reply?' },
      { sender: 'Ada', text: 'just an update' },
    ]);
    watch.arrived('whatsapp', 'chat', { sender: 'You', text: 'Done', fromMe: true });
    await settle();
    assert.deepEqual(asked, [['line_1', 'line_2'], ['line_3']]);
    assert.equal(store.get('whatsapp', 'chat')?.verdict, 'no');
    assert.equal(store.get('whatsapp', 'chat')?.noul, 0.12);
  } finally {
    watch.stop();
    db.close();
  }
});

test('a WhatsApp reply already in the store is part of the ask', async () => {
  const db = new Database(':memory:');
  const cache = createInboxCache(db);
  const store = createAttentionStore(db);
  const asked: string[][] = [];
  cache.save('whatsapp', [{ account: 'whatsapp', id: 'chat', title: 'Ada', preview: 'December?', date: 1, unread: false }]);
  cache.saveThread('whatsapp', 'chat', [{ sender: 'Ada', text: 'December?' }]);
  const watch = watchNewConversations({
    cache,
    store,
    debounceMs: 0,
    recentLines: () => [
      { sender: 'Ada', text: 'December?' },
      { sender: 'You', text: 'Definitely!', fromMe: true },
    ],
    ask: async input => {
      const messages = (input.state as { messages: Array<{ text: string }> }).messages;
      asked.push(messages.map(message => message.text));
      return { answers: { line_1: { noul: 0.1 }, line_2: { noul: 0.1 } } };
    },
  });
  try {
    await settle();
    assert.deepEqual(asked.at(-1), ['December?', 'Definitely!']);
  } finally {
    watch.stop();
    db.close();
  }
});

test('a new list row is judged once, and opening the thread is not a new message', async () => {
  const db = new Database(':memory:');
  const cache = createInboxCache(db);
  const store = createAttentionStore(db);
  const asked: string[] = [];
  const watch = watchNewConversations({
    cache,
    store,
    ask: async input => {
      const state = input.state as { preview: string; unread?: unknown; channel: string; messages: unknown[] };
      assert.equal(state.unread, undefined);
      assert.equal(state.channel, 'gmail-personal');
      assert.ok(Array.isArray(state.messages));
      assert.ok(state.messages.length <= 32);
      asked.push(state.preview);
      const key = Object.keys(input.questions)[0];
      return { answers: { [key]: { type: 'noul', noul: 0.91 } } };
    },
  });
  try {
    cache.save('gmail-personal', [row('already here', 1)]);
    await settle();
    assert.deepEqual(asked, ['already here'], 'the conversations already listed are judged');

    cache.save('gmail-personal', [row('please reply')]);
    await settle();
    assert.deepEqual(asked, ['already here', 'please reply']);
    assert.equal(store.get('gmail-personal', 't1')?.verdict, 'yes');

    cache.saveThread('gmail-personal', 't1', [{ sender: 'Ada', text: 'please reply' }]);
    cache.save('gmail-personal', [row('please reply')]);
    await settle();
    assert.deepEqual(asked, ['already here', 'please reply', 'please reply'], 'the thread replaces a snippet that had no speaker');
  } finally {
    watch.stop();
    db.close();
  }
});

test('several new messages in one conversation are one ask', async () => {
  const db = new Database(':memory:');
  const cache = createInboxCache(db);
  const store = createAttentionStore(db);
  let calls = 0;
  const watch = watchNewConversations({
    cache,
    store,
    debounceMs: 0,
    ask: async input => {
      calls += 1;
      const messages = (input.state as { messages: { text: string }[] }).messages;
      assert.deepEqual(messages.map(message => message.text), ['one', 'two']);
      assert.deepEqual(Object.keys(input.questions).sort(), ['line_1', 'line_2']);
      return { answers: { line_1: { noul: 0.2 }, line_2: { noul: 0.91 } } };
    },
  });
  try {
    watch.arrived('whatsapp', 'chat', { sender: 'Ada', text: 'one' });
    watch.arrived('whatsapp', 'chat', { sender: 'Ada', text: 'two' });
    await settle();
    assert.equal(calls, 1);
    assert.equal(store.get('whatsapp', 'chat')?.verdict, 'yes');
    assert.equal(store.get('whatsapp', 'chat')?.noul, 0.91);
  } finally {
    watch.stop();
    db.close();
  }
});

test('WhatsApp messages in one window become one ask', async () => {
  const db = new Database(':memory:');
  const cache = createInboxCache(db);
  const store = createAttentionStore(db);
  let calls = 0;
  const watch = watchNewConversations({
    cache,
    store,
    debounceMs: 40,
    ask: async input => {
      calls += 1;
      const messages = (input.state as { messages: { text: string }[] }).messages;
      assert.deepEqual(messages.map(message => message.text), ['one', 'two']);
      return { answers: { line_1: { noul: 0.8 }, line_2: { noul: 0.8 } } };
    },
  });
  try {
    watch.arrived('whatsapp', 'chat', { sender: 'Ada', text: 'one' });
    watch.arrived('whatsapp', 'chat', { sender: 'Ada', text: 'two' });
    await settle();
    assert.equal(calls, 0, 'the window is still open');
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(calls, 1);
    assert.equal(store.get('whatsapp', 'chat')?.verdict, 'yes');
  } finally {
    watch.stop();
    db.close();
  }
});

test('a sent Gmail reply is the list preview and the last line of the ask', async () => {
  const db = new Database(':memory:');
  const cache = createInboxCache(db);
  const store = createAttentionStore(db);
  const asked: Array<{ preview: string; messages: Array<{ text: string; mine: boolean }> }> = [];
  const watch = watchNewConversations({
    cache,
    store,
    ask: async input => {
      const state = input.state as { preview: string; messages: Array<{ text: string; mine: boolean }> };
      asked.push(state);
      return { answers: { needs_attention: { type: 'noul', noul: 0.1 }, line_1: { type: 'noul', noul: 0.1 } } };
    },
  });
  try {
    cache.save('gmail-personal', [{ account: 'gmail-personal', id: 't1', title: 'Dinner', preview: 'Can you review this?', date: 1, unread: true }]);
    await settle();
    cache.setSentSnippet('gmail-personal', 't1', 'On my way');
    await settle();
    assert.equal(asked.at(-1)?.preview, 'On my way');
    assert.deepEqual(asked.at(-1)?.messages.at(-1), { n: 1, from: 'You', text: 'On my way', mine: true });
  } finally {
    watch.stop();
    db.close();
  }
});

test('a LinkedIn invitation is not asked', async () => {
  const db = new Database(':memory:');
  const cache = createInboxCache(db);
  const store = createAttentionStore(db);
  const asked: string[] = [];
  const watch = watchNewConversations({
    cache,
    store,
    ask: async input => {
      asked.push(String((input.state as { preview: string }).preview));
      return { answers: { needs_attention: { type: 'noul', noul: 0.91 } } };
    },
  });
  try {
    cache.save('linkedin', [
      { account: 'linkedin', id: 'urn:li:fs_relInvitation:abc', title: 'Ada', preview: 'wants to connect', date: 1, unread: true },
      { account: 'linkedin', id: 'urn:li:msg_conversation:abc', title: 'Ada', preview: 'can you review this', date: 2, unread: false },
    ]);
    await settle();
    assert.deepEqual(asked, ['can you review this']);
    store.put('linkedin', 'urn:li:fs_relInvitation:abc', { verdict: 'yes', noul: 0.91, stateHash: 'x', lines: null, anchor: null });
    assert.equal(store.get('linkedin', 'urn:li:fs_relInvitation:abc'), null);
  } finally {
    watch.stop();
    db.close();
  }
});

test('a new question asks the current span again and leaves older lines out', async () => {
  const db = new Database(':memory:');
  const cache = createInboxCache(db);
  const store = createAttentionStore(db);
  const recent = [
    { sender: 'Ada', text: 'can you reply?' },
    { sender: 'Ada', text: 'just an update' },
  ];
  cache.save('gmail-personal', [{ account: 'gmail-personal', id: 'chat', title: 'Ada', preview: 'just an update', date: 1, unread: true }]);
  cache.saveThread('gmail-personal', 'chat', recent);
  let wording = { ...DEFAULT_WORDING };
  const asked: string[][] = [];
  const yes: string[] = [];
  const spans: number[] = [];
  const watch = watchNewConversations({
    cache,
    store,
    wording: async () => wording,
    ask: async input => {
      const keys = Object.keys(input.questions).sort();
      asked.push(keys);
      yes.push(input.questions[keys[0]].criteria.true);
      spans.push((input.state.messages as unknown[]).length);
      return { answers: Object.fromEntries(keys.map(key => [key, { noul: 0.2 }])) };
    },
  });
  try {
    await settle();
    watch.arrived('gmail-personal', 'chat');
    await settle();
    const older = Array.from({ length: 8 }, (_, index) => ({ sender: 'Ada', text: `old ${index}` }));
    cache.saveThread('gmail-personal', 'chat', [...older, ...recent]);
    wording = { ...DEFAULT_WORDING, yes: 'Only a direct question counts.' };
    watch.arrived('gmail-personal', 'chat');
    await settle();
    assert.deepEqual(asked, [['line_1', 'line_2'], ['line_1', 'line_2']]);
    assert.deepEqual(spans, [2, 2]);
    assert.equal(yes[0], DEFAULT_WORDING.yes);
    assert.equal(yes[1], 'Only a direct question counts.');
  } finally {
    watch.stop();
    db.close();
  }
});

test('a missing decisions ask is logged and stores no verdict', async () => {
  const db = new Database(':memory:');
  const cache = createInboxCache(db);
  const store = createAttentionStore(db);
  const lines: string[] = [];
  cache.save('whatsapp', [{ account: 'whatsapp', id: 'chat', title: 'Ada', preview: 'hello', date: 2, unread: true }]);
  const watch = watchNewConversations({
    cache,
    store,
    debounceMs: 0,
    log: line => lines.push(line),
    ask: async () => { throw new Error('plugin is not installed'); },
  });
  try {
    await settle();
    assert.equal(store.get('whatsapp', 'chat'), null);
    assert.match(lines.join('\n'), /plugin is not installed/);
  } finally {
    watch.stop();
    db.close();
  }
});

test('a verdict that becomes needed sends one push, and the other transitions do not', async () => {
  const title = 'Ada '.repeat(40);
  const preview = 'please reply '.repeat(30);
  const sent: { title: string; body: string; threadId?: string }[] = [];
  async function run(previous: 'yes' | 'no' | null, noul: number) {
    const db = new Database(':memory:');
    const cache = createInboxCache(db);
    const store = createAttentionStore(db);
    cache.save('whatsapp', [{ account: 'whatsapp', id: 'chat', title, preview, date: 2, unread: true }]);
    cache.saveThread('whatsapp', 'chat', [{ sender: 'Ada', text: 'please reply', fromMe: false }]);
    if (previous) store.put('whatsapp', 'chat', { verdict: previous, noul: previous === 'yes' ? 0.9 : 0.2, stateHash: 'old', lines: null, anchor: null });
    const watch = watchNewConversations({
      cache,
      store,
      debounceMs: 0,
      ask: async () => ({ answers: { line_1: { noul } } }),
      notify: async input => { sent.push(input); },
    });
    try {
      await settle();
    } finally {
      watch.stop();
      db.close();
    }
  }
  await run('no', 0.91);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].title.includes('Ada'), true);
  assert.equal(sent[0].title.length <= 80, true);
  assert.equal(sent[0].body, preview.slice(0, 180));
  assert.equal('threadId' in sent[0], false);
  const afterYes = sent.length;
  await run('yes', 0.91);
  await run(null, 0.91);
  await run('no', 0.2);
  assert.equal(sent.length, afterYes);
  assert.equal(attentionPush(null, 'yes', { account: 'whatsapp', title: 'Ada', preview: 'hi' }), null);
  assert.equal(attentionPush('yes', 'yes', { account: 'whatsapp', title: 'Ada', preview: 'hi' }), null);
  assert.equal(attentionPush('no', 'no', { account: 'whatsapp', title: 'Ada', preview: 'hi' }), null);
});

test('a muted conversation with a new preview is not asked and stores no verdict', async () => {
  const db = new Database(':memory:');
  const cache = createInboxCache(db);
  const store = createAttentionStore(db);
  const asked: string[] = [];
  cache.mute('gmail-personal', 't1');
  const watch = watchNewConversations({
    cache,
    store,
    muted: (account, id) => cache.muted(account, id),
    ask: async input => {
      asked.push(String((input.state as { preview: string }).preview));
      return { answers: { needs_attention: { type: 'noul', noul: 0.91 } } };
    },
  });
  try {
    cache.save('gmail-personal', [row('please reply')]);
    await settle();
    assert.deepEqual(asked, []);
    assert.equal(store.get('gmail-personal', 't1'), null);
  } finally {
    watch.stop();
    db.close();
  }
});

test('a stored yes stays yes when the conversation is muted', async () => {
  const db = new Database(':memory:');
  const cache = createInboxCache(db);
  const store = createAttentionStore(db);
  cache.save('gmail-personal', [row('old line', 1)]);
  store.put('gmail-personal', 't1', { verdict: 'yes', noul: 0.91, stateHash: 'old', lines: null, anchor: null });
  cache.mute('gmail-personal', 't1');
  const watch = watchNewConversations({
    cache,
    store,
    muted: (account, id) => cache.muted(account, id),
    ask: async () => ({ answers: { needs_attention: { type: 'noul', noul: 0.1 } } }),
  });
  try {
    cache.save('gmail-personal', [row('please reply')]);
    await settle();
    const saved = store.get('gmail-personal', 't1');
    assert.equal(saved?.verdict, 'yes');
    assert.equal(saved?.noul, 0.91);
    assert.equal(decisionToShow(true, saved?.verdict ?? null), 'yes');
  } finally {
    watch.stop();
    db.close();
  }
});

test('an ask that resolves after mute does not write and does not push', async () => {
  const db = new Database(':memory:');
  const cache = createInboxCache(db);
  const store = createAttentionStore(db);
  const pushed: string[] = [];
  let release: () => void = () => {};
  const hold = new Promise<void>(resolve => { release = resolve; });
  let started = false;
  cache.save('whatsapp', [{ account: 'whatsapp', id: 'chat', title: 'Ada', preview: 'please reply', date: 2, unread: true }]);
  cache.saveThread('whatsapp', 'chat', [{ sender: 'Ada', text: 'please reply', fromMe: false }]);
  store.put('whatsapp', 'chat', { verdict: 'no', noul: 0.2, stateHash: 'old', lines: null, anchor: null });
  const watch = watchNewConversations({
    cache,
    store,
    debounceMs: 0,
    muted: (account, id) => cache.muted(account, id),
    ask: async () => {
      started = true;
      await hold;
      return { answers: { line_1: { noul: 0.91 } } };
    },
    notify: async input => { pushed.push(input.title); },
  });
  try {
    for (let turn = 0; turn < 20 && !started; turn += 1) await Promise.resolve();
    assert.equal(started, true);
    cache.mute('whatsapp', 'chat');
    release();
    await settle();
    const saved = store.get('whatsapp', 'chat');
    assert.equal(saved?.verdict, 'no');
    assert.equal(saved?.noul, 0.2);
    assert.deepEqual(pushed, []);
  } finally {
    release();
    watch.stop();
    db.close();
  }
});

test('a mute after schedule and before publish does not store an already scored line', async () => {
  const db = new Database(':memory:');
  const cache = createInboxCache(db);
  const store = createAttentionStore(db);
  const open = { sender: 'Ada', text: 'can you reply?', fromMe: false };
  const pushed: string[] = [];
  cache.save('whatsapp', [{ account: 'whatsapp', id: 'chat', title: 'Ada', preview: 'can you reply?', date: 2, unread: true }]);
  cache.saveThread('whatsapp', 'chat', [open]);
  store.put('whatsapp', 'chat', {
    verdict: 'no',
    noul: 0.2,
    stateHash: 'old',
    lines: { [lineKey(open.text, false)]: 0.91 },
    anchor: null,
  });
  const watch = watchNewConversations({
    cache,
    store,
    debounceMs: 0,
    muted: (account, id) => cache.muted(account, id),
    wording: async () => {
      cache.mute('whatsapp', 'chat');
      return DEFAULT_WORDING;
    },
    ask: async () => { throw new Error('already scored'); },
    notify: async input => { pushed.push(input.title); },
  });
  try {
    await settle();
    const saved = store.get('whatsapp', 'chat');
    assert.equal(saved?.verdict, 'no');
    assert.equal(saved?.noul, 0.2);
    assert.deepEqual(pushed, []);
  } finally {
    watch.stop();
    db.close();
  }
});

test('a mute while the WhatsApp or Messages wait is armed does not ask', async () => {
  const db = new Database(':memory:');
  const cache = createInboxCache(db);
  const store = createAttentionStore(db);
  let calls = 0;
  const watch = watchNewConversations({
    cache,
    store,
    debounceMs: 40,
    muted: (account, id) => cache.muted(account, id),
    ask: async () => {
      calls += 1;
      return { answers: { line_1: { noul: 0.8 } } };
    },
  });
  try {
    watch.arrived('whatsapp', 'wa', { sender: 'Ada', text: 'one' });
    watch.arrived('imessage', 'im', { sender: 'Ada', text: 'one' });
    cache.mute('whatsapp', 'wa');
    cache.mute('imessage', 'im');
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(calls, 0);
    assert.equal(store.get('whatsapp', 'wa'), null);
    assert.equal(store.get('imessage', 'im'), null);
  } finally {
    watch.stop();
    db.close();
  }
});

test('an unmuted conversation stores yes and pushes only when a stored no becomes yes', async () => {
  const sent: string[] = [];
  async function run(previous: 'no' | null) {
    const db = new Database(':memory:');
    const cache = createInboxCache(db);
    const store = createAttentionStore(db);
    cache.save('gmail-personal', [row('please reply')]);
    if (previous) store.put('gmail-personal', 't1', { verdict: previous, noul: 0.2, stateHash: 'old', lines: null, anchor: null });
    const watch = watchNewConversations({
      cache,
      store,
      muted: () => false,
      ask: async () => ({ answers: { needs_attention: { type: 'noul', noul: 0.91 } } }),
      notify: async input => { sent.push(input.title); },
    });
    try {
      await settle();
      assert.equal(store.get('gmail-personal', 't1')?.verdict, 'yes');
    } finally {
      watch.stop();
      db.close();
    }
  }
  await run('no');
  assert.equal(sent.length, 1);
  const afterNo = sent.length;
  await run(null);
  assert.equal(sent.length, afterNo);
});

test('with the flag clear, the same lines are not asked again and a yes that stays yes does not push', async () => {
  const db = new Database(':memory:');
  const cache = createInboxCache(db);
  const store = createAttentionStore(db);
  const asked: string[] = [];
  const pushed: string[] = [];
  const watch = watchNewConversations({
    cache,
    store,
    muted: () => false,
    ask: async input => {
      asked.push(String((input.state as { preview: string }).preview));
      return { answers: { needs_attention: { type: 'noul', noul: 0.91 } } };
    },
    notify: async input => { pushed.push(input.title); },
  });
  try {
    cache.save('gmail-personal', [row('please reply', 1)]);
    await settle();
    assert.deepEqual(asked, ['please reply']);
    assert.equal(store.get('gmail-personal', 't1')?.verdict, 'yes');
    assert.deepEqual(pushed, []);
    cache.save('gmail-personal', [row('please reply', 1)]);
    await settle();
    assert.deepEqual(asked, ['please reply']);
    cache.save('gmail-personal', [row('a new line', 2)]);
    await settle();
    assert.deepEqual(asked, ['please reply', 'a new line']);
    assert.equal(store.get('gmail-personal', 't1')?.verdict, 'yes');
    assert.deepEqual(pushed, []);
  } finally {
    watch.stop();
    db.close();
  }
});

test('decisionToShow stays empty without Decisions, muted or not', () => {
  assert.equal(decisionToShow(false, 'yes'), null);
  assert.equal(decisionToShow(false, 'no'), null);
});

test('a push that throws leaves the needed verdict stored', async () => {
  const db = new Database(':memory:');
  const cache = createInboxCache(db);
  const store = createAttentionStore(db);
  const lines: string[] = [];
  cache.save('whatsapp', [{ account: 'whatsapp', id: 'chat', title: 'Ada', preview: 'please reply', date: 2, unread: true }]);
  cache.saveThread('whatsapp', 'chat', [{ sender: 'Ada', text: 'please reply', fromMe: false }]);
  store.put('whatsapp', 'chat', { verdict: 'no', noul: 0.2, stateHash: 'old', lines: null, anchor: null });
  const watch = watchNewConversations({
    cache,
    store,
    debounceMs: 0,
    log: line => lines.push(line),
    ask: async () => ({ answers: { line_1: { noul: 0.91 } } }),
    notify: async () => { throw new Error('plugin is not installed'); },
  });
  try {
    await settle();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(store.get('whatsapp', 'chat')?.verdict, 'yes');
    assert.match(lines.join('\n'), /plugin is not installed/);
  } finally {
    watch.stop();
    db.close();
  }
});

test('a follow-up you sent that was scored as your task is asked again', async () => {
  const db = new Database(':memory:');
  const cache = createInboxCache(db);
  const store = createAttentionStore(db);
  const mine = { sender: 'You', text: 'Let me know what works for you this week.', fromMe: true };
  cache.save('linkedin', [{ account: 'linkedin', id: 'chat', title: 'Dylan', preview: mine.text, date: 2, unread: false, sentSnippet: mine.text }]);
  cache.saveThread('linkedin', 'chat', [mine]);
  store.put('linkedin', 'chat', {
    verdict: 'yes',
    noul: 0.75,
    stateHash: 'old',
    lines: { [lineKey(mine.text, true)]: 0.75 },
    anchor: null,
    taskAsked: true,
  });
  db.prepare(`UPDATE inbox_attention SET lines = json_set(lines, '$.task', 1) WHERE account = 'linkedin' AND id = 'chat'`).run();
  const watch = watchNewConversations({
    cache,
    store,
    debounceMs: 0,
    ask: async input => {
      assert.deepEqual(Object.keys(input.questions), ['line_1']);
      return { answers: { line_1: { noul: 0.12 } } };
    },
  });
  try {
    await settle();
    assert.equal(store.get('linkedin', 'chat')?.verdict, 'no');
    assert.equal(store.get('linkedin', 'chat')?.noul, 0.12);
  } finally {
    watch.stop();
    db.close();
  }
});

test('your latest line is asked as a task you left, and that score is the conversation', async () => {
  const db = new Database(':memory:');
  const cache = createInboxCache(db);
  const store = createAttentionStore(db);
  const open = { sender: 'Omar', text: 'Can you take a look?', fromMe: false };
  const mine = { sender: 'You', text: 'I will read it today.', fromMe: true };
  cache.save('linkedin', [{ account: 'linkedin', id: 'chat', title: 'Omar', preview: mine.text, date: 2, unread: false, sentSnippet: mine.text }]);
  cache.saveThread('linkedin', 'chat', [open, mine]);
  store.put('linkedin', 'chat', {
    verdict: 'yes',
    noul: 0.95,
    stateHash: 'old',
    lines: { [lineKey(open.text, false)]: 0.91, [lineKey(mine.text, true)]: 0.95 },
    anchor: null,
  });
  let criteria: { true: string; false: string } | undefined;
  const watch = watchNewConversations({
    cache,
    store,
    debounceMs: 0,
    ask: async input => {
      const keys = Object.keys(input.questions);
      assert.deepEqual(keys, ['line_2']);
      criteria = input.questions.line_2.criteria;
      return { answers: { line_2: { noul: 0.12 } } };
    },
  });
  try {
    await settle();
    assert.match(criteria?.false ?? '', /let the reader know/);
    assert.equal(store.get('linkedin', 'chat')?.verdict, 'no');
    assert.equal(store.get('linkedin', 'chat')?.noul, 0.12);
  } finally {
    watch.stop();
    db.close();
  }
});

async function settle(): Promise<void> {
  for (let turn = 0; turn < 20; turn++) await Promise.resolve();
}
