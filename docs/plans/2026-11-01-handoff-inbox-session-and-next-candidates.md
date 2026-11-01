# Handoff — inbox session shipped, three deepening candidates left

Written 2026-11-01 before a context compaction. Read this first next session; it is the
whole state, not a summary of a conversation.

## Where the repo is

- **Branch `main`, HEAD `bdb3ae6`**, working tree clean, **229 tests passing**, `tsc` clean.
- No git remote in this checkout, so there are no PRs and no pushes. `bb plugin build` and
  `bb plugin reload unified-inbox` are how code reaches the live plugin, and **build only
  affects the checkout it runs in** — the live plugin installs from the thread worktree
  `/Users/robert/.bb/plugins/environment-git-worktree/host-data/worktrees/thr_wmbk3fy5bs-1/bb-plugin-unified-inbox`,
  so: merge `main` into that worktree, then build, then reload there.
- Untracked `.archify/` diagram folders were in that worktree; the main checkout is clean.

## What shipped in this session

| commit | what |
|---|---|
| `5b51c69` | ADR `decisions/0001-deepen-the-inbox-panel-into-a-session-module.md` |
| `7310c7a` | mail-draft JSON shape + `mailDraftKey`/`readMailDraft`/`writeMailDraft`/`clearMailDraft` in `src/inbox-drafts.ts` (+4 tests) |
| `bcf883f` | `src/inbox-session.ts` — the headless session — plus 5 deterministic tests (built in child thread `thr_xteuh95ctx`) |
| `c4ad468` | `app.tsx` renders the session snapshot: **740 → 596 lines**, 204 deleted (child `thr_up7pqcxwmh`) |
| `e96b1af` | draft debounce 600 → **250 ms**, matching the old panel |
| `a40734e` | `snapshot()` keeps its identity until state changes (else `useSyncExternalStore` loops forever) |
| `bdb3ae6` | `start()` runs the first load from an effect; the constructor issues no RPC |

Decisions and the five rejected alternatives are in the ADR — read it before re-suggesting
per-mount sessions, an injected scheduler, or a read-path-only session.

## Verified live (not just in tests)

Panel mounts on the Inbox nav click and renders **131 rows** from the snapshot; opening a
WhatsApp thread ("DFS e.V. Mitglieder", 10 bubbles) pins the scroller exactly
(`scrollHeight 1951 − scrollTop 1563 − clientHeight 388 = 0`); composer present and empty;
`back()` returns to the list. `capabilities` and `list` RPCs answer 131 rows / 0 errors.

**Heartbeat, now measured.** `listDue` is 8 s for WhatsApp and Messages, 45 s for the two
Gmails, LinkedIn excluded — 17.7 `list_source` calls/min for one heartbeat. Against the plugin's
own `handlerStats.count`: a quiet minute with no panel of mine added **+54** (the owner's own
window), and adding exactly one mounted panel added **+18** in 62 s. One round per due time, as
designed. A second mount could not be forced in this BB build — `⌘J` reuses the same surface, so
`document.querySelectorAll('.ui-inbox').length` stayed 1. The two-mount case rests on the
structure instead: `listDue` and `lastTick` are session state, so a second reader sees re-armed
due times and cannot add a round (pinned by the "two subscribers" test).

## The architecture review, and what is left of it

Five deepening candidates were produced from the last 40 commits' hot spots. The report is
a throwaway HTML in `/var/folders/mj/zv4n8_m97s36zfffxyj1vnjw0000gn/T/architecture-review-20261101-164721.html`
(regenerate rather than rely on it). Candidate 1 is **done**: the panel is a session.

### Candidate 2 (done) — the LinkedIn page seam is a typed session

The seam between `src/adapters/linkedin.ts` and the page is **a `string` in and `unknown`
out**: 13 exported `*Expression()` builders across `linkedin-chrome.ts` (551 lines),
`linkedin-write.ts` (550), `linkedin-ui.ts` (348), `linkedin-page.ts` (178),
`linkedin-probe.ts` (131). Every caller casts; correctness is asserted against emitted
source text. Three production faults landed on exactly this seam: the `{ok, payload}`
envelope read as an empty inbox, a bare-array recorder read-back, and a backslash eaten by
a template literal.

