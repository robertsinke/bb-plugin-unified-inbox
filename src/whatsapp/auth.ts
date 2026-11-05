// The plugin's own WhatsApp account state (plan D2, requirement R2).
//
// Baileys needs two durable things: `creds` (the device identity) and a key-value store for the
// signal keys. Both live in one directory in the plugin's data directory, and nothing else in the
// plugin reads it: this module decides whether an account exists, what is in it, and how it is
// replaced. The panel never sees these bytes and no log line names them.
//
// Each value is an AES-256-GCM blob with the IV and tag prefixed, lifted unchanged from WhatsAgent's
// auth-store.ts. The master key is a 0600 file beside the ciphertext, not a keychain entry: BB is not
// macOS-only and a keychain grant is a human step the plugin cannot perform. Stated honestly, a key
// beside its ciphertext is not a secret store — the 0700 directory is the protection.
//
// A blob that cannot be decrypted is refused, never repaired and never replaced with a fresh
// identity: silently generating a new device identity is a re-pair, and re-pairing is the ban lever.
import {
  BufferJSON,
  initAuthCreds,
  proto,
  type AuthenticationCreds,
  type AuthenticationState,
  type SignalDataSet,
  type SignalDataTypeMap,
} from 'baileys';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

export const AUTH_DIR_MODE = 0o700;
export const AUTH_FILE_MODE = 0o600;

const KEY_FILE = 'key';
const CREDS_FILE = 'creds';
const KEYS_DIR = 'keys';

/** One account state as the rest of the plugin may refer to it: where it is, not what is in it. */
export interface WhatsAppAccountState {
  dir: string;
  /** 0 when the directory does not exist yet, which is an unpaired source. */
  dirMode: number;
  fileCount: number;
}

export interface WhatsAppAuthStore {
  state: AuthenticationState;
  /** True once this store has `creds` on disk, i.e. the device is paired or pairing. */
  hasCreds(): boolean;
  saveCreds(): Promise<void>;
  /** Forget the account state. Used only by an explicit re-pair, never on a failed decrypt. */
  clear(): Promise<void>;
}

/**
 * Where the account state lives. The `UNIFIED_INBOX_WHATSAPP_AUTH` override exists for tests and
 * for a second BB pointed at a scratch directory; a production start uses the plugin data dir.
 */
export function whatsAppAuthDir(): string {
  return process.env.UNIFIED_INBOX_WHATSAPP_AUTH || join(homedir(), '.bb/plugins/unified-inbox/whatsapp-auth');
}

/** Create the directory at 0700 and keep it there, so a pre-existing 0755 dir cannot stay open. */
export function ensureAuthDir(dir = whatsAppAuthDir()): string {
  mkdirSync(dir, { recursive: true, mode: AUTH_DIR_MODE });
  chmodSync(dir, AUTH_DIR_MODE);
  return dir;
}

function assertKey(key: Buffer): Buffer {
  if (key.byteLength !== KEY_BYTES) {
    throw new Error(`WhatsApp auth encryption key must be ${KEY_BYTES} bytes, found ${key.byteLength}`);
  }
  return key;
}

function encrypt(value: unknown, key: Buffer): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const plaintext = Buffer.from(JSON.stringify(value, BufferJSON.replacer), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

function decrypt<T>(blob: Buffer, key: Buffer): T {
  if (blob.byteLength <= IV_BYTES + TAG_BYTES) {
    throw new Error('WhatsApp account state is truncated; remove the directory and pair again');
  }
  const iv = blob.subarray(0, IV_BYTES);
  const tag = blob.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = blob.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  try {
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(plaintext.toString('utf8'), BufferJSON.reviver) as T;
  } catch {
    // Wrong key, edited file, or another plugin's state: all mean "this is not our account".
    throw new Error('WhatsApp account state cannot be decrypted; remove the directory and pair again');
  }
}

/**
 * The master key, created once at 0600 with `wx` so two processes racing on first start cannot each
 * mint a key and let the last writer win — the loser's account state would then be undecryptable.
 * A corrupt key file throws rather than being replaced, because a new key beside old ciphertext
 * presents as a fresh, unpaired device.
 */
export function loadAuthKey(dir = whatsAppAuthDir()): Buffer {
  ensureAuthDir(dir);
  const path = join(dir, KEY_FILE);
  let encoded: string;
  try {
    encoded = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const created = randomBytes(KEY_BYTES);
    try {
      writeFileSync(path, `${created.toString('base64')}\n`, { mode: AUTH_FILE_MODE, flag: 'wx' });
      return created;
    } catch (writeError) {
      if ((writeError as NodeJS.ErrnoException).code !== 'EEXIST') throw writeError;
      return assertKey(Buffer.from(readFileSync(path, 'utf8').trim(), 'base64'));
    }
  }
  const key = Buffer.from(encoded.trim(), 'base64');
  if (key.byteLength !== KEY_BYTES) {
    throw new Error('WhatsApp auth key file is corrupt; remove the directory and pair again');
  }
  return key;
}

async function writeAtomic(path: string, data: Buffer): Promise<void> {
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, data, { mode: AUTH_FILE_MODE });
  await rename(temp, path);
}

