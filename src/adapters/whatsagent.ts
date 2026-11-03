// The WhatsAgent backend client (Migration state 3): the MCP tool channel and
// the loopback HTTP API the WhatsApp adapter reads media and previews from.
// Both are serialized, and a failed call drops the cached connection so the
// next one reconnects instead of reusing a dead one.
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createAsyncGate } from '../async-gate.ts';

/** What the WhatsApp adapter needs from the WhatsAgent backend. */
export interface WhatsAgentClient {
  /** One MCP tool call; media loads are serialized separately from reads. */
  call(tool: string, args: Record<string, unknown>): Promise<any>;
  /** The loopback HTTP API's base URL, bearer token and port. */
  runtime(): Promise<{ baseUrl: string; token: string; port: number }>;
}

function runtimePath(): string {
  return join(homedir(), 'Library/Application Support/whatsagent-desktop/mcp-runtime.json');
}

function runtimeUrl(value: unknown): URL {
  let url: URL;
  try { url = new URL(String(value)); } catch { throw new Error('Invalid WhatsAgent connection'); }
  return url;
}

// Only known status codes cross the provider boundary; error text can contain private data.
export function whatsAgentError(tool: string, result: { content?: Array<{ type: string; text?: unknown }> }): Error {
  const text = result.content?.find(item => item.type === 'text')?.text;
  let status: unknown;
  try { status = typeof text === 'string' ? JSON.parse(text)?.status : undefined; } catch { /* unknown response */ }
  if (tool === 'load-media') {
    if (status === 404) return new Error('WhatsAgent: message not found.');
    if (status === 410) return new Error('WhatsAgent: media is no longer available.');
    if (status === 502) return new Error('WhatsAgent: media download temporarily failed.');
    if (status === 503) return new Error('WhatsAgent: WhatsApp connection is unavailable.');
  }
  return new Error('WhatsAgent rejected the request.');
}

export function createWhatsAgent(): WhatsAgentClient {
  const gate = createAsyncGate();
  const mediaGate = createAsyncGate();
  let ready: Promise<Client> | null = null;

  async function connect(): Promise<Client> {
    if (!ready) {
      ready = (async () => {
        let runtime: any;
        try {
          runtime = JSON.parse(await readFile(runtimePath(), 'utf8'));
          if (!Number.isSafeInteger(runtime.pid) || runtime.pid <= 0) throw new Error('invalid pid');
          process.kill(runtime.pid, 0);
        } catch {
          throw new Error('WhatsAgent backend is unavailable. Check the existing com.robert.whatsagent-headless launch agent; the inbox will not start another connection.');
        }
        const url = runtimeUrl(runtime.url);
        if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.pathname !== '/mcp' || typeof runtime.token !== 'string') throw new Error('Invalid WhatsAgent connection');
        const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${runtime.token}` } } });
        const client = new Client({ name: 'bb-unified-inbox', version: '0.1.0' });
        await client.connect(transport);
        return client;
      })().catch(error => { ready = null; throw error; });
    }
    return ready;
  }

  return {
    call(tool, args) {
      const serialize = tool === 'load-media' ? mediaGate : gate;
      return serialize(async () => {
        try {
          const client = await connect();
          const result = await client.callTool({ name: tool, arguments: args });
          if (result.isError) throw whatsAgentError(tool, { content: Array.isArray(result.content) ? result.content : [] });
          const text = Array.isArray(result.content) ? result.content.find((x: any) => x.type === 'text') as any : null;
          if (!text || typeof text.text !== 'string') throw new Error('Unexpected WhatsAgent response');
          return JSON.parse(text.text);
        } catch (error) {
          ready = null;
          throw error;
        }
      });
    },

    async runtime() {
      const runtime = JSON.parse(await readFile(runtimePath(), 'utf8'));
      const url = runtimeUrl(runtime.url);
      if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.pathname !== '/mcp' || typeof runtime.token !== 'string' || !runtime.token) throw new Error('Invalid WhatsAgent connection');
      const port = Number(url.port || 80);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid WhatsAgent connection');
      return { baseUrl: url.origin, token: runtime.token, port };
    },
  };
}
