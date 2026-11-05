// U2 — media fetched from the stored envelope, and the failure classification carried across intact.
// The bytes come from Baileys with no socket of this module's own; the lesson pinned here is the one
// docs/bugs/2026-11-04-media-download-failure-is-not-temporary.md records: a WhatsApp-side miss is
// terminal, and a retriable failure must not be stored as one.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import type { WAMessage } from 'baileys';
import { handleMessagesUpsert } from '../../src/whatsapp/ingest.ts';
import { classifyMediaFailure, downloadAndCacheMedia, MediaDownloadFailure } from '../../src/whatsapp/media.ts';
import { createWhatsAppStore } from '../../src/whatsapp/store.ts';

const DAY = 86_400;

function storedImage() {
  const db = new Database(':memory:');
  const store = createWhatsAppStore(db);
  handleMessagesUpsert(store, {
    type: 'notify',
    messages: [
      {
        key: { id: 'IMG1', remoteJid: 'alice@s.whatsapp.net', fromMe: false },
        messageTimestamp: 1_700_000_000,
        message: { imageMessage: { mimetype: 'image/jpeg' } },
      } as unknown as WAMessage,
    ],
  });
  return { db, store };
}

test('a stored image downloads once, is written under media/, and the row says ready', async () => {
  const { db, store } = storedImage();
  try {
    const dataDir = mkdtempSync(join(tmpdir(), 'wa-media-'));
    let downloads = 0;
    const result = await downloadAndCacheMedia(store, 'IMG1', {
      dataDir,
      download: async () => {
        downloads += 1;
        return Buffer.from('jpeg bytes');
      },
    });

    assert.equal(downloads, 1);
    assert.equal(result.bytes, 10);
    assert.deepEqual(readFileSync(join(dataDir, result.mediaRef)), Buffer.from('jpeg bytes'));
    assert.equal(statSync(join(dataDir, result.mediaRef)).mode & 0o777, 0o600);
    assert.equal(store.getMessage('IMG1')?.media_state, 'ready');
    assert.equal(store.getMessage('IMG1')?.media_ref, result.mediaRef);
  } finally {
    db.close();
  }
});

test('a refusal is stored with its reason, and the caller is told which one', async () => {
  const { db, store } = storedImage();
  try {
    const dataDir = mkdtempSync(join(tmpdir(), 'wa-media-'));
    const refused = Object.assign(new Error('gone'), { statusCode: 404 });
    await assert.rejects(
      downloadAndCacheMedia(store, 'IMG1', { dataDir, download: async () => { throw refused; } }),
      (error: unknown) => error instanceof MediaDownloadFailure && error.reason === 'unavailable',
    );
    assert.equal(store.getMessage('IMG1')?.media_state, 'failed');
    assert.equal(store.getMessage('IMG1')?.media_error, 'unavailable');
  } finally {
    db.close();
  }
});

test('an unknown message or a row with no envelope is a plain error, not a media failure', async () => {
  const { db, store } = storedImage();
  try {
    const dataDir = mkdtempSync(join(tmpdir(), 'wa-media-'));
    await assert.rejects(downloadAndCacheMedia(store, 'NOPE', { dataDir }), /Unknown message/);
    db.prepare("UPDATE wa_messages SET raw = NULL WHERE id = 'IMG1'").run();
    await assert.rejects(downloadAndCacheMedia(store, 'IMG1', { dataDir }), /no raw envelope/);
  } finally {
    db.close();
  }
});

test('the failure classification: 404/410 terminal, the rest retriable until the serve window has passed', () => {
  const now = 1_700_000_000_000 + 1 * DAY * 1000;
  const messageTs = 1_700_000_000; // seconds
  assert.equal(classifyMediaFailure({ statusCode: 404 }), 'unavailable');
  assert.equal(classifyMediaFailure({ output: { statusCode: 410 } }), 'unavailable');
  assert.equal(classifyMediaFailure({ statusCode: 500 }, { messageTs, now }), 'transient');
  assert.equal(classifyMediaFailure({ statusCode: 412 }, { messageTs, now }), 'transient');
  assert.equal(classifyMediaFailure({ statusCode: 418 }, { messageTs, now }), 'transient');
  // Past the measured window a server-side refusal is the bytes being gone.
  assert.equal(classifyMediaFailure({ statusCode: 418 }, { messageTs, now: now + 14 * DAY * 1000 }), 'unavailable');
  // A connection error says nothing happened, so it is never terminal, at any age.
  assert.equal(classifyMediaFailure(new Error('ECONNRESET'), { messageTs, now: now + 100 * DAY * 1000 }), 'transient');
});
