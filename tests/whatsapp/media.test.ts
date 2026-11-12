// U2 — media fetched from the stored envelope, and the failure classification carried across intact.
// The bytes come from Baileys with no socket of this module's own; the lesson pinned here is the one
// docs/bugs/2026-11-04-media-download-failure-is-not-temporary.md records: a WhatsApp-side miss is
// terminal, and a retriable failure must not be stored as one.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import type { WAMessage } from 'baileys';
import { handleMessagesUpsert } from '../../src/whatsapp/ingest.ts';
import { classifyMediaFailure, discardCachedMedia, audioFacts, documentFacts, downloadAndCacheMedia, MediaDownloadFailure } from '../../src/whatsapp/media.ts';
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

test('a document answers its own name, size and type, and an unusable envelope answers nothing', () => {
  const envelope = (message: unknown) => JSON.stringify({ key: { id: 'D1' }, message });
  assert.deepEqual(
    documentFacts(envelope({ documentWithCaptionMessage: { message: { documentMessage: { fileName: ' Contract v2.pdf ', mimetype: 'application/pdf', fileLength: 1024 } } } })),
    { filename: 'Contract v2.pdf', size: 1024, mime: 'application/pdf' },
    'the wrapper WhatsApp actually sends is unwrapped, and the name is trimmed',
  );
  assert.deepEqual(documentFacts(envelope({ imageMessage: { mimetype: 'image/jpeg' } })), undefined, 'a picture is not a document');
  assert.deepEqual(documentFacts(envelope({ documentMessage: { fileName: 'no-mime.zip' } })), { filename: 'no-mime.zip' });
  assert.deepEqual(documentFacts(null), undefined);
  assert.deepEqual(documentFacts('{ not json'), undefined, 'a row whose envelope will not parse is a read without facts, not a crash');
});

// The shape a stored row actually holds, taken from a live `wa_messages.raw`: BufferJSON writes a Long
// as its decimal string, so `toNumber` never saw a `Long` in production and threw
// `r.toNumber is not a function` on every document read. The fixture above used a number and missed it.
test('a document size survives the round trip through the store as a decimal string', () => {
  const raw = JSON.stringify({ message: { documentMessage: { fileName: 'Invoice.pdf', mimetype: 'application/pdf', fileLength: '6813813' } } });
  assert.deepEqual(documentFacts(raw), { filename: 'Invoice.pdf', size: 6813813, mime: 'application/pdf' });
  // A long that arrives as {low, high}, and one that is nonsense: a count or nothing, never a throw.
  assert.equal(documentFacts(JSON.stringify({ message: { documentMessage: { fileName: 'a.bin', fileLength: { low: 1024, high: 0 } } } }))?.size, 1024);
  assert.equal(documentFacts(JSON.stringify({ message: { documentMessage: { fileName: 'b.bin', fileLength: 'not a count' } } }))?.size, undefined);
});

// The voice notes in a live account, reduced to the four fields their envelopes hold.
test('a voice note answers its length, its voice flag, its type and its declared size', () => {
  const envelope = (message: unknown) => JSON.stringify({ key: { id: 'A1' }, message });
  assert.deepEqual(
    audioFacts(envelope({ audioMessage: { mimetype: 'audio/ogg; codecs=opus', fileLength: '175401', seconds: 69, ptt: true } })),
    { seconds: 69, voice: true, size: 175_401, mime: 'audio/ogg; codecs=opus' },
    'the largest size the account declares, as the store writes it: a decimal string',
  );
  assert.deepEqual(
    audioFacts(envelope({ audioMessage: { mimetype: 'audio/mp4', seconds: 12, ptt: false } })),
    { seconds: 12, mime: 'audio/mp4' },
    'a forwarded audio file is the same type without the flag, so it is drawn as an audio file',
  );
  assert.deepEqual(audioFacts(envelope({ audioMessage: { fileLength: 5_184 } })), { size: 5_184 }, 'a partial envelope answers what it has');
  assert.deepEqual(audioFacts(envelope({ audioMessage: { seconds: 0 } })), {}, 'a zero length is not a length');
  assert.deepEqual(audioFacts(envelope({ imageMessage: { mimetype: 'image/jpeg' } })), undefined, 'a picture is not a voice note');
  assert.deepEqual(audioFacts(null), undefined);
  assert.deepEqual(audioFacts('{ not json'), undefined, 'an envelope that will not parse is a read without facts, not a crash');
});