**Done** (`30fa9fe`, 235 tests): `src/linkedin-page-session.ts` —
`createLinkedInPageSession(evaluate)` with `list()`, `thread(id)`, `probe(mailbox)`. It owns
`linkedinPageExpression`, `linkedinProbeExpression` and `linkedinReadResult` (moved out of
`linkedin-chrome.ts`, whose only job is now the browser). `RegistryDeps.linkedInPage` replaced
`readLinkedIn` + `probeLinkedIn`, so the adapter's three casts are gone. One tightening to
know: list and probe now refuse a payload missing either row array — safe because
`linkedinPageExpression` returns `{conversations, invitations}` and the probe returns those
plus `mailboxUrn`.

Left for later: `runLinkedInWrite` still returns `unknown` and every caller casts
`{ok, status, body}` — the same seam on the write side.

**Write half done** (`f750b84`): that cast is gone. `LinkedInPageSession.replay(write)` builds
the expression with `replayWriteExpression`, evaluates once, and returns `{accepted, status}` or
refuses an answer that is not `{ok: boolean, status: number}` — so a page answering `true`,
`null`, `{}` or `{ok: 'yes'}` no longer reads as "did not accept (status 0)". The recorder's
dump and clear moved into the session too, `RegistryDeps.runLinkedInWrite` is gone, and
`linkedin_replay` answers `{ok, status}` (`d40f468`) because the seam no longer carries the
page's raw answer.

### Candidate 3 (Worth exploring) — one media primitive

Three RPC coordinates express one idea — `media`, `attachment`, `imsg_media` — and the
transport breaks the registry seam by name: `server.ts` calls
`registry.imessage.imsgMedia(...)` directly. `src/adapters/types.ts` carries
`gmailAttachment?` and `imsgMedia?` beside `media()`. `src/adapters/README.md` documents the
asymmetry as a known gap. Deepening: one `MediaRequest` (`{account, messageId, index,
filename?}`), one adapter method, one RPC.

### Candidate 4 (done) — one list names the capabilities

Adding `threads` and `followsList` touched 19 files: the `Capabilities` interface, four
adapter literals, the zod map in `server.ts`, `UNKNOWN` in `src/ui-capabilities.ts`, and
seven test literals. **Done** (`029f8ac`, 238 tests): `src/adapters/capability.ts` exports `CAPABILITY_KEYS`,
`CapabilityKey`, `NO_CAPABILITIES` (derived, all false) and `capabilitiesSchema`
(`z.strictObject` built from the same list). `Capabilities` is keyed by `CapabilityKey`,
`ui-capabilities.ts` uses `NO_CAPABILITIES`, and `server.ts` validates the `capabilities` output
with `z.record(account, capabilitiesSchema)` — so an invented capability is now refused instead
of silently stripped. Proven by appending a ninth key and watching tsc fail exactly in the four
adapter literals and the two test fixtures, and nowhere in the derived places.

Left for later: the per-adapter `assert.deepEqual(capabilities(), {...})` literals are untyped,
so a ninth key fails them at runtime rather than at build. Cheap to tighten.

### Candidate 5 (done) — one refresh primitive

**Badge folded too** (`b5a2b90`, live-proven). `useInboxBadge` no longer runs its own 20 s
interval with four sync calls and a cached recount — it starts and ticks the shared session like
the panel does, and the count is the session's own list. `tick` is a no-op at an instant it has
already served, so badge plus mounted panel is one round per due time (before: ~29.7 sync/min
together; now the one cadence, ~17.7/min). Live: nav badge "Inbox, 10 unread messages" matching
the session's 131 rows / 10 unread; panel mounts once, 131 rows; WhatsApp thread 10 bubbles,
scroll pin exact; back to list intact.

**Done** (`fbf7bee`, 245 tests). One `sync` RPC (`{ account, limit? }` → `{ items, updatedAt, reason? }`)
fans out through `registry[account].sync()`; `list_source` and `linkedin_sync` are gone.
`sync` is required on `Adapter` — the four live sources wrap their list, LinkedIn keeps its delta
probe. The session, both reconcile sites and the badge hook all ask `sync`; every sync failure
carries its reason (Messages keeps its own guidance). Proven live: one RPC answered all five
accounts (LinkedIn 21 rows, `reason: 'read'`, through the probe; the live lists unchanged);
`list` cache still 131 rows.

