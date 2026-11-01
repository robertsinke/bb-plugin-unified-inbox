// Candidate 5: one refresh primitive. The session asks every source the same
// question and the registry decides how each adapter answers — cache, probe, or
// live. No source name picks an RPC, and no source gets a second RPC name.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createInboxSession } from '../src/inbox-session.ts';
import type { Adapter } from '../src/adapters/types.ts';

type Call = { name: string; input: any };

function recordingRpc(answers: Record<string, (input: any) => unknown> = {}) {
  const calls: Call[] = [];
  return {
    calls,
    async call(name: string, input: unknown): Promise<any> {
      calls.push({ name, input: input as any });
      const answer = answers[name];
      if (answer) return answer(input as any);
      if (name === 'capabilities') return {};
      if (name === 'cached') return { items: [] };
      if (name === 'list_source') return { items: [] };
      if (name === 'linkedin_sync') return { items: [], updatedAt: 0 };
      return { items: [] };
    },
  };
}

test('refresh asks every source the same question: sync, once each', async () => {
  const rpc = recordingRpc();
  const session = createInboxSession({ rpc });
  await session.refresh(['whatsapp', 'personal', 'business', 'imessage', 'linkedin']);
  const syncs = rpc.calls.filter(call => call.name === 'sync');
  assert.equal(syncs.length, 5, 'one sync call per source');
  assert.deepEqual(
    rpc.calls.map(call => call.name),
    rpc.calls.map(() => 'sync'),
    'no source reaches for a second RPC name (list_source, linkedin_sync)',
  );
  assert.deepEqual(
    [...new Set(syncs.map(call => call.input.account))].sort(),
    ['business', 'imessage', 'linkedin', 'personal', 'whatsapp'],
  );
});

test('a failed sync names its source and carries the reason it gave', async () => {
  const hint = 'Run `bb unified-inbox linkedin-signin` to sign in to LinkedIn once.';
  const rpc = recordingRpc({
    sync: (input: any) => {
      if (input.account === 'linkedin') throw new Error(hint);
      if (input.account === 'whatsapp' || input.account === 'imessage') throw new Error('boom');
      return { items: [], updatedAt: 0 };
    },
  });
  const session = createInboxSession({ rpc });
  await session.refresh(['linkedin', 'whatsapp', 'imessage']);
  const errors = session.snapshot().errors;
  assert.ok(
    errors.some(error => error.startsWith('LinkedIn could not refresh.') && error.includes(hint)),
    'the reason travels with the failure',
  );
  assert.ok(
    errors.some(error => error.startsWith('WhatsApp could not refresh.') && error.includes('boom')),
    'every source carries its reason, not just LinkedIn',
  );
  assert.ok(
    errors.includes('Messages could not refresh. Check that imsg is installed and BB has Full Disk Access. Previously loaded messages may be stale.'),
    'Messages keeps its own guidance',
  );
});

// Type-level: no adapter may ship without sync — the registry, not the session,
// decides how a refresh is answered. Red under `npx tsc --noEmit` while sync is
// an optional LinkedIn-only entry point.
test('sync is a required answer from every adapter', () => {
  type SyncIsRequired = undefined extends Adapter['sync'] ? never : true;
  const required: SyncIsRequired = true;
  assert.equal(required, true);
});