// INBOX-9 / U1: the plugin owns its Gmail credential. These tests use real files in a temp
// directory and a fake token endpoint — no network, no CLI.
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  createGmailCredentials,
  gmailCredentialPath,
  TOKEN_EXPIRY_MARGIN_MS,
  type GmailCredentialRecord,
  type TokenFetch,
} from '../src/gmail-oauth.ts';

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;

function record(overrides: Partial<GmailCredentialRecord> = {}): GmailCredentialRecord {
  return {
    client_id: 'client-123.apps.googleusercontent.com',
    client_secret: 'secret-123',
    refresh_token: 'refresh-123',
    source: 'gws-import',
    ...overrides,
  };
}

/** A token endpoint that counts calls and answers with a fixed grant. */
function fakeTokenEndpoint(answer: { status?: number; body?: unknown } = {}) {
  const calls: { url: string; body: string }[] = [];
  const fetch: TokenFetch = async (url, init) => {
    calls.push({ url, body: init.body });
    const status = answer.status ?? 200;
    return { ok: status >= 200 && status < 300, status, json: async () => answer.body };
  };
  return { fetch, calls };
}

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'inbox-gmail-oauth-'));
}

/** Seed a record as a plain file: the store must read what another writer left, not just its own. */
async function seed(dir: string, seeded: Partial<GmailCredentialRecord> = {}): Promise<string> {
  const path = gmailCredentialPath('gmail-personal', dir);
  await writeFile(path, JSON.stringify(record(seeded), null, 2), { mode: 0o600 });
  return path;
}

test('an unexpired access token is handed out without calling the token endpoint', async () => {
  const dir = await tempDir();
  await seed(dir, { access_token: 'ya29.live', expires_at: NOW + HOUR });
  const { fetch, calls } = fakeTokenEndpoint();
  const credentials = createGmailCredentials({ dir, fetch, now: () => NOW });

  assert.equal(await credentials.accessToken('gmail-personal'), 'ya29.live');
  assert.equal(calls.length, 0);
});

test('a token inside the expiry margin is refreshed, and the new token and expiry are stored', async () => {
  const dir = await tempDir();
  const path = await seed(dir, { access_token: 'ya29.stale', expires_at: NOW + TOKEN_EXPIRY_MARGIN_MS - 1000 });
  const { fetch, calls } = fakeTokenEndpoint({ body: { access_token: 'ya29.fresh', expires_in: 3599, scope: 'https://mail.google.com/' } });
  const credentials = createGmailCredentials({ dir, fetch, now: () => NOW });

  assert.equal(await credentials.accessToken('gmail-personal'), 'ya29.fresh');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, 'https://oauth2.googleapis.com/token');
  assert.match(calls[0]?.body ?? '', /grant_type=refresh_token/);
  assert.match(calls[0]?.body ?? '', /refresh_token=refresh-123/);

  const stored = JSON.parse(await readFile(path, 'utf8')) as GmailCredentialRecord;
  assert.equal(stored.access_token, 'ya29.fresh');
  assert.equal(stored.expires_at, NOW + 3599 * 1000);
  assert.deepEqual(stored.scopes, ['https://mail.google.com/']);
  assert.equal(stored.client_id, record().client_id);
  assert.equal(stored.refresh_token, 'refresh-123');
  assert.equal(stored.source, 'gws-import');

  // and the stored token is served from the record next time
  assert.equal(await credentials.accessToken('gmail-personal'), 'ya29.fresh');
  assert.equal(calls.length, 1);
});

test('concurrent calls during an expired token produce exactly one token request', async () => {
  const dir = await tempDir();
  await seed(dir, { access_token: 'ya29.stale', expires_at: NOW - 1 });
  let resolveGrant: (() => void) | null = null;
  let tokenRequests = 0;
  let grantStarted: () => void = () => {};
  const started = new Promise<void>(resolve => { grantStarted = resolve; });
  const fetch: TokenFetch = async () => {
    tokenRequests += 1;
    grantStarted();
    await new Promise<void>(resolve => { resolveGrant = resolve; });
    return { ok: true, status: 200, json: async () => ({ access_token: 'ya29.fresh', expires_in: 3600 }) };
  };
  const credentials = createGmailCredentials({ dir, fetch, now: () => NOW });

  const first = credentials.accessToken('gmail-personal');
  const second = credentials.accessToken('gmail-personal');
  const third = credentials.accessToken('gmail-personal');
  await started;
  assert.equal(tokenRequests, 1);
  resolveGrant!();

  assert.deepEqual(await Promise.all([first, second, third]), ['ya29.fresh', 'ya29.fresh', 'ya29.fresh']);
  assert.equal(tokenRequests, 1);
});

