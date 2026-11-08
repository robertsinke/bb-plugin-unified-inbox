// U2: desktop sign-in against a fake token endpoint and a local listener. No call leaves the machine.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { createInboxCache } from '../src/inbox-cache.ts';
import {
  GMAIL_LOGIN_SCOPES,
  GMAIL_OAUTH_PAGE,
  connectGmailMailbox,
  cancelGmailLogin,
  tokenExchangeAllowed,
  type GmailLoginOptions,
} from '../src/gmail-login.ts';
import { createGmailCredentials, type GmailCredentialRecord, type TokenFetch } from '../src/gmail-oauth.ts';

const CLIENT_ID = 'client-123.apps.googleusercontent.com';
const CLIENT_SECRET = 'fixture-client-secret-value';
const REFRESH = '1//fixture-refresh-token-value';
const ACCESS = 'ya29.fixture-access-token';
const CODE = 'fixture-auth-code';
const ADDRESS = 'ada@example.com';

function s256(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'inbox-gmail-login-'));
}

function assertClean(text: string, label: string) {
  for (const secret of [CLIENT_SECRET, REFRESH, ACCESS, CODE]) {
    assert.equal(text.includes(secret), false, `${label} contains ${secret.slice(0, 8)}`);
  }
}

test('a challenge that was not on the authorization URL does not allow a token post', () => {
  const challenge = s256('verifier');
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  assert.equal(tokenExchangeAllowed(url.toString(), challenge), true);
  url.searchParams.delete('code_challenge');
  assert.equal(tokenExchangeAllowed(url.toString(), challenge), false);
});

