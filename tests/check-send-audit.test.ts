import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { sendAuditWarning } from '../_tools/check-send-audit.ts';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'inbox-audit-check-'));
  mkdirSync(join(dir, 'plugins', 'unified-inbox'), { recursive: true });
  const path = join(dir, 'plugins', 'unified-inbox', 'data.db');
  writeFileSync(join(dir, 'bb'), `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify({ dataDir: dir })}'\n`, { mode: 0o755 });
  return {
    path,
    run: () => spawnSync(process.execPath, ['--experimental-strip-types', fileURLToPath(new URL('../_tools/check-send-audit.ts', import.meta.url))], {
      encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
    }),
    close: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function seed(path: string, at: number) {
  const db = new Database(path);
  db.exec('CREATE TABLE inbox_send_audit (id INTEGER PRIMARY KEY, at INTEGER, account TEXT, decision TEXT, approval_id TEXT, authorization_model TEXT)');
  const insert = db.prepare('INSERT INTO inbox_send_audit (id, at, account, decision, approval_id) VALUES (?, ?, ?, ?, ?)');
  insert.run(1, at, 'linkedin', 'allowed', null);
  insert.run(2, at, 'linkedin', 'allowed', '');
  insert.run(3, at, 'personal', 'allowed', 'caller-minted');
  insert.run(4, at, 'linkedin', 'refused', null);
  insert.run(5, at - 1, 'linkedin', 'allowed', null);
  insert.run(6, at, 'business', 'allowed', '  ');
  db.close();
}

test('audit warning filters by age and missing approval; reports counts/ids without changing history', () => {
  const f = fixture();
  try {
    seed(f.path, 100);
    const before = readFileSync(f.path);
    const warning = sendAuditWarning(f.path, 100)!;
    assert.match(warning, /3 allowed attempts/);
    assert.match(warning, /counts=\{"linkedin":2,"business":1\}/);
    assert.match(warning, /audit row ids=1,2,6\./);
    assert.match(warning, /do not prove delivery or human approval/);
    assert.match(warning, /unmarked historical ids do not prove human approval/);
    assert.equal(sendAuditWarning(f.path, 101), null);
    assert.deepEqual(readFileSync(f.path), before);
  } finally { f.close(); }
});

test('audit warning includes legacy mail even when the old gate minted an approval id', () => {
  const f = fixture();
  try {
    seed(f.path, 100);
    const db = new Database(f.path);
    db.prepare("UPDATE inbox_send_audit SET authorization_model = 'legacy_mail_allow' WHERE id = 3").run();
    db.close();
    assert.match(sendAuditWarning(f.path, 100)!, /audit row ids=1,2,3,6\./);
  } finally { f.close(); }
});

test('check script warns on history without failing the build', () => {
  const f = fixture();
  try {
    seed(f.path, Date.now());
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /WARNING: 4 allowed attempts/);
    assert.match(result.stderr, /audit row ids=1,2,5,6\./);
    assert.doesNotMatch(result.stderr, /NOT CHECKED/);
  } finally { f.close(); }
});

test('unavailable live audit is explicitly not checked, never silently clean or created', () => {
  const f = fixture();
  try {
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /WARNING: audit NOT CHECKED/);
    assert.throws(() => readFileSync(f.path), /ENOENT/);
  } finally { f.close(); }
});
