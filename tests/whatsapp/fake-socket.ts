// A socket that never touches the network, and a connection listener you can drive from a test.
// The connection's own contract is "call these events and report them", so the fake is the whole
// transport: `emit` is the server, `ended` is what the plugin asked the socket to do.
import type { UserFacingSocketConfig } from 'baileys';
import type { WhatsAppAuthStore } from '../../src/whatsapp/auth.ts';
import type { SocketFactory, WhatsAppSocket } from '../../src/whatsapp/connection.ts';

type Handler = (...args: any[]) => void;

export interface FakeSocket {
  socket: WhatsAppSocket;
  handlers: Map<string, Handler[]>;
  ended: Error[];
  emit(event: string, payload: unknown): void;
  /** Let the connection's own async `connect` finish before the next assertion. */
  flush(): Promise<void>;
}

export function createFakeSocket(): FakeSocket {
  const handlers = new Map<string, Handler[]>();
  const ended: Error[] = [];
  const socket: WhatsAppSocket = {
    ev: {
      on(event: string, handler: Handler) {
        const list = handlers.get(event) ?? [];
        list.push(handler);
        handlers.set(event, list);
        return socket.ev;
      },
    },
    end(error?: Error) {
      if (error) ended.push(error);
    },
  };
  return {
    socket,
    handlers,
    ended,
    emit(event, payload) {
      for (const handler of handlers.get(event) ?? []) handler(payload);
    },
    async flush() {
      // Two macrotasks: the connection awaits the version resolver, then builds the socket.
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

export interface RecordedSocketFactory {
  factory: SocketFactory;
  configs: UserFacingSocketConfig[];
  sockets: FakeSocket[];
}

export function createSocketFactory(): RecordedSocketFactory {
  const configs: UserFacingSocketConfig[] = [];
  const sockets: FakeSocket[] = [];
  return {
    configs,
    sockets,
    factory(config) {
      configs.push(config);
      const fake = createFakeSocket();
      sockets.push(fake);
      return fake.socket;
    },
  };
}

/**
 * The auth store the connection only needs as a shape: no disk, no crypto. `registered` in these tests
 * means a linked device, which is the device identity — the flag of that name is not set by rc13's QR
 * flow, so a fake that carried only the flag would test a device that does not exist.
 */
export function fakeAuthStore(options: { registered?: boolean } = {}): WhatsAppAuthStore {
  return {
    hasCreds: () => options.registered === true,
    state: {
      creds: {
        registered: options.registered === true,
        ...(options.registered === true ? { me: { id: '31600000222:12@s.whatsapp.net' } } : {}),
      },
      keys: {
        get: async () => ({}),
        set: async () => {},
        clear: async () => {},
      },
    },
    saveCreds: async () => {},
    clear: async () => {},
  } as unknown as WhatsAppAuthStore;
}
