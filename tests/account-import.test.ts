// INBOX-12 / U4: the one-time import of a live `gws` credential. Real files in a temp directory, a
// fixture payload in place of the CLI — no `gws` process runs here and no real refresh token is ever
// written. The payload is the shape `gws auth export --unmasked` printed on this machine.
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { gwsConfigDir, importGwsAccount, parseGwsExport } from '../src/account-import.ts';
import { gmailCredentialPath, type GmailCredentialRecord } from '../src/gmail-oauth.ts';

const CLIENT_ID = 'client-123.apps.googleusercontent.com';
const CLIENT_SECRET = 'fixture-client-secret-value';
const REFRESH_TOKEN = '1//fixture-refresh-token-value';

/** The verified `gws auth export --unmasked` shape. */
function exportPayload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, refresh_token: REFRESH_TOKEN, type: 'authorized_user', ...overrides });
}

/** A payload source that records how often it was asked, so "the CLI never ran" is provable. */
function fixtureExport(payload: string) {
  const calls: string[] = [];
  return {
    calls,
    readExport: async (account: Parameters<typeof gwsConfigDir>[0]) => {
      calls.push(account);
      return payload;
    },
  };
}

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'inbox-account-import-'));
}

/** Seed a record the way a previous import or login would have left it. */
async function seed(dir: string, seeded: Partial<GmailCredentialRecord> = {}): Promise<string> {
  const path = gmailCredentialPath('gmail-business', dir);
  const record: GmailCredentialRecord = { client_id: CLIENT_ID, client_secret: CLIENT_SECRET, refresh_token: REFRESH_TOKEN, source: 'gws-import', ...seeded };
  await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  return path;
}

test('imports an account from an export payload as a 0600 gws-import record', async () => {
  const dir = await tempDir();
  const { readExport } = fixtureExport(exportPayload());

  const imported = await importGwsAccount({ account: 'gmail-business' }, { dir, readExport });

  assert.deepEqual(imported, { account: 'gmail-business', path: gmailCredentialPath('gmail-business', dir), replaced: false });
  const stored = JSON.parse(await readFile(imported.path, 'utf8')) as GmailCredentialRecord;
  assert.equal(stored.source, 'gws-import');
  assert.equal(stored.client_id, CLIENT_ID);
  assert.equal(stored.client_secret, CLIENT_SECRET);
  assert.equal(stored.refresh_token, REFRESH_TOKEN);
  // No access token is invented: the transport asks for one on its first read.
  assert.equal(stored.access_token, undefined);
  assert.equal((await stat(imported.path)).mode & 0o777, 0o600);
});

test('refuses to overwrite without --force, names the blocking account, and never runs the CLI', async () => {
  const dir = await tempDir();
  const path = await seed(dir);
  const before = await readFile(path, 'utf8');
  const { calls, readExport } = fixtureExport(exportPayload());

  await assert.rejects(
    importGwsAccount({ account: 'gmail-business' }, { dir, readExport }),
    (error: Error) => /gmail-business/.test(error.message) && /--force/.test(error.message),
  );
  assert.equal(calls.length, 0);
  assert.equal(await readFile(path, 'utf8'), before);
});

test('--force replaces the record and drops the previous access token and last error', async () => {
  const dir = await tempDir();
  const path = await seed(dir, { access_token: 'ya29.stale', expires_at: 1, lastError: { at: 1, message: 'invalid_grant' } });
  const { readExport } = fixtureExport(exportPayload());

  const imported = await importGwsAccount({ account: 'gmail-business', force: true }, { dir, readExport });

  assert.equal(imported.replaced, true);
  const stored = JSON.parse(await readFile(path, 'utf8')) as GmailCredentialRecord;
  assert.equal(stored.source, 'gws-import');
  assert.equal(stored.access_token, undefined);
  assert.equal(stored.lastError, undefined);
});

test('a masked export is rejected with --unmasked named, and leaves no file behind', async () => {
  const dir = await tempDir();
  const { calls, readExport } = fixtureExport(exportPayload({ client_secret: 'GOCS...ytLc' }));

  await assert.rejects(
    importGwsAccount({ account: 'gmail-personal' }, { dir, readExport }),
    (error: Error) => /client_secret/.test(error.message) && /--unmasked/.test(error.message),
  );
  assert.equal(calls.length, 1);
  assert.equal(existsSync(gmailCredentialPath('gmail-personal', dir)), false);
  assert.deepEqual(readdirSync(dir), []);
});

test('a masked refresh token is rejected the same way', async () => {
  const dir = await tempDir();
  const { readExport } = fixtureExport(exportPayload({ refresh_token: 'GOCS...ytLc' }));
  await assert.rejects(
    importGwsAccount({ account: 'gmail-personal' }, { dir, readExport }),
    (error: Error) => /refresh_token/.test(error.message) && /--unmasked/.test(error.message),
  );
});

test('a malformed export leaves the previous record byte-for-byte untouched', async () => {
  const dir = await tempDir();
  const path = await seed(dir);
  const before = await readFile(path, 'utf8');

  for (const payload of ['not json at all', 'null', '[]', exportPayload({ refresh_token: '' }), JSON.stringify({ client_id: CLIENT_ID })]) {
    const { readExport } = fixtureExport(payload);
    await assert.rejects(importGwsAccount({ account: 'gmail-business', force: true }, { dir, readExport }));
    assert.equal(await readFile(path, 'utf8'), before, `payload ${payload} changed the stored record`);
  }
});

test('neither the outcome nor a rejection ever carries a refresh token or client secret', async () => {
  const dir = await tempDir();
  const imported = await importGwsAccount({ account: 'gmail-personal' }, { dir, readExport: fixtureExport(exportPayload()).readExport });
  assert.ok(!JSON.stringify(imported).includes(REFRESH_TOKEN));
  assert.ok(!JSON.stringify(imported).includes(CLIENT_SECRET));

  const failures: string[] = [];
  const payloads = [exportPayload({ client_secret: 'GOCS...ytLc' }), exportPayload({ client_secret: '' }), 'nope'];
  for (const payload of payloads) {
    try {
      await importGwsAccount({ account: 'gmail-business', force: true }, { dir, readExport: fixtureExport(payload).readExport });
      assert.fail('expected the import to reject');
    } catch (error) {
      failures.push((error as Error).message);
    }
  }
  // The seeded personal record above is the one that blocks a non-forced run; read its message too.
  await assert.rejects(importGwsAccount({ account: 'gmail-personal' }, { dir, readExport: fixtureExport(exportPayload()).readExport }), (error: Error) => {
    failures.push(error.message);
    return true;
  });
  for (const message of failures) {
    assert.ok(!message.includes(REFRESH_TOKEN), `leaked the refresh token: ${message}`);
    assert.ok(!message.includes(CLIENT_SECRET), `leaked the client secret: ${message}`);
  }
});

test('parseGwsExport accepts the verified payload and refuses a wrong credential type', () => {
  assert.deepEqual(parseGwsExport(exportPayload(), 'gmail-business'), {
    client_id: CLIENT_ID, client_secret: CLIENT_SECRET, refresh_token: REFRESH_TOKEN,
  });
  assert.throws(() => parseGwsExport(exportPayload({ type: 'service_account' }), 'gmail-business'), /authorized_user/);
});

test('each account imports from its own gws config directory', () => {
  assert.equal(gwsConfigDir('gmail-business'), join(homedir(), '.config/gws-inhouse'));
  assert.equal(gwsConfigDir('gmail-personal'), join(homedir(), '.config/gws'));
});
