import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

// Reads stay the default. `send` and `tapback` are the mutations this adapter exposes.
// `react` targets the last message, and `send.rich` is a different bridge method.
// Every other write method is still refused here.
const READ_METHODS = new Set(['initialize', 'status', 'chats.list', 'messages.history']);
const MUTATION_METHODS = new Set(['send', 'tapback']);
const MAX_FRAME = 8 * 1024 * 1024;
const MAX_PENDING = 64;

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

export class ImsgClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 0;
  private buffer = '';
  private decoder = new StringDecoder('utf8');
  private disposed = false;

  private executable: string;
  private timeoutMs: number;

  constructor(executable = 'imsg', timeoutMs = 30_000) {
    this.executable = executable;
    this.timeoutMs = timeoutMs;
  }

  private start(): ChildProcessWithoutNullStreams {
    if (this.disposed) throw new Error('Messages client is closed');
    if (this.child) return this.child;
    const child = spawn(this.executable, ['rpc'], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    this.buffer = '';
    this.decoder = new StringDecoder('utf8');
    // Diagnostics may include private content; consume but never log them.
    child.stderr.resume();
    child.stdout.on('data', (chunk: Buffer) => {
      if (this.child !== child) return;
      this.buffer += this.decoder.write(chunk);
      while (this.buffer.includes('\n')) {
        const end = this.buffer.indexOf('\n');
        if (end > MAX_FRAME) return this.stop(child, 'Messages response exceeded size limit');
        const line = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 1);
        if (!line.trim()) continue;
        let record: any;
        try { record = JSON.parse(line); } catch { return this.stop(child, 'Invalid Messages response'); }
        if (!record || record.jsonrpc !== '2.0' || typeof record !== 'object') return this.stop(child, 'Invalid Messages response');
        if (typeof record.id !== 'number') continue;
        const pending = this.pending.get(record.id);
        if (!pending) continue;
        this.pending.delete(record.id);
        clearTimeout(pending.timer);
        if (record.error) {
          const code = Number.isInteger(record.error.code) ? record.error.code : 'unknown';
          const detail = typeof record.error.message === 'string' ? record.error.message : '';
          // Keep the word the adapter matches, and drop the rest: a bridge error can name a path.
          const bridge = code === -32003 || /bridge/i.test(detail);
          pending.reject(new Error(bridge
            ? `Messages request failed (code ${code}): the bridge is required`
            : `Messages request failed (code ${code})`));
        }
        else if ('result' in record) pending.resolve(record.result);
        else pending.reject(new Error('Invalid Messages response'));
      }
      if (this.buffer.length > MAX_FRAME) this.stop(child, 'Messages response exceeded size limit');
    });
    child.on('error', () => this.stop(child, 'Messages backend unavailable; install imsg and check permissions'));
    child.on('exit', () => this.stop(child, 'Messages backend exited'));
    child.stdin.on('error', () => this.stop(child, 'Messages backend connection failed'));
    return child;
  }

  private stop(child: ChildProcessWithoutNullStreams, reason: string) {
    if (this.child !== child) return;
    this.child = null;
    child.kill();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.pending.clear();
  }

  request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (!READ_METHODS.has(method) && !MUTATION_METHODS.has(method)) return Promise.reject(new Error('Messages operation is not permitted'));
    if (this.pending.size >= MAX_PENDING) return Promise.reject(new Error('Too many Messages requests'));
    let child: ChildProcessWithoutNullStreams;
    try { child = this.start(); } catch (error) { return Promise.reject(error); }
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Messages request timed out'));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      } catch {
        this.stop(child, 'Messages backend connection failed');
      }
    });
  }

  dispose() {
    this.disposed = true;
    if (this.child) this.stop(this.child, 'Messages client is closed');
  }
}
