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
    await assert.rejects(client.request('send', { text: 'no' }), /not permitted/);
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
