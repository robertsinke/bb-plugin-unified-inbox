// Candidate 5: one refresh primitive. The session asks every source the same
// question and the registry decides how each adapter answers — cache, probe, or
// live. No source name picks an RPC, and no source gets a second RPC name.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createInboxSession } from '../src/inbox-session.ts';
import type { Adapter } from '../src/adapters/types.ts';

type Call = { name: string; input: unknown };

// A gateway fake: it answers whatever method the contract names. `...args` is the
// contract's own call shape (`[input]` or `[]`), so the fake stays assignable to the
// typed dep without widening it.
function recordingRpc(answers: Record<string, (input: any) => unknown> = {}) {
  const calls: Call[] = [];
  return {
    calls,
    async call(method: string, ...args: unknown[]): Promise<any> {
      const input = args[0];
      calls.push({ name: method, input });
      const answer = answers[method];
      if (answer) return answer(input);
      if (method === 'capabilities') return {};
      if (method === 'cached') return { items: [] };
      return { items: [] };
    },
  };
}

test('refresh asks every source the same question: sync, once each', async () => {
  const rpc = recordingRpc();
  const session = createInboxSession({ rpc });
  await session.refresh(['whatsapp', 'gmail-personal', 'gmail-business', 'imessage', 'linkedin']);
  const syncs = rpc.calls.filter(call => call.name === 'sync');
  assert.equal(syncs.length, 5, 'one sync call per source');
  assert.deepEqual(
    rpc.calls.map(call => call.name),
    rpc.calls.map(() => 'sync'),
    'no source reaches for a second RPC name: `sync` is the one refresh primitive',
  );
  assert.deepEqual(
    [...new Set(syncs.map(call => (call.input as { account: string }).account))].sort(),
    ['gmail-business', 'gmail-personal', 'imessage', 'linkedin', 'whatsapp'],
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
  // A line is the source plus the sentence it says: the account is the identity, so a failure is
  // found by the source that owned it rather than by a name written into the text.
  const lineOf = (account: string) => errors.find(error => error.account === account);
  assert.ok(
    lineOf('linkedin')?.message.startsWith('could not refresh.') && lineOf('linkedin')?.message.includes(hint),
    'the reason travels with the failure',
  );
  assert.ok(
    lineOf('whatsapp')?.message.startsWith('could not refresh.') && lineOf('whatsapp')?.message.includes('boom'),
    'every source carries its reason, not just LinkedIn',
  );
  assert.equal(
    lineOf('imessage')?.message,
    'could not refresh. Check that imsg is installed and BB has Full Disk Access. Previously loaded messages may be stale.',
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