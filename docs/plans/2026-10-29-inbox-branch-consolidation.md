# Unified Inbox branch consolidation

Date: 2026-10-29 · Status: steps 1–3 done; interim install live · Owner: robert
Supersedes: nothing — this is the state-0 prerequisite for [the gateway spec](../../specs/001-unified-inbox-gateway/spec.md).

## Situation

Unified Inbox development split across three trees that all modify the same hot files, and production follows whichever thread's build was installed last. Nobody merged back to main.

| Tree | Path | Base | State | Holds |
|---|---|---|---|---|
| main checkout | `/Users/robert/dev/bb-plugin-unified-inbox` | 871467b (main) | **dirty, occupied by thr_yzwhws3amz** | LinkedIn source in progress: `src/linkedin-*.ts`, `tests/linkedin-inbox.test.ts`, research docs; modifies `app.tsx`, `server.ts`, `inbox.css`, `src/inbox-cache.ts`, `README.md` (uncommitted) |
| tagging worktree | `.../worktrees/thr_7nti3cab6m-1/bb-plugin-unified-inbox` | 871467b + 1 commit (41f9f72) | clean, committed | Inbox-plus-command: `#` mention / `+` row tagging (`src/inbox-mention.ts` + tests); modifies `app.tsx`, `server.ts`, `layout.css`, `README.md`. **Currently installed in production.** |
| Messages/arch worktree (this thread) | `.../worktrees/thr_wmbk3fy5bs-1/bb-plugin-unified-inbox` | 871467b (same as main) | dirty (all uncommitted) | Read-only Messages integration (imsg client/mapping/media, cache, search), gateway spec + plan + tasks, T1–T2 adapter types; modifies `app.tsx` (new header UI), `server.ts`, `src/inbox-cache.ts`, `tsconfig.json`, `README.md` |
| staging copy | `~/.bb/thread-storage/thr_wmbk3fy5bs/messages-stage-KBT2JHcM/plugin` | merged build of Messages work | verified, **unregistered** | Messages-integrated build + rollback copy; was production until the tagging thread installed over it |
| original workspace | `.../workspaces/thr_5evde35y5u/bb-plugin-unified-inbox` | pre-Messages | pristine | untouched; do not reinstall (dist rebuild risk) |

**Production today:** the tagging build — no iMessage source, old conversation header. The user has noticed both regressions.

**Conflict surface:** `app.tsx`, `server.ts`, `README.md` are modified in all three trees; `src/inbox-cache.ts` in two. No merge anywhere has combined any two of them.

## Sequence

Do the consolidation in an integration branch **in this worktree**, never in the main checkout (the LinkedIn thread works there; see hazards).

1. **Checkpoint this worktree.** ✅ Done — four commits on `bb/explore-adding-imessage-to-the-unified-inbox-thr_wmbk3fy5bs`: `4e7f2c5` Messages integration, `ac649dc` spec/plan/tasks, `f76055e` consolidation plan, `f4d50cd` gateway T1–T2.
2. **Integration branch.** ✅ Done — `integration/inbox-consolidation` merges `41f9f72` (tagging) as `e266d9e`. Conflicts resolved in `app.tsx` (Messages header + chat renderer, tagging `+` buttons added to header and row actions for every account) and `server.ts` (`openConversation()` refactor adopted, extended with the imessage branch; `imsg_media` kept; `cached()` keeps Messages rows via imessage in `sourceAccounts`). Gates: 63/63 tests, `tsc --noEmit` clean, `bb plugin build` clean.
3. **LinkedIn lands last.** ✅ Done — thr_yzwhws3amz committed its WIP on main at its human-gate pause (`e403e8c` read-only LinkedIn source, `e6a9d67` research notes; sign-in gate cleared, verified live through the BB browser) and main merged into the integration branch as `decbb19`. All five-account conflicts resolved (unions, list/list_source branches, `openConversation` LinkedIn branch, UI filter/timers, read-only mention footer); gates: 73/73 tests, `tsc --noEmit` clean, `bb plugin build` clean.
4. **Production rebuild from the consolidated tree.** Interim install done for steps 1–2 (`consolidated-stage-0983baec`, see its ACTIVATION.md): production already serves Messages + new header + tagging; Messages rows retained. Remaining: the same staging protocol for `decbb19` adds LinkedIn — snapshot, gates, install, verify all five sources read-only + six Messages actions + two LinkedIn rejections (mutations + non-conversation open).
5. **Fast-forward main.** Push the integration result into main when thr_yzwhws3amz is paused or done (it committed at the gate and holds installs; coordinate before moving its branch).
6. **Gateway migration starts** from consolidated main; states 1–5 in the spec's plan execute on that baseline. T1–T2 are already done and type-only, so they ride along.

## Hazards

- **Main checkout is occupied.** thr_yzwhws3amz has uncommitted work in `/Users/robert/dev/bb-plugin-unified-inbox`. Do not merge, stash, or rebase there; steps 3 and 5 wait for a pause point in that thread.
- **Registration flip-flop.** Any thread can install its own build over production again. Until step 4, the other two threads should hold installs (or accept that step 4 overwrites them last-wins).
- **The staging copy is a snapshot, not a branch.** Its conflict-resolved `app.tsx`/`server.ts` were resolved against the pre-tagging base; they do not pre-solve the step-2 conflicts, only inform them.
- **No data risk.** All merges are code-only; the plugin SQLite cache schema is untouched by every tree.

## Open decisions

1. Production in the meantime: keep the tagging build until step 4, or reinstall the existing staging copy now (restores iMessage + new header, loses tagging until step 4).
2. Who tells the other two threads to hold installs and to commit at pause points — robert, or this thread via bb messages.
3. Whether step 2 starts now or after thr_yzwhws3amz's plan completes (step 3 needs it either way, but steps 1–2 do not).