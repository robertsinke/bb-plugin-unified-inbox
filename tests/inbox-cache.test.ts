import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import Database from 'better-sqlite3';
import { createInboxCache, migrateGmailAccountIds, pauseAccountWrites, resumeAccountWrites } from '../src/inbox-cache.ts';
function fixture() { const db=new Database(':memory:'); db.exec('CREATE TABLE inbox_cache (account TEXT NOT NULL,id TEXT NOT NULL,title TEXT NOT NULL,preview TEXT NOT NULL,date INTEGER NOT NULL,unread INTEGER NOT NULL,PRIMARY KEY(account,id))'); return {db,cache:createInboxCache(db)}; }
test('same IDs remain isolated by account and survive replacement',()=>{const {db,cache}=fixture();try {cache.save('gmail-personal',[{account:'gmail-personal',id:'1',title:'P',preview:'',date:1,unread:true}]);cache.save('gmail-business',[{account:'gmail-business',id:'1',title:'B',preview:'',date:2,unread:false}]); assert.deepEqual(cache.list().map(x=>x.title),['B','P']);cache.save('gmail-personal',[]);assert.deepEqual(cache.list().map(x=>x.title),['B']);} finally {db.close();}});
test('clear removes only plugin cached records',()=>{const {db,cache}=fixture();try {cache.save('gmail-personal',[{account:'gmail-personal',id:'1',title:'P',preview:'',date:1,unread:false}]);cache.clear();assert.deepEqual(cache.list(),[]);}finally{db.close();}});
test('a sent reply is stored on the row and reported as a list change', () => {
  const { db, cache } = fixture();
  try {
    cache.save('gmail-personal', [{ account: 'gmail-personal', id: '1', title: 'Subject', preview: 'Can you review this?', date: 1, unread: true }]);
    const changes: string[] = [];
    cache.onChange(change => changes.push(change.kind));
    cache.setSentSnippet('gmail-personal', '1', 'On my way', 50);
    assert.equal(cache.list()[0].sentSnippet, 'On my way');
    assert.equal(cache.list()[0].preview, 'On my way');
    assert.equal(cache.list()[0].date, 50);
    cache.setSentSnippet('gmail-personal', 'missing', 'no row');
    assert.deepEqual(changes, ['items']);
  } finally { db.close(); }
});
test('sender name is stored with the cached row',()=>{const {db,cache}=fixture();try {cache.save('gmail-personal',[{account:'gmail-personal',id:'1',title:'Subject',preview:'Hello',date:1,unread:false,sender:'Ada'}]);assert.equal(cache.list()[0].sender,'Ada');}finally{db.close();}});
test('LinkedIn avatar URLs survive the legacy-cache schema migration',()=>{const {db,cache}=fixture();try {const row={account:'linkedin' as const,id:'urn:li:msg_conversation:1',title:'Ada',preview:'Hi',date:1,unread:false,avatarUrl:'https://media.licdn.com/dms/image/v2/example'};cache.save('linkedin',[row]);assert.deepEqual(cache.list()[0],row);}finally{db.close();}});
test('a manual unread mark is stored on the cached row and can be cleared',()=>{const {db,cache}=fixture();try {cache.save('whatsapp',[{account:'whatsapp',id:'j',title:'J',preview:'',date:1,unread:false}]);cache.keepUnread('whatsapp','j');assert.equal(cache.keptUnread('whatsapp','j'),true);assert.equal(cache.list()[0].unread,true);cache.dropUnread('whatsapp','j');assert.equal(cache.keptUnread('whatsapp','j'),false);assert.equal(cache.list()[0].unread,false);}finally{db.close();}});
test('invalid replacement rolls back and keeps previous data',()=>{const {db,cache}=fixture();try {const a={account:'gmail-personal' as const,id:'1',title:'Original',preview:'',date:1,unread:true};cache.save('gmail-personal',[a]);assert.throws(()=>cache.save('gmail-personal',[a,a]));assert.deepEqual(cache.list(),[a]);}finally{db.close();}});

test('recipients and attachment names are stored with the cached row',()=>{const {db,cache}=fixture();try {cache.save('gmail-personal',[{account:'gmail-personal',id:'1',title:'Subject',preview:'Hello',date:1,unread:false,sender:'Ada',recipients:'bob@example.com',attachments:['Q3 report.pdf']}]);
assert.equal(cache.list()[0].recipients,'bob@example.com');
assert.deepEqual(cache.list()[0].attachments,['Q3 report.pdf']);}finally{db.close();}});