test('desktop sign-in stores one login file and never returns a secret', async () => {
  const dir = await tempDir();
  const logs: string[] = [];
  const originals = [console.log, console.info, console.warn, console.error, console.debug] as const;
  console.log = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
  console.info = console.log;
  console.warn = console.log;
  console.error = console.log;
  console.debug = console.log;
  const posts: { url: string; body: string }[] = [];
  let opened = '';
  let page = '';
  let location = '';
  const errors: string[] = [];
  const fetchToken: TokenFetch = async (url, init) => {
    posts.push({ url, body: init.body });
    const redirect = new URLSearchParams(init.body).get('redirect_uri') ?? '';
    await assert.rejects(fetch(redirect), 'the listener is closed before the token post');
    return { ok: true, status: 200, json: async () => ({ access_token: ACCESS, refresh_token: REFRESH, expires_in: 3600, scope: GMAIL_LOGIN_SCOPES.join(' ') }) };
  };
  const base: GmailLoginOptions = {
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    dir,
    fetch: fetchToken,
    profile: async () => 'Ada@Example.com',
    userinfo: async () => { throw new Error('userinfo is not used when the profile has an address'); },
    timeoutMs: 2_000,
  };
  try {
    const result = await connectGmailMailbox({
      ...base,
      open: async url => {
        opened = url;
        const redirect = new URL(url).searchParams.get('redirect_uri') ?? '';
        assert.equal(new URL(redirect).hostname, '127.0.0.1');
        assert.equal(redirect.includes('localhost'), false);
        const other = await fetch(new URL('/favicon.ico', redirect));
        assert.equal(await other.text(), GMAIL_OAUTH_PAGE);
        const response = await fetch(`${redirect}?code=${CODE}&state=${new URL(url).searchParams.get('state')}`, { redirect: 'manual' });
        page = await response.text();
        location = response.headers.get('location') ?? '';
      },
    });
    assert.deepEqual(result, { account: ADDRESS, replaced: false, alreadyConnected: false });
    assertClean(JSON.stringify(result), 'rpc');
    assertClean(opened, 'opener');
    assertClean(page, 'page');
    assertClean(location, 'location');
    assert.equal(page, GMAIL_OAUTH_PAGE);
    assert.equal(location.includes('?'), false);
    assert.equal(opened.includes('prompt=consent'), true);
    assert.equal(opened.includes('code_challenge_method=S256'), true);
    for (const scope of GMAIL_LOGIN_SCOPES) assert.equal(opened.includes(encodeURIComponent(scope)), true);
    const auth = new URL(opened);
    const posted = new URLSearchParams(posts[0]?.body ?? '');
    assert.equal(s256(posted.get('code_verifier') ?? ''), auth.searchParams.get('code_challenge'));
    assert.equal(posted.get('redirect_uri'), auth.searchParams.get('redirect_uri'));
    assert.equal(posted.get('client_secret'), CLIENT_SECRET);
    assert.equal(posted.get('code'), CODE);
    const stored = JSON.parse(await readFile(join(dir, `${ADDRESS}.json`), 'utf8')) as GmailCredentialRecord;
    assert.equal(stored.source, 'login');
    assert.equal(stored.refresh_token, REFRESH);
    assert.equal(stored.client_id, CLIENT_ID);
    assert.equal(stored.client_secret, CLIENT_SECRET);
    const status = await createGmailCredentials({ dir }).status(ADDRESS);
    assert.equal(status.source, 'login');
    assert.equal(JSON.stringify(status).includes(REFRESH), false);
    assert.equal(JSON.stringify(status).includes(CLIENT_SECRET), false);
    for (const line of logs) assertClean(line, 'log');

    const before = await readFile(join(dir, `${ADDRESS}.json`), 'utf8');
    const again = await connectGmailMailbox({
      ...base,
      open: async url => {
        const redirect = new URL(url).searchParams.get('redirect_uri') ?? '';
        await fetch(`${redirect}?code=${CODE}&state=${new URL(url).searchParams.get('state')}`);
      },
    });
    assert.equal(again.alreadyConnected, true);
    assert.equal(await readFile(join(dir, `${ADDRESS}.json`), 'utf8'), before);

    await writeFile(join(dir, 'bob@example.com.json'), before);
    const bob = await readFile(join(dir, 'bob@example.com.json'), 'utf8');
    const replaced = await connectGmailMailbox({
      ...base,
      replace: true,
      clientSecret: 'replacement-client-secret',
      fetch: async (url, init) => {
        posts.push({ url, body: init.body });
        return { ok: true, status: 200, json: async () => ({ access_token: ACCESS, refresh_token: '1//replacement-refresh', expires_in: 10 }) };
      },
      open: async url => {
        const redirect = new URL(url).searchParams.get('redirect_uri') ?? '';
        await fetch(`${redirect}?code=${CODE}&state=${new URL(url).searchParams.get('state')}`);
      },
    });
    assert.equal(replaced.replaced, true);
    assert.equal(replaced.alreadyConnected, false);
    const next = JSON.parse(await readFile(join(dir, `${ADDRESS}.json`), 'utf8')) as GmailCredentialRecord;
    assert.equal(next.refresh_token, '1//replacement-refresh');
    assert.equal(next.client_secret, 'replacement-client-secret');
    assert.equal(await readFile(join(dir, 'bob@example.com.json'), 'utf8'), bob);

    const held = await readFile(join(dir, `${ADDRESS}.json`), 'utf8');
    const failures: Array<Partial<GmailLoginOptions> & { name: string }> = [
      { name: 'missing id', clientId: ' ', clientSecret: CLIENT_SECRET },
      { name: 'missing secret', clientId: CLIENT_ID, clientSecret: '' },
      { name: 'timeout', timeoutMs: 40, open: async () => {} },
      { name: 'bad state', open: async url => { const redirect = new URL(url).searchParams.get('redirect_uri') ?? ''; await fetch(`${redirect}?code=${CODE}&state=nope`); } },
      { name: 'no refresh', fetch: async () => ({ ok: true, status: 200, json: async () => ({ access_token: ACCESS }) }) },
      { name: 'profile', profile: async () => { throw new Error(`profile failed ${CODE}`); } },
    ];
    for (const failure of failures) {
      const { name, ...over } = failure;
      try {
        await connectGmailMailbox({
          ...base,
          replace: true,
          open: async url => {
            const redirect = new URL(url).searchParams.get('redirect_uri') ?? '';
            await fetch(`${redirect}?code=${CODE}&state=${new URL(url).searchParams.get('state')}`);
          },
          ...over,
        });
        assert.fail(name);
      } catch (error) {
        errors.push(`${name}: ${(error as Error).message}`);
      }
    }
    assert.equal(await readFile(join(dir, `${ADDRESS}.json`), 'utf8'), held, 'a failed sign-in leaves the file');
    for (const message of errors) assertClean(message, message);
    assert.match(errors[0] ?? '', /client id/);
    assert.match(errors[1] ?? '', /client secret/);
    assert.match(errors[2] ?? '', /timed out/);
    assert.match(errors[3] ?? '', /refused/);
    assert.match(errors[4] ?? '', /refresh token/);
    assert.match(errors[5] ?? '', /mailbox address/);

    let second: Promise<unknown> = Promise.resolve();
    const overlap = connectGmailMailbox({
      ...base,
      open: async url => {
        second = connectGmailMailbox({ ...base, open: async () => {} });
        await assert.rejects(second, /already in progress/);
        const redirect = new URL(url).searchParams.get('redirect_uri') ?? '';
        await fetch(`${redirect}?code=${CODE}&state=${new URL(url).searchParams.get('state')}`);
      },
    });
    await overlap;
    const after = connectGmailMailbox({
      ...base,
      open: async url => {
        const redirect = new URL(url).searchParams.get('redirect_uri') ?? '';
        await fetch(`${redirect}?code=other&state=${new URL(url).searchParams.get('state')}`);
      },
    });
    assert.equal((await after).alreadyConnected, true);

    const cancel = connectGmailMailbox({
      ...base,
      open: async () => { cancelGmailLogin(); },
    });
    await assert.rejects(cancel, /cancelled/);

    const openCallback: GmailLoginOptions['open'] = async url => {
      const redirect = new URL(url).searchParams.get('redirect_uri') ?? '';
      await fetch(`${redirect}?code=${CODE}&state=${new URL(url).searchParams.get('state')}`);
    };
    const stamped = JSON.parse(await readFile(join(dir, `${ADDRESS}.json`), 'utf8')) as GmailCredentialRecord;
    stamped.lastError = { at: 9, message: 'invalid_grant' };
    const stampedBytes = `${JSON.stringify(stamped, null, 2)}\n`;
    await writeFile(join(dir, `${ADDRESS}.json`), stampedBytes);
    let userinfoCalls = 0;
    await assert.rejects(connectGmailMailbox({
      ...base,
      replace: true,
      profile: async () => { throw new Error('down'); },
      userinfo: async () => { userinfoCalls += 1; return ADDRESS; },
      open: openCallback,
    }), /mailbox address/);
    assert.equal(userinfoCalls, 0, 'a failed profile read does not ask userinfo');
    assert.equal(await readFile(join(dir, `${ADDRESS}.json`), 'utf8'), stampedBytes);
    await assert.rejects(connectGmailMailbox({
      ...base,
      replace: true,
      profile: async () => undefined,
      userinfo: async () => undefined,
      open: openCallback,
    }), /mailbox address/);
    assert.equal(await readFile(join(dir, `${ADDRESS}.json`), 'utf8'), stampedBytes);
    const other = await connectGmailMailbox({
      ...base,
      profile: async () => undefined,
      userinfo: async () => 'Bob@Example.com',
      open: openCallback,
    });
    assert.equal(other.account, 'bob@example.com');
    assert.equal(existsSync(join(dir, 'bob@example.com.json')), true);
  } finally {
    console.log = originals[0];
    console.info = originals[1];
    console.warn = originals[2];
    console.error = originals[3];
    console.debug = originals[4];
  }
});

