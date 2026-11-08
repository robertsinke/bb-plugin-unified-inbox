// INBOX-9 / U1: the plugin owns its Gmail credential. These tests use real files in a temp
// directory and a fake token endpoint — no network, no CLI.
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  createGmailCredentials,
  gmailCredentialPath,
  settleLegacyGmailAccounts,
  TOKEN_EXPIRY_MARGIN_MS,
  type GmailCredentialRecord,
  type TokenFetch,
} from '../src/gmail-oauth.ts';
import { pauseAccountWrites, resumeAccountWrites, accountWritesPaused } from '../src/inbox-cache.ts';
import { redactProviderText } from '../src/adapters/provider-error.ts';

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

test('a deleted client is not asked again until the record is replaced', async () => {
  const dir = await tempDir();
  const path = await seed(dir, { access_token: 'ya29.stale', expires_at: NOW - 1 });
  const { fetch, calls } = fakeTokenEndpoint({
    status: 401,
    body: { error: 'deleted_client', error_description: 'The OAuth client was deleted.' },
  });
  const credentials = createGmailCredentials({ dir, fetch, now: () => NOW });

  await assert.rejects(credentials.accessToken('gmail-personal'), (error: Error & { reason?: string }) => {
    assert.equal(error.reason, 'deleted_client');
    return true;
  });
  assert.equal(calls.length, 1);

  await assert.rejects(credentials.accessToken('gmail-personal', { force: true }), (error: Error & { reason?: string }) => {
    assert.equal(error.reason, 'deleted_client');
    return true;
  });
  assert.equal(calls.length, 1, 'a dead client does not call Google again');

  const stored = JSON.parse(await readFile(path, 'utf8')) as GmailCredentialRecord;
  assert.equal(stored.lastError?.reason, 'deleted_client');

  await credentials.write('gmail-personal', record({ access_token: 'ya29.replaced', expires_at: NOW + HOUR }));
  assert.equal(await credentials.accessToken('gmail-personal'), 'ya29.replaced');
  assert.equal(calls.length, 1, 'a replaced record is used without another refusal');
});

