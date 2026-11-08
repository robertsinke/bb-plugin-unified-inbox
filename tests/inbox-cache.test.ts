import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import Database from 'better-sqlite3';
import { createInboxCache } from '../src/inbox-cache.ts';
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