/** Ids carry `/` and other path characters; base64url makes one file per value, no subdirectories. */
function keyFileName(id: string): string {
  return `${Buffer.from(id, 'utf8').toString('base64url')}.enc`;
}

/**
 * The account state, encrypted, one file per value. Construction reads `creds` synchronously
 * because Baileys wants `state.creds` at socket-config time; every write after that is async.
 */
export function createFileAuthStore(dir = whatsAppAuthDir(), key?: Buffer): WhatsAppAuthStore {
  ensureAuthDir(dir);
  const masterKey = assertKey(key ?? loadAuthKey(dir));
  const credsPath = join(dir, CREDS_FILE);
  const keysDir = join(dir, KEYS_DIR);

  let paired = true;
  let creds: AuthenticationCreds;
  try {
    creds = decrypt<AuthenticationCreds>(readFileSync(credsPath), masterKey);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    paired = false;
    creds = initAuthCreds();
  }

  async function getKeys<T extends keyof SignalDataTypeMap>(
    type: T,
    ids: string[],
  ): Promise<{ [id: string]: SignalDataTypeMap[T] }> {
    const result: { [id: string]: SignalDataTypeMap[T] } = {};
    for (const id of ids) {
      let blob: Buffer;
      try {
        blob = readFileSync(join(keysDir, type, keyFileName(id)));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      let value = decrypt<SignalDataTypeMap[T]>(blob, masterKey);
      if (type === 'app-state-sync-key') {
        value = proto.Message.AppStateSyncKeyData.fromObject(
          value as unknown as Record<string, unknown>,
        ) as unknown as SignalDataTypeMap[T];
      }
      result[id] = value;
    }
    return result;
  }

  async function setKeys(data: SignalDataSet): Promise<void> {
    for (const [type, entries] of Object.entries(data)) {
      if (!entries) continue;
      const typeDir = join(keysDir, type);
      for (const [id, value] of Object.entries(entries)) {
        const path = join(typeDir, keyFileName(id));
        if (value === null) {
          await rm(path, { force: true });
          continue;
        }
        await mkdir(typeDir, { recursive: true, mode: AUTH_DIR_MODE });
        await chmod(typeDir, AUTH_DIR_MODE);
        await writeAtomic(path, encrypt(value, masterKey));
      }
    }
  }

  const state: AuthenticationState = {
    creds,
    keys: {
      get: getKeys,
      set: setKeys,
      clear: async () => {
        await rm(keysDir, { recursive: true, force: true });
      },
    },
  };

  return {
    state,
    hasCreds: () => paired,
    async saveCreds() {
      await writeAtomic(credsPath, encrypt(state.creds, masterKey));
      paired = true;
    },
    async clear() {
      await rm(credsPath, { force: true });
      await rm(keysDir, { recursive: true, force: true });
      paired = false;
    },
  };
}

function countFiles(dir: string): number {
  let count = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    count += entry.isDirectory() ? countFiles(join(dir, entry.name)) : 1;
  }
  return count;
}

/** What the state looks like without opening it: the mode and the file count, never the bytes. */
export function accountStateSummary(dir = whatsAppAuthDir()): WhatsAppAccountState {
  try {
    return { dir, dirMode: statSync(dir).mode & 0o777, fileCount: countFiles(dir) };
  } catch {
    // Absent is a state: an unpaired source has no directory yet.
    return { dir, dirMode: 0, fileCount: 0 };
  }
}

/**
 * Whether a paired account exists, without opening it. `creds` is the file pairing writes first, so
 * a directory holding only a key or a lock file is a socket that never paired — which is a state,
 * not an account (R5).
 */
export function whatsAppAccountExists(dir = whatsAppAuthDir()): boolean {
  return existsSync(join(dir, CREDS_FILE));
}