test('cache reports changes for incremental search indexing',()=>{const {db,cache}=fixture();try {const changes:string[]=[];cache.onChange(change=>changes.push(change.kind==='items'?`items:${change.account}`:change.kind==='thread'?`thread:${change.account}:${change.id}`:'clear'));
cache.save('gmail-personal',[{account:'gmail-personal',id:'1',title:'Subject',preview:'Hello',date:1,unread:false}]);
cache.saveThread('gmail-personal','1',[{sender:'Ada',text:'Hello'}]);
cache.clear();
assert.deepEqual(changes,['items:gmail-personal','thread:gmail-personal:1','clear']);}finally{db.close();}});

test('opening the cache renames stored gmail account ids', () => {
  const db = new Database(':memory:');
  try {
    db.exec(`CREATE TABLE inbox_cache (account TEXT NOT NULL, id TEXT NOT NULL, title TEXT NOT NULL, preview TEXT NOT NULL, date INTEGER NOT NULL, unread INTEGER NOT NULL, PRIMARY KEY(account,id));
      CREATE TABLE inbox_thread (account TEXT NOT NULL, id TEXT NOT NULL, messages TEXT NOT NULL, PRIMARY KEY(account,id));
      CREATE TABLE inbox_search (id TEXT PRIMARY KEY, signature TEXT NOT NULL, length INTEGER NOT NULL, terms TEXT NOT NULL);`);
    const row = db.prepare('INSERT INTO inbox_cache (account,id,title,preview,date,unread) VALUES (?,?,?,?,?,?)');
    row.run('personal', '1', 'P', '', 1, 1);
    row.run('gmail-personal', '1', 'Kept', '', 3, 0);
    row.run('business', '2', 'B', '', 2, 0);
    db.prepare('INSERT INTO inbox_thread (account,id,messages) VALUES (?,?,?)').run('personal', '1', '[]');
    db.prepare('INSERT INTO inbox_search (id,signature,length,terms) VALUES (?,?,?,?)').run('business\u00002', 'sig', 1, '[]');
    const cache = createInboxCache(db);
    assert.deepEqual(cache.list().map(item => [item.account, item.id, item.title]), [['gmail-personal', '1', 'Kept'], ['gmail-business', '2', 'B']]);
    assert.deepEqual(cache.readThread('gmail-personal', '1'), []);
    assert.equal((db.prepare('SELECT id FROM inbox_search').get() as { id: string }).id, 'gmail-business\u00002');
    createInboxCache(db);
    assert.equal(cache.list().length, 2);
  } finally { db.close(); }
});

test('an email rename moves keyed rows and leaves the send audit on the legacy id', () => {
  const db = new Database(':memory:');
  try {
    const cache = createInboxCache(db);
    db.exec(`CREATE TABLE inbox_attention (account TEXT NOT NULL, id TEXT NOT NULL, verdict TEXT NOT NULL, noul REAL NOT NULL, state_hash TEXT NOT NULL, PRIMARY KEY(account,id));
      CREATE TABLE gmail_faces (account TEXT NOT NULL, address TEXT NOT NULL, url TEXT, state TEXT NOT NULL, PRIMARY KEY(account,address));
      CREATE TABLE inbox_send_audit (id INTEGER PRIMARY KEY, account TEXT NOT NULL, decision TEXT NOT NULL);
      CREATE TABLE inbox_search (id TEXT PRIMARY KEY, signature TEXT NOT NULL, length INTEGER NOT NULL, terms TEXT NOT NULL, item TEXT);`);
    cache.save('gmail-personal', [{ account: 'gmail-personal', id: 't1', title: 'Hi', preview: '', date: 1, unread: true }]);
    cache.saveFreshness('gmail-personal', { lastAttemptAt: 1, lastSuccessAt: 1, lastError: null, cacheFallback: false });
    db.prepare('INSERT INTO inbox_read_hold (account, id) VALUES (?, ?)').run('gmail-personal', 't1');
    db.prepare('INSERT INTO inbox_attention (account, id, verdict, noul, state_hash) VALUES (?, ?, ?, ?, ?)').run('gmail-personal', 't1', 'yes', 1, 'h');
    db.prepare('INSERT INTO gmail_faces (account, address, url, state) VALUES (?, ?, ?, ?)').run('gmail-personal', 'bob@example.com', null, 'ready');
    db.prepare('INSERT INTO inbox_send_audit (account, decision) VALUES (?, ?)').run('gmail-personal', 'allowed');
    db.prepare('INSERT INTO inbox_search (id, signature, length, terms, item) VALUES (?, ?, ?, ?, ?)').run(
      'gmail-personal\u0000t1', 'sig', 1, '[]', JSON.stringify({ account: 'gmail-personal', id: 't1' }),
    );
    migrateGmailAccountIds(db, { 'gmail-personal': 'ada@example.com' });
    assert.equal(cache.list()[0].account, 'ada@example.com');
    assert.equal(cache.freshness('ada@example.com').lastSuccessAt, 1);
    assert.equal(cache.heldRead('ada@example.com', 't1'), true);
    assert.equal((db.prepare('SELECT account FROM inbox_attention').get() as { account: string }).account, 'ada@example.com');
    assert.equal((db.prepare('SELECT account FROM gmail_faces').get() as { account: string }).account, 'ada@example.com');
    assert.equal((db.prepare('SELECT account FROM inbox_send_audit').get() as { account: string }).account, 'gmail-personal');
    const search = db.prepare('SELECT id, item FROM inbox_search').get() as { id: string; item: string };
    assert.equal(search.id, 'ada@example.com\u0000t1');
    assert.equal(JSON.parse(search.item).account, 'ada@example.com');
  } finally { db.close(); }
});

