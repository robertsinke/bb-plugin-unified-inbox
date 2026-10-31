# Slice B, broken into work units

Source: `docs/plans/2026-11-02-next-slices.md`, slice B. One toolbox of
primitives — search, read, draft, update, send — with per-source adapters
behind it. `server.ts` becomes transport, `app.tsx` asks for capabilities.

Each unit below is dispatched as a child thread in its own worktree. Units are
**sequenced, not parallel** where they touch the same contract, because a
half-defined registry read by two agents at once produces two registries.

## B1 — Registry and server wiring (foundation)

Owns: `src/adapters/**`, `server.ts`.

1. `src/adapters/index.ts` exports `createRegistry(deps): Record<Account, Adapter>`,
   where `deps` carries what the current dispatch closes over: the cache, the
   Gmail runner, the WhatsAgent runner, the `imsg` client, the LinkedIn read
   entry point, and the provider-error factory. The adapters own how a source
   lists, opens, serves media, and performs an action; the registry owns which
   object answers for which account.
2. `server.ts` keeps: RPC schema validation, caching, search, unread
   preservation, error isolation, and the send policy layer. It loses every
   `account === …` behavioural branch — routing goes through the registry, and
   policy decisions read `capabilities()`.
3. Additive RPC change only: a new `capabilities` output returning
   `Record<Account, Capabilities>`. Existing shapes stay byte-identical so the
   frontend keeps working unchanged.

Acceptance: `npx tsc --noEmit` clean; all existing tests pass; new tests prove
one adapter per account and that a refusal comes from `capabilities()` rather
than from a hardcoded account check; live parity after
`bb plugin build && bb plugin reload unified-inbox` — `list` still 131 rows with
zero errors, and each source still opens (personal 1, business 1, whatsapp 49,
imessage 60, linkedin 20 conversation rows). No live mutation of any kind.

## B2 — Frontend reads capabilities (depends on B1)

Owns: `app.tsx`.

- Replace behavioural `account === …` checks with capability lookups: the
  composer appears when `send`, the read/unread toggle when `markRead`, the
  archive action when `archive`.
- Keep the visual result identical today: WhatsApp composer with its
  propose/confirm step, Messages composer sending directly, Gmail read/unread/
  archive, LinkedIn neither.

Acceptance: no behavioural `account ===` branch remains in `app.tsx` except
presentation ones (label, avatar, bubble style); the UI behaves the same for all
five sources; a test asserts the composer is gated by capability, not by account.

## B3 — Parity tests and adapter docs (depends on B1, parallel with B2)

Owns: `tests/adapters/**`, `src/adapters/README.md`, `docs/plans/…` notes.

- One test per account proving the declared `Capabilities` match what
  `action`/`send` actually accept, using stubbed dependencies — never a live
  source.
- A short README in `src/adapters/` stating the boundary: what the toolbox
  owns, what an adapter owns, and the rule that a new source means a new
  adapter plus a capability declaration, not a new branch in `server.ts`.

Acceptance: every capability flag is exercised in both directions (supported →
accepted, unsupported → refused); the README names the ownership boundary in one
screen.

## Sequencing

B1 → (B2, B3 in parallel). B2 and B3 own disjoint files, so they can run at the
same time once B1 is on `main`.

Every unit: work only inside its own worktree, never send a live message, never
write to LinkedIn, run `npx tsc --noEmit` and the full test suite, and commit on
its own branch with a focused message.