test('remove drops the mailbox cache and leaves a WhatsApp directory in place', async () => {
  const dir = await tempDir();
  const auth = join(dir, 'wa-auth');
  mkdirSync(auth);
  await writeFile(join(auth, 'key'), 'not-a-gmail-file');
  await writeFile(join(dir, 'linkedin-session'), 'cookies');
  const record: GmailCredentialRecord = { client_id: CLIENT_ID, client_secret: CLIENT_SECRET, refresh_token: REFRESH, source: 'login' };
  await writeFile(join(dir, `${ADDRESS}.json`), JSON.stringify(record));
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE wa_chats (account TEXT, id TEXT);
      CREATE TABLE inbox_search (id TEXT PRIMARY KEY, signature TEXT NOT NULL, length INTEGER NOT NULL, terms TEXT NOT NULL, item TEXT);`);
  db.prepare('INSERT INTO wa_chats VALUES (?, ?)').run('whatsapp', 'c1');
  const cleared: string[] = [];
  const cache = createInboxCache(db, { alsoClear: [() => cleared.push('all')] });
  cache.save(ADDRESS, [{ account: ADDRESS, id: 't1', title: 'Hi', preview: '', date: 1, unread: false }]);
  cache.save('whatsapp', [{ account: 'whatsapp', id: 'c1', title: 'Chat', preview: '', date: 1, unread: false }]);
  db.prepare('INSERT INTO inbox_search (id, signature, length, terms, item) VALUES (?, ?, ?, ?, ?)').run(`${ADDRESS}\u0000t1`, 's', 1, '{}', null);
  await createGmailCredentials({ dir }).remove(ADDRESS);
  cache.forget(ADDRESS);
  assert.equal(existsSync(join(dir, `${ADDRESS}.json`)), false);
  assert.equal(cache.list().some(row => row.account === ADDRESS), false);
  assert.equal(cache.list().some(row => row.account === 'whatsapp'), true);
  assert.equal(existsSync(join(auth, 'key')), true);
  assert.equal(existsSync(join(dir, 'linkedin-session')), true);
  assert.deepEqual(cleared, []);
  assert.equal((db.prepare('SELECT id FROM wa_chats').get() as { id: string }).id, 'c1');
  assert.equal(db.prepare('SELECT id FROM inbox_search').get(), undefined);
});