test('a document is cached as the file it was sent as, and a strange name still stays inside media/', async () => {
  const db = new Database(':memory:');
  const store = createWhatsAppStore(db);
  try {
    handleMessagesUpsert(store, {
      type: 'notify',
      messages: [
        {
          key: { id: 'DOC1', remoteJid: 'alice@s.whatsapp.net', fromMe: false },
          messageTimestamp: 1_700_000_000,
          message: { documentMessage: { fileName: 'Contract v2.pdf', mimetype: 'application/pdf' } },
        } as unknown as WAMessage,
        {
          key: { id: 'DOC2', remoteJid: 'alice@s.whatsapp.net', fromMe: false },
          messageTimestamp: 1_700_000_001,
          // A sender chooses the name, so the extension is bounded and never a path.
          message: { documentMessage: { fileName: '../../../etc/passwd', mimetype: 'text/plain' } },
        } as unknown as WAMessage,
      ],
    });
    const dataDir = mkdtempSync(join(tmpdir(), 'wa-media-doc-'));
    const download = async () => Buffer.from('%PDF-1.4');

    const first = await downloadAndCacheMedia(store, 'DOC1', { dataDir, download });
    assert.match(first.mediaRef, /^media\/[0-9a-f]{64}\.pdf$/, `a document keeps its own extension, got ${first.mediaRef}`);
    assert.equal(readFileSync(join(dataDir, first.mediaRef), 'utf8'), '%PDF-1.4');

    const second = await downloadAndCacheMedia(store, 'DOC2', { dataDir, download });
    assert.ok(second.mediaRef.startsWith(join('media', '')), 'the ref stays under media/');
    assert.equal(second.mediaRef.includes('passwd'), false, 'a path in the name never becomes part of the path');
    assert.equal(statSync(join(dataDir, second.mediaRef)).mode & 0o777, 0o600);
  } finally {
    db.close();
  }
});

test('a discarded entry takes its file and its ref together, and a ref outside media/ is never removed', async () => {
  const { db, store } = storedImage();
  try {
    const dataDir = mkdtempSync(join(tmpdir(), 'wa-discard-'));
    const { mediaRef } = await downloadAndCacheMedia(store, 'IMG1', { dataDir, download: async () => Buffer.from('jpeg bytes') });
    assert.ok(existsSync(join(dataDir, mediaRef)));

    assert.equal(discardCachedMedia(store, 'IMG1', dataDir), true, 'a refusal of what landed can undo the download');
    assert.equal(existsSync(join(dataDir, mediaRef)), false);
    assert.equal(store.getMessage('IMG1')?.media_ref, null);
    assert.equal(store.getMessage('IMG1')?.media_state, 'placeholder');
    assert.equal(discardCachedMedia(store, 'IMG1', dataDir), false, 'a second discard has nothing to take back');

    // A ref that walks out of the cache directory names a file this module did not write.
    writeFileSync(join(dataDir, 'outside.txt'), 'keep me');
    store.setMediaRef('IMG1', join('..', 'outside.txt'));
    assert.equal(discardCachedMedia(store, 'IMG1', dataDir), false);
    assert.ok(existsSync(join(dataDir, 'outside.txt')), 'a path outside media/ is left alone');
    assert.equal(discardCachedMedia(store, 'no-such-message', dataDir), false);
  } finally {
    db.close();
  }
});