test('a mute flag stays set when that account is synced', () => {
  const { db, cache } = fixture();
  try {
    cache.mute('gmail-personal', 't1');
    cache.save('gmail-personal', [{ account: 'gmail-personal', id: 't1', title: 'Hi', preview: '', date: 1, unread: true }]);
    assert.equal(cache.muted('gmail-personal', 't1'), true);
  } finally { db.close(); }
});

test('mute is one row and unmute of a missing row is a no-op', () => {
  const { db, cache } = fixture();
  try {
    cache.unmute('gmail-business', 'missing');
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM inbox_mute').get() as { n: number }).n, 0);
    cache.mute('gmail-personal', 't1');
    cache.mute('gmail-personal', 't1');
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM inbox_mute').get() as { n: number }).n, 1);
  } finally { db.close(); }
});

test('clear removes cached rows and leaves the mute flag set', () => {
  const { db, cache } = fixture();
  try {
    cache.save('gmail-personal', [{ account: 'gmail-personal', id: 't1', title: 'Hi', preview: '', date: 1, unread: true }]);
    cache.mute('gmail-personal', 't1');
    cache.clear();
    assert.deepEqual(cache.list(), []);
    assert.equal(cache.muted('gmail-personal', 't1'), true);
  } finally { db.close(); }
});

test('forget removes that account mute and leaves another account', () => {
  const { db, cache } = fixture();
  try {
    cache.mute('gmail-personal', 't1');
    cache.mute('gmail-business', 't2');
    cache.forget('gmail-personal');
    assert.equal(cache.muted('gmail-personal', 't1'), false);
    assert.equal(cache.muted('gmail-business', 't2'), true);
  } finally { db.close(); }
});

test('an email rename moves the mute row and drops the old account id', () => {
  const db = new Database(':memory:');
  try {
    const cache = createInboxCache(db);
    cache.mute('gmail-personal', 't1');
    cache.mute('gmail-business', 't2');
    migrateGmailAccountIds(db, { 'gmail-personal': 'ada@example.com' });
    assert.equal(cache.muted('ada@example.com', 't1'), true);
    assert.equal(cache.muted('gmail-personal', 't1'), false);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM inbox_mute WHERE account = ?').get('gmail-personal') as { n: number }).n, 0);
    assert.equal(cache.muted('gmail-business', 't2'), true);
  } finally { db.close(); }
});

test('a paused legacy id does not write cache rows', () => {
  const db = new Database(':memory:');
  try {
    const cache = createInboxCache(db);
    const changes: string[] = [];
    cache.onChange(() => changes.push('change'));
    pauseAccountWrites('gmail-personal');
    cache.save('gmail-personal', [{ account: 'gmail-personal', id: 't1', title: 'Hi', preview: '', date: 1, unread: true }]);
    cache.setCursor('gmail-personal', '99');
    assert.equal(cache.list().length, 0);
    assert.equal(cache.cursor('gmail-personal'), null);
    assert.deepEqual(changes, []);
  } finally {
    resumeAccountWrites('gmail-personal');
    db.close();
  }
});