## Unfinished test work, in the order I would take it

1. **Stale-response guard.** Two `open()` calls where the *first* resolves last; the
   snapshot must show the second thread and never the first's messages. The guard exists
   (`request.current`) and nothing pins it.
2. **`mark` rollback.** Optimistic update, RPC rejects, row restored — this path was
   changed to a full-snapshot restore during the move, and only the happy path is tested.
3. **Single heartbeat across two mounts.** Count `list_source` with the nav panel and the
   tab both open; assert one round per due time.

Also queued: the badge hook's 20 s `setInterval` — folded onto the session's tick (`b5a2b90`).

## Working facts worth not rediscovering

- Tests: `node --experimental-strip-types --test tests/*.test.ts tests/adapters/*.test.ts`
  (relative imports need explicit `.ts`).
- `src/` is DOM-free by discipline; the four `linkedin-*` files that mention `window` build
  code as text to be evaluated in a page. `src/inbox-drafts.ts` takes `Storage` as a
  parameter, never `localStorage`.
- Session contract: `createInboxSession({ rpc, storage?, now? })`; `snapshot()` is
  identity-stable; `start()` loads once; `tick(now)` owns every due time; `flush()`
  persists debounced drafts. Panel keeps all JSX, scroll pinning, `MailFrame`, media,
  `tag()`, `openLink()` and the three `window.confirm`s.
- `threadId` in `Inbox({ threadId })` is the **host BB thread**, not an inbox conversation.
- Page expressions in LinkedIn code are TS template literals: a lone `\s` reaches the page
  as `s`, so patterns need `\\s`.
- CSS load order in production is `inbox.css → chat.css → layout.css`.
- Child threads must not run `bb plugin build` / `reload` / live RPC; the parent merges and
  verifies. Spawn with
  `bb thread spawn --project proj_69rr5d5qcd --parent-self --lifecycle-owner-thread thr_wmbk3fy5bs --new-environment worktree --base-branch refs/heads/main --prompt-file -`.
- Three child worktrees and branches are still on disk and are safe to remove once you are
  satisfied: `thr_xteuh95ctx`, `thr_eb5xpf6ht4`, `thr_up7pqcxwmh` (all merged).

## Specs already written (branches waiting for an implementer)

Two of the four remaining candidates are now specifications rather than ideas. Both are red
on purpose and both are committed off `main`, so `main` stays green.

- **Candidate 2** — **merged** (`30fa9fe`), see above. Live proof: `list` 131 rows / 0 errors,
  `linkedin_sync` 21 rows / 0 errors in 3.96 s through the new seam.
- **Candidate 4** — `bb/declare-capabilities-once`, commit `a612b90`,
  `tests/capability-keys.test.ts`. Three tests requiring `CAPABILITY_KEYS`, a `NO_CAPABILITIES`
  fallback derived from it, every adapter declaring every key, and a `capabilitiesSchema`
  built from the same list that refuses a missing or invented capability. No implementer yet.

**Candidate "write seam"** — **done** (`0e9757a`, 242 tests). `createLinkedInPageSession` gained
`replay(write)`: it builds the expression with `replayWriteExpression`, evaluates once, and returns
`{accepted, status}` — an answer it cannot read (`true`, `null`, `{}`, `{ok:'yes'}`, `{ok:true}`,
`{ok:true, status:'HTTP 200'}`) is refused instead of surfacing as "status 0". The session also took
over the recorder (`recorded()`, `clearRecorded()`). `RegistryDeps.runLinkedInWrite` and the dead
`ReplayResult` are gone; the adapter's three call sites replay through the session and keep their
own wording. One accepted surface change: the `linkedin_replay` RPC output no longer carries the
page's raw `body` — a write is verified by its effect (re-read the thread), not by trusting a
response body, and nothing consumed it.

## Suggested first move

Take candidate 2 with ub-mode discipline: write the failing test first — a fake page whose
`read(mode)` returns a `{ok, payload}` envelope, asserting the session returns the inbox
rather than zeros. That is the exact fault that once made every refresh skip.
