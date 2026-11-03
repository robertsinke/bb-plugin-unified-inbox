# unified-inbox — where things are, and how to work here

A BB plugin: five message sources (Gmail ×2, WhatsApp, Messages, LinkedIn) behind one inbox tab.
`PLUGIN_OVERVIEW.md` says what it does. This file only routes.

## Run and prove

```sh
npm test          # the suite: node --experimental-strip-types --test tests/*.test.ts tests/adapters/*.test.ts
npm run typecheck # tsc --noEmit
npm run check     # both, in the order a commit needs them
npm ci            # in a fresh worktree: node_modules is not shared, jsdom needs it
```

`git config core.hooksPath .githooks` (once per clone, already set here) makes the pre-commit hook refuse a
commit whose `docs/_index.md` is stale, and typecheck when a `.ts`/`.tsx` file is staged.

The test runner strips types but **not JSX**; component tests go through `tests/jsdom-harness.ts`
(`typescript.transpileModule`). Page expressions are TS template literals, so a lone `\s` reaches the page
as `s` — write `\\s`. Production CSS loads `inbox.css → chat.css → layout.css`.

## Where to look

| you need | read |
|---|---|
| how it behaves now | `PLUGIN_OVERVIEW.md`, `README.md` |
| why a choice was made | `decisions/` — frozen, each dated and `Verified against the code` (`decisions/README.md`) |
| what a feature was scoped to | `specs/` — historical once shipped; opens with a status block |
| how work was planned, what was measured | `docs/plans/`, `docs/research/` — historical; a finished plan says "Superseded" |
| a defect and its evidence | `docs/bugs/` |
| every document, one page | `docs/_index.md` (generated — `node --experimental-strip-types _tools/docs-index.ts`) |
| **which module owns which invariant** | **`src/CONTEXT.md`** — read this before grepping |
| the shared adapter contract | `src/adapters/README.md`, `src/adapters/types.ts` |
| the RPC surface | `src/rpc-contract.ts` (the gateway handlers are `createGateway` in `src/gateway.ts`) |

Four kinds of document age at four speeds; `PLUGIN_OVERVIEW.md` is the only one that must stay current.
If a decision and the code disagree, the code wins and the decision needs a current-state note, not an edit.

## Rules that bind an agent here

1. **This checkout is not the live plugin.** The live install builds from a thread worktree under
   `~/.bb/plugins/environment-git-worktree/host-data/worktrees/<thread>/bb-plugin-unified-inbox`. Merging to
   `main` here changes nothing until that worktree fast-forwards and `bb plugin build` + `bb plugin reload
   unified-inbox` run there. A child thread never does this; the parent verifies live.
2. **Check the branch before merging.** `git merge` runs on whatever is checked out: `git branch --show-current`
   first. Child branches are generated names, not the spec's.
3. **A child's green report is not a commit.** Read `git log <branch> -1` before believing it.
4. **Never message Robert Sinke**, and never send from a name match — identity must be verified.
5. **LinkedIn and Gmail sends** pass one gate (`src/adapters/policy.ts`); a send without `allow: 'send'` is
   refused and recorded. LinkedIn writes are recorded, not approved (`decisions/0004`).
6. **Process leaks belong upstream** (BB), not in a workaround here.

## Adding a document

Copy the shape of its neighbours, put `status:` in the frontmatter, and run `node --experimental-strip-types _tools/docs-index.ts`
before committing — a test fails if `docs/_index.md` is stale.