test('a rejected grant surfaces its status and provider reason and marks the record, keeping the file', async () => {
  const dir = await tempDir();
  const path = await seed(dir, { access_token: 'ya29.stale', expires_at: NOW - 1 });
  const { fetch } = fakeTokenEndpoint({
    status: 400,
    body: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' },
  });
  const credentials = createGmailCredentials({ dir, fetch, now: () => NOW });

  await assert.rejects(credentials.accessToken('gmail-personal'), (error: Error & { status?: number; reason?: string }) => {
    assert.equal(error.status, 400);
    assert.equal(error.reason, 'invalid_grant');
    assert.match(error.message, /invalid_grant/);
    return true;
  });

  assert.ok(existsSync(path), 'a dead credential stays on disk so it can be repaired');
  const stored = JSON.parse(await readFile(path, 'utf8')) as GmailCredentialRecord;
  assert.equal(stored.refresh_token, 'refresh-123');
  assert.equal(stored.client_id, record().client_id);
  assert.ok(stored.lastError, 'the failure is recorded');
  assert.equal(stored.lastError?.at, NOW);
  assert.match(stored.lastError?.message ?? '', /invalid_grant/);

  const state = await credentials.status('gmail-personal');
  assert.equal(state.present, true);
  assert.equal(state.hasRefreshToken, true);
  assert.match(state.lastError?.message ?? '', /invalid_grant/);
});

test('a missing record is a clear error, not ENOENT text', async () => {
  const dir = await tempDir();
  const { fetch, calls } = fakeTokenEndpoint();
  const credentials = createGmailCredentials({ dir, fetch, now: () => NOW });

  await assert.rejects(credentials.read('gmail-business'), (error: Error) => {
    assert.match(error.message, /no gmail credential for gmail-business/i);
    assert.match(error.message, /gmail-business\.json/);
    assert.doesNotMatch(error.message, /ENOENT/);
    return true;
  });
  await assert.rejects(credentials.accessToken('gmail-business'), /no gmail credential/i);
  assert.equal(calls.length, 0);

  const state = await credentials.status('gmail-business');
  assert.deepEqual(state, { account: 'gmail-business', present: false, hasRefreshToken: false });
});

test('a written record is mode 0600 and a rewrite replaces it atomically', async () => {
  const dir = await tempDir();
  const { fetch } = fakeTokenEndpoint();
  const credentials = createGmailCredentials({ dir, fetch, now: () => NOW });
  const path = gmailCredentialPath('gmail-personal', dir);

  const first = record({ access_token: 'ya29.first', expires_at: NOW + HOUR });
  const second = record({ access_token: 'ya29.second', expires_at: NOW + 2 * HOUR });
  await credentials.write('gmail-personal', first);

  const mode = (await stat(path)).mode & 0o777;
  assert.equal(mode, 0o600, 'the credential is readable only by its owner');
  assert.deepEqual(await credentials.read('gmail-personal'), first);

  // A reader racing the rewrite never sees half a record: the path always names a complete file.
  let writing = true;
  let observed = 0;
  const reader = (async () => {
    while (writing) {
      const parsed = JSON.parse(await readFile(path, 'utf8')) as GmailCredentialRecord;
      assert.ok(parsed.access_token === 'ya29.first' || parsed.access_token === 'ya29.second');
      assert.equal(parsed.refresh_token, 'refresh-123');
      observed += 1;
      await new Promise(resolve => setImmediate(resolve));
    }
  })();
  for (let i = 0; i < 21; i += 1) await credentials.write('gmail-personal', i % 2 === 0 ? second : first);
  writing = false;
  await reader;

  assert.ok(observed > 0, 'the reader ran while the rewrites happened');
  const left = readdirSync(dir).filter(name => name.endsWith('.tmp'));
  assert.deepEqual(left, [], 'an atomic write leaves no partial file behind');
  assert.deepEqual(await credentials.read('gmail-personal'), second);
});
