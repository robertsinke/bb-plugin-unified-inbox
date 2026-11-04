import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildGmailMime } from '../src/gmail-mime.ts';
import { CLI_BUDGET_MS } from './cli-budget.ts';

test('GWS accepts a local MIME upload with thread metadata without sending', async () => {
  const dir=await mkdtemp(join(tmpdir(),'bb-inbox-test-'));
  try {
    await writeFile(join(dir,'message.eml'),await buildGmailMime({from:'me@example.com',to:'other@example.com',cc:'',bcc:'',subject:'Re: Example',text:'Test',inReplyTo:'<id@example.com>',references:'<id@example.com>'}),{mode:0o600});
    const {stdout}=await promisify(execFile)('/usr/local/bin/gws',['gmail','users','messages','send','--dry-run','--params',JSON.stringify({userId:'me'}),'--json',JSON.stringify({threadId:'test-thread'}),'--upload','message.eml','--upload-content-type','message/rfc822'],{cwd:dir,timeout:CLI_BUDGET_MS});
    const result=JSON.parse(stdout); assert.equal(result.dry_run,true); assert.equal(result.is_multipart_upload,true); assert.equal(result.body.threadId,'test-thread');
  } finally {await rm(dir,{recursive:true,force:true});}
});
