# Deepen the inbox panel into a session module

- **Type:** architecture decision
- **Description:** Move the `Inbox` panel's state and timing into `src/inbox-session.ts`, a headless session with a snapshot and intents.
- **Status:** accepted
- **Date:** 2026-11-01
- **Deciders:** repo owner, design grilling session
- **Tags:** inbox, app.tsx, testing, polling

> **Current state (2026-11-03): the decision holds; two numbers in this record have moved.**
> `app.tsx` is 519 lines, not 740, and the session's dependency is no longer a loose
> `{ rpc, storage?, now? }` — `rpc` is typed by `rpcContract` (`src/inbox-session.ts`). The
> named follow-up, splitting the panel's render decisions out of its 116-line JSX return, is still open.
> Nothing below is rewritten: an ADR records what was decided, not what the code looks like today.

## Context

`app.tsx` carries the `Inbox` panel as a single 740-line component. Thirty-three
of the last forty commits touch that file, and no test reaches it. The panel
mixes four concerns that change for different reasons: what to fetch and when
(five independent timers — 8s list, 45s Gmail, 5s/8s thread watch, search
debounce), what the user has selected and typed, how rows and threads render,
and how the host thread is touched (`tag()`, panel tabs).

The polling rules are the part that fails silently. Two mounts of the panel
(the nav panel and the tab mount) keep two pollers, two selections, and two
refresh timestamps, so a refresh in one view leaves the other stale and the
timers fire against whatever state that copy happens to hold. Nothing outside
the component can observe or assert on any of it.

## Decision

Deepen the panel into `src/inbox-session.ts`: a headless module that takes
`{ rpc, storage?, now? }` and exposes a snapshot plus intents. `app.tsx` keeps
the rendering and forwards user actions to the session.

The scope is everything the panel currently holds, including the mail compose
flow — a partially moved session would leave the two halves needing to observe
each other.

Time is owned by the session. The panel keeps a single visibility-guarded
heartbeat and calls `session.tick(now)`; the session decides what is due (8s
list, 45s Gmail, 5s/8s thread watch, search debounce). Tests drive `tick` with
explicit timestamps instead of waiting on wall-clock timers.

Instances: one session per plugin process, created on the first mount and
shared by the nav panel and the tab mount. One poller, one selection, one set
of due times.

File shape: only state leaves `app.tsx`; all rendering stays. Splitting the
presentation into its own files is a later, separate change.

Host coupling: `tag()` (inserts a mention into the BB thread composer) and
`openLink()` (writes panel tabs into the host thread) stay in the panel. The
session knows nothing about BB; it exposes `notify(text)` so the panel still has
exactly one status line to render.

Mail drafts stay in memory for now. Persisting them is a follow-up.

### Rejected options

- **Read-path-only session.** A session that only answers "what should be
  shown" has to hand out setters for `items` and `messages` so the panel can
  keep mutating them. That leaves the module a shallow pass-through: the real
  logic stays in the component and the module has no invariant of its own.
- **Session owning timers through an injected scheduler.** Tests would have to
  build and drive a fake scheduler, and the scheduler's fake becomes a second
  implementation of the polling rules. A heartbeat plus `tick(now)` keeps the
  rules in one deterministic place.
- **Per-mount sessions.** Cheapest to write and it preserves today's defect:
  duplicate polling and divergent refresh timestamps between the nav panel and
  the tab mount.
- **Splitting the presentation out in the same change.** Two refactors in one
  diff; a reviewer could not tell a state bug from a move. The file split comes
  after the state split is trusted.
- **Session owning BB host actions.** It would pull SDK shapes into a headless
  module and force a host fake into every test, for two calls that are already
  thin wrappers.

## Consequences

- A module-level singleton outlives any mount. A stopped or unmounted panel
  leaves the session, its snapshot, and its due times alive until the process
  ends, so the heartbeat must be the only thing that drives it and must be
  visibility-guarded.
- Following one refresh now means reading two files: the heartbeat in the panel
  and the rule it triggers in the session.
- New obligation: keep the heartbeat single. Any second `setInterval` in the
  panel re-creates the duplicate-poller defect the session exists to remove.
- New obligation: every new timing rule belongs in `tick`, not in the panel,
  or the session's due times stop being the whole schedule.
- The session becomes testable without rendering: `tick(now)` with a fake rpc
  covers the polling, selection, and compose flows that no test reaches today.
- Mail drafts are still lost on reload until persistence lands; this decision
  moves that gap into a module where a store can be added, and does not close
  it.
