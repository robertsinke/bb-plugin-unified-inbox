// Fill the plugin's contact names from a previous program's store, once.
//
// A name reaches this store two ways: a live envelope's `pushName`, or a contact sync when the
// contact changes. Neither replays, so a device that syncs history into a fresh store keeps the
// messages and loses the names every one of them was sent with — the sender is a LID with nothing to
// be called. The previous program (WhatsAgent) had been harvesting the same names for months, and it
// is still on this machine after being switched off.
//
// Runs from a path, writes only what is missing, and says what it did in counts. It never overwrites
// a name this store already has, and it never reads a message body.
//
//   node _tools/import-chat-names.mjs [--from <whatsagent.db>] [--into <data.db>] [--dry-run]

import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const arg = process.argv[index];
  if (arg.startsWith('--')) args.set(arg.slice(2), process.argv[index + 1]?.startsWith('--') ? true : process.argv[++index]);
}
const dryRun = process.argv.includes('--dry-run');
const from = String(args.get('from') ?? join(homedir(), 'Library/Application Support/whatsagent-desktop/whatsagent.db'));
const into = String(args.get('into') ?? join(homedir(), '.bb/plugins/unified-inbox/data.db'));

if (!existsSync(from)) {
  console.error(`No previous store at ${from}. Pass --from <path>.`);
  process.exit(1);
}
if (!existsSync(into)) {
  console.error(`No plugin store at ${into}. Pass --into <path>.`);
  process.exit(1);
}

const old = new DatabaseSync(from, { readOnly: true });
const store = new DatabaseSync(into);
store.exec('PRAGMA busy_timeout = 5000');

const blank = (value) => value === null || value === undefined || String(value).trim() === '';
const read = store.prepare('SELECT name, push_name, lid_jid, phone_jid FROM wa_contacts WHERE jid = ?');
const write = store.prepare(
  `INSERT INTO wa_contacts (jid, name, push_name, lid_jid, phone_jid) VALUES (?, ?, ?, ?, ?)
   ON CONFLICT(jid) DO UPDATE SET
     name = COALESCE(NULLIF(TRIM(wa_contacts.name), ''), excluded.name),
     push_name = COALESCE(NULLIF(TRIM(wa_contacts.push_name), ''), excluded.push_name),
     lid_jid = COALESCE(wa_contacts.lid_jid, excluded.lid_jid),
     phone_jid = COALESCE(wa_contacts.phone_jid, excluded.phone_jid)`,
);

const rows = old.prepare('SELECT jid, name, push_name, lid_jid, phone_jid FROM contacts WHERE COALESCE(TRIM(name), \'\') <> \'\' OR COALESCE(TRIM(push_name), \'\') <> \'\'').all();
let named = 0;
let aliased = 0;
let untouched = 0;
for (const row of rows) {
  if (!row.jid) continue;
  const current = read.get(row.jid);
  const gainsName = blank(current?.name) && !blank(row.name);
  const gainsPush = blank(current?.push_name) && !blank(row.push_name);
  const gainsAlias = (blank(current?.lid_jid) && !blank(row.lid_jid)) || (blank(current?.phone_jid) && !blank(row.phone_jid));
  if (!current && blank(row.name) && blank(row.push_name)) { untouched += 1; continue; }
  if (!gainsName && !gainsPush && !gainsAlias) { untouched += 1; continue; }
  if (gainsName || gainsPush) named += 1;
  if (gainsAlias) aliased += 1;
  if (!dryRun) write.run(row.jid, blank(row.name) ? null : row.name, blank(row.push_name) ? null : row.push_name, row.lid_jid ?? null, row.phone_jid ?? null);
}

console.log(`${dryRun ? 'would fill' : 'filled'} ${named} contacts with a name, ${aliased} with a lid/phone alias, ${untouched} already had what it offers (of ${rows.length} named rows).`);
old.close();
store.close();
