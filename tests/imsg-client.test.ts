import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ImsgClient } from '../src/imsg-client.ts';

async function fixture(source: string) {
  const dir = await mkdtemp(join(tmpdir(), 'imsg-test-'));
  const path = join(dir, 'imsg');
  await writeFile(path, `#!${process.execPath}\n${source}`);
  await chmod(path, 0o700);
  return { path, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test('correlates out-of-order responses and permits only reads', async () => {
  const f = await fixture(`
    const rl = require('node:readline').createInterface({ input: process.stdin });
    const requests = [];
    rl.on('line', line => {
      requests.push(JSON.parse(line));
      if (requests.length === 2) {
        for (const r of requests.reverse()) process.stdout.write(JSON.stringify({jsonrpc:'2.0', id:r.id, result:r.method}) + '\\n');
      }
    });
  `);
  const client = new ImsgClient(f.path);
  try {
    assert.deepEqual(await Promise.all([client.request('status'), client.request('chats.list')]), ['status', 'chats.list']);
    await assert.rejects(client.request('messages.delete', { id: '1' }), /not permitted/);
  } finally { client.dispose(); await f.cleanup(); }
});

test('rejects malformed output and can start a new child', async () => {
  const f = await fixture(`process.stdin.once('data', () => process.stdout.write('not json\\n'));`);
  const client = new ImsgClient(f.path);
  try {
    await assert.rejects(client.request('status'), /Invalid Messages response/);
    await assert.rejects(client.request('status'), /Invalid Messages response/);
  } finally { client.dispose(); await f.cleanup(); }
});

test('permits send and tapback, and rejects every other mutation', async () => {
  const f = await fixture(`
    const rl = require('node:readline').createInterface({ input: process.stdin });
    rl.on('line', line => {
      const r = JSON.parse(line);
      process.stdout.write(JSON.stringify({jsonrpc:'2.0', id:r.id, result:r.method}) + '\\n');
    });
  `);
  const client = new ImsgClient(f.path);
  try {
    assert.equal(await client.request('send', { chat_id: 1, text: 'hi' }), 'send');
    assert.equal(await client.request('tapback', { message_guid: 'g', kind: 'like' }), 'tapback');
    await assert.rejects(client.request('react', { message_guid: 'g' }), /not permitted/);
    await assert.rejects(client.request('send.rich', { chat_id: 1, text: 'hi' }), /not permitted/);
    await assert.rejects(client.request('messages.delete', { id: '1' }), /not permitted/);
  } finally { client.dispose(); await f.cleanup(); }
});

test('a bridge failure keeps the word bridge and drops the rest of the message', async () => {
  const f = await fixture(`
    const rl = require('node:readline').createInterface({ input: process.stdin });
    rl.on('line', line => {
      const r = JSON.parse(line);
      process.stdout.write(JSON.stringify({jsonrpc:'2.0', id:r.id, error:{code:-32603, message:'The bridge is required at /Users/secret/chat.db'}}) + '\\n');
    });
  `);
  const client = new ImsgClient(f.path);
  try {
    await assert.rejects(client.request('tapback', { message_guid: 'g', kind: 'like' }), /bridge is required/);
    await assert.rejects(client.request('send', { chat_id: 1, text: 'hi' }), (error: Error) => {
      assert.match(error.message, /bridge is required/);
      assert.equal(error.message.includes('/Users/secret'), false);
      return true;
    });
  } finally { client.dispose(); await f.cleanup(); }
});

test('reports missing executable without exposing diagnostics', async () => {
  const client = new ImsgClient('/nonexistent/imsg');
  try { await assert.rejects(client.request('status'), /backend unavailable/); }
  finally { client.dispose(); }
});

test('timeout and disposal settle pending calls', async () => {
  const f = await fixture(`process.stdin.resume();`);
  const client = new ImsgClient(f.path, 30);
  try {
    await assert.rejects(client.request('status'), /timed out/);
    const pending = client.request('status');
    client.dispose();
    await assert.rejects(pending, /closed/);
    await assert.rejects(client.request('status'), /closed/);
  } finally { client.dispose(); await f.cleanup(); }
});
