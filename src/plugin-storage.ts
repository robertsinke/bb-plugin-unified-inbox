import type Database from 'better-sqlite3';
import { createInboxCache } from './inbox-cache.ts';
import { createGmailFaceStore } from './gmail-faces.ts';
import { createWhatsAppStore } from './whatsapp/store.ts';

/** WhatsApp history and media are durable source data, not a rebuildable cache. */
export function createPluginStorage(db: Database.Database) {
  const whatsappStore = createWhatsAppStore(db);
  const gmailFaceStore = createGmailFaceStore(db);
  const cache = createInboxCache(db, { alsoClear: [() => gmailFaceStore.clear()] });
  return { whatsappStore, gmailFaceStore, cache };
}
