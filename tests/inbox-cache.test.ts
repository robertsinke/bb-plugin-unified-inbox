import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import Database from 'better-sqlite3';
import { createInboxCache } from '../src/inbox-cache.ts';
function fixture() { const db=new Database(':memory:'); db.exec('CREATE TABLE inbox_cache (account TEXT NOT NULL,id TEXT NOT NULL,title TEXT NOT NULL,preview TEXT NOT NULL,date INTEGER NOT NULL,unread INTEGER NOT NULL,PRIMARY KEY(account,id))'); return {db,cache:createInboxCache(db)}; }
test('same IDs remain isolated by account and survive replacement',()=>{const {db,cache}=fixture();try {cache.save('personal',[{account:'personal',id:'1',title:'P',preview:'',date:1,unread:true}]);cache.save('business',[{account:'business',id:'1',title:'B',preview:'',date:2,unread:false}]); assert.deepEqual(cache.list().map(x=>x.title),['B','P']);cache.save('personal',[]);assert.deepEqual(cache.list().map(x=>x.title),['B']);} finally {db.close();}});
test('clear removes only plugin cached records',()=>{const {db,cache}=fixture();try {cache.save('personal',[{account:'personal',id:'1',title:'P',preview:'',date:1,unread:false}]);cache.clear();assert.deepEqual(cache.list(),[]);}finally{db.close();}});
test('sender name is stored with the cached row',()=>{const {db,cache}=fixture();try {cache.save('personal',[{account:'personal',id:'1',title:'Subject',preview:'Hello',date:1,unread:false,sender:'Ada'}]);assert.equal(cache.list()[0].sender,'Ada');}finally{db.close();}});
test('a manual unread mark is stored on the cached row and can be cleared',()=>{const {db,cache}=fixture();try {cache.save('whatsapp',[{account:'whatsapp',id:'j',title:'J',preview:'',date:1,unread:false}]);cache.keepUnread('whatsapp','j');assert.equal(cache.keptUnread('whatsapp','j'),true);assert.equal(cache.list()[0].unread,true);cache.dropUnread('whatsapp','j');assert.equal(cache.keptUnread('whatsapp','j'),false);assert.equal(cache.list()[0].unread,false);}finally{db.close();}});
test('invalid replacement rolls back and keeps previous data',()=>{const {db,cache}=fixture();try {const a={account:'personal' as const,id:'1',title:'Original',preview:'',date:1,unread:true};cache.save('personal',[a]);assert.throws(()=>cache.save('personal',[a,a]));assert.deepEqual(cache.list(),[a]);}finally{db.close();}});

test('recipients and attachment names are stored with the cached row',()=>{const {db,cache}=fixture();try {cache.save('personal',[{account:'personal',id:'1',title:'Subject',preview:'Hello',date:1,unread:false,sender:'Ada',recipients:'bob@example.com',attachments:['Q3 report.pdf']}]);
assert.equal(cache.list()[0].recipients,'bob@example.com');
assert.deepEqual(cache.list()[0].attachments,['Q3 report.pdf']);}finally{db.close();}});

test('cache reports changes for incremental search indexing',()=>{const {db,cache}=fixture();try {const changes:string[]=[];cache.onChange(change=>changes.push(change.kind==='items'?`items:${change.account}`:change.kind==='thread'?`thread:${change.account}:${change.id}`:'clear'));
cache.save('personal',[{account:'personal',id:'1',title:'Subject',preview:'Hello',date:1,unread:false}]);
cache.saveThread('personal','1',[{sender:'Ada',text:'Hello'}]);
cache.clear();
assert.deepEqual(changes,['items:personal','thread:personal:1','clear']);}finally{db.close();}});