test('a missing record is a clear error, not ENOENT text', async () => {
  const dir = await tempDir();
  const { fetch, calls } = fakeTokenEndpoint();
  const credentials = createGmailCredentials({ dir, fetch, now: () => NOW });

  await assert.rejects(credentials.read('gmail-business'), (error: Error) => {
    // Pinned verbatim (INBOX-16): the fix is the command, and a path here would be redacted into
    // `expected [redacted]/gmail-business.json` before the panel ever shows it.
    assert.equal(
      error.message,
      'No Gmail credential for gmail-business; run bb unified-inbox import-gws-account gmail-business',
    );
    assert.match(error.message, /no gmail credential for gmail-business/i);
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

test('a corrupt record names the fix, and the fix survives scrubbing', async () => {
  const dir = await tempDir();
  const { fetch } = fakeTokenEndpoint();
  const credentials = createGmailCredentials({ dir, fetch, now: () => NOW });
  await writeFile(gmailCredentialPath('gmail-personal', dir), '{not json', { mode: 0o600 });

  await assert.rejects(credentials.read('gmail-personal'), (error: Error) => {
    // Pinned verbatim: the panel never shows a filesystem path (redactProviderText scrubs it), so
    // the message has to carry the command that replaces the file instead.
    assert.equal(
      error.message,
      'Gmail credential for gmail-personal is not valid JSON; run bb unified-inbox import-gws-account gmail-personal --force',
    );
    assert.doesNotMatch(error.message, /\/(Users|\.bb)\//);
    return true;
  });
});

test('every "run this command" message survives redaction unchanged', () => {
  // The class, not the instance: a message that names a command must come out of the scrubber
  // byte-identical, or the panel shows the reader something they cannot type.
  for (const account of ['gmail-personal', 'gmail-business'] as const) {
    for (const message of [
      `No Gmail credential for ${account}; run bb unified-inbox import-gws-account ${account}`,
      `Gmail credential for ${account} is not valid JSON; run bb unified-inbox import-gws-account ${account} --force`,
    ]) assert.equal(redactProviderText(message), message);
  }
});

async function writeCredential(dir: string, account: string, value: GmailCredentialRecord) {
  await writeFile(join(dir, `${account}.json`), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

test('a profile read publishes the mailbox file and a later start does not ask Google again', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gmail-settle-'));
  const moved: string[] = [];
  let profiles = 0;
  const token = fakeTokenEndpoint({ body: { access_token: 'ya29.new', expires_in: 3600, scope: 'https://www.googleapis.com/auth/gmail.readonly' } });
  const personal = record({ lastError: { at: 1, message: 'old' } });
  await writeCredential(dir, 'gmail-personal', personal);
  try {
    const first = await settleLegacyGmailAccounts({
      dir, fetch: token.fetch, now: () => NOW,
      profile: async () => { profiles += 1; return 'Ada@Example.com'; },
      moveRows: (from, to) => moved.push(`${from}->${to}`),
    });
    assert.deepEqual(moved, ['gmail-personal->ada@example.com']);
    assert.equal(profiles, 1);
    assert.equal(existsSync(join(dir, 'gmail-personal.json')), false);
    const published = JSON.parse(await readFile(join(dir, 'ada@example.com.json'), 'utf8')) as GmailCredentialRecord & { legacy?: string };
    assert.equal(published.access_token, 'ya29.new');
    assert.equal(published.client_id, personal.client_id);
    assert.equal(published.legacy, undefined);
    assert.equal(published.lastError, undefined);
    assert.match(token.calls[0].body, /client_id=client-123/);
    assert.deepEqual(first.accounts, ['ada@example.com']);
    assert.equal(first.legacy['gmail-personal'], 'ada@example.com');
    const second = await settleLegacyGmailAccounts({
      dir, fetch: token.fetch, now: () => NOW,
      profile: async () => { profiles += 1; throw new Error('google down'); },
    });
    assert.equal(profiles, 1, 'the email file is already published');
    assert.equal(token.calls.length, 1);
    assert.deepEqual(second.accounts, ['ada@example.com']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a failed profile leaves the legacy file and writes no mailbox file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gmail-settle-fail-'));
  const before = record({ lastError: { at: 9, message: 'kept', reason: 'deleted_client' } });
  await writeCredential(dir, 'gmail-personal', before);
  const token = fakeTokenEndpoint({ status: 400, body: { error: 'invalid_grant' } });
  try {
    const settled = await settleLegacyGmailAccounts({
      dir, fetch: token.fetch, now: () => NOW,
      profile: async () => 'ada@example.com',
    });
    const after = JSON.parse(await readFile(join(dir, 'gmail-personal.json'), 'utf8')) as GmailCredentialRecord;
    assert.deepEqual(after.lastError, before.lastError);
    assert.equal(existsSync(join(dir, 'ada@example.com.json')), false);
    assert.deepEqual(settled.accounts, ['gmail-personal']);
    assert.equal(settled.legacy['gmail-personal'], undefined);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('both files move leftover rows without calling Google, and a paused save does not recreate the legacy id', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gmail-settle-pair-'));
  const shared = record({ refresh_token: 'same-refresh' });
  await writeCredential(dir, 'gmail-personal', { ...shared, lastError: { at: 1, message: 'stale' } });
  await writeCredential(dir, 'ada@example.com', shared);
  const token = fakeTokenEndpoint();
  let profiles = 0;
  let paused = false;
  try {
    const settled = await settleLegacyGmailAccounts({
      dir, fetch: token.fetch, now: () => NOW,
      profile: async () => { profiles += 1; return 'ada@example.com'; },
      moveRows: () => {
        assert.equal(accountWritesPaused('gmail-personal'), true);
        paused = true;
      },
      pause: pauseAccountWrites,
      resume: resumeAccountWrites,
    });
    assert.equal(profiles, 0);
    assert.equal(token.calls.length, 0);
    assert.equal(paused, true);
    assert.equal(accountWritesPaused('gmail-personal'), false);
    assert.equal(existsSync(join(dir, 'gmail-personal.json')), false);
    assert.equal(existsSync(join(dir, 'ada@example.com.json')), true);
    assert.deepEqual(settled.accounts, ['ada@example.com']);
  } finally {
    resumeAccountWrites('gmail-personal');
    await rm(dir, { recursive: true, force: true });
  }
});

test('two legacy files for one address keep the first and report the loser', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gmail-settle-conflict-'));
  const seen: string[] = [];
  await writeCredential(dir, 'gmail-personal', record({ refresh_token: 'personal-refresh' }));
  await writeCredential(dir, 'gmail-business', record({ refresh_token: 'business-refresh', client_id: 'other-client.apps.googleusercontent.com' }));
  const businessBefore = await readFile(join(dir, 'gmail-business.json'), 'utf8');
  const token = fakeTokenEndpoint({ body: { access_token: 'ya29.new', expires_in: 3600 } });
  try {
    const settled = await settleLegacyGmailAccounts({
      dir, fetch: token.fetch, now: () => NOW,
      profile: async () => {
        seen.push('profile');
        if (seen.length === 1) {
          assert.equal(existsSync(join(dir, 'gmail-personal.json')), true, 'both legacy files are listed before the first profile read');
          assert.equal(existsSync(join(dir, 'gmail-business.json')), true);
        }
        return 'ada@example.com';
      },
    });
    assert.equal(seen.length, 2, 'each legacy file is asked once');
    assert.equal(existsSync(join(dir, 'gmail-personal.json')), false);
    assert.equal(await readFile(join(dir, 'gmail-business.json'), 'utf8'), businessBefore);
    assert.equal(existsSync(join(dir, 'ada@example.com.json')), true);
    assert.deepEqual(settled.accounts, ['ada@example.com']);
    assert.deepEqual(settled.conflicts, [{ account: 'gmail-business', address: 'ada@example.com' }]);
    const again = await settleLegacyGmailAccounts({
      dir, fetch: token.fetch, now: () => NOW,
      profile: async () => { throw new Error('must not ask'); },
    });
    assert.equal(existsSync(join(dir, 'gmail-business.json')), true);
    assert.deepEqual(again.accounts, ['ada@example.com']);
    assert.equal(again.conflicts.length, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
