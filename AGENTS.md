# unified-inbox — where things are, and how to work here

A BB plugin: five message sources (Gmail ×2, WhatsApp, Messages, LinkedIn) behind one inbox tab.
`PLUGIN_OVERVIEW.md` says what it does. This file only routes.

## Run and prove

```sh
npm test          # the suite: node --experimental-strip-types --test tests/*.test.ts tests/adapters/*.test.ts tests/whatsapp/*.test.ts
npm run typecheck # tsc --noEmit
npm run check     # typecheck + the Baileys patch + the suite + send audit: the order a commit needs
npm run build     # NOT a bare `bb plugin build`: the pinned WhatsApp client is patched first
npm ci            # in a fresh worktree: node_modules is not shared, jsdom needs it
```

The WhatsApp client is a pinned, patched copy on disk (`_tools/patch-baileys.mjs`, plan D7). A fresh `npm ci`
leaves it unpatched, and an unpatched client pairs and then shows nothing — so build through `npm run build`,
and `npm run check` fails on an unpatched tree rather than letting the bundle ship wrong.

`git config core.hooksPath .githooks` (once per clone, already set here) makes the pre-commit hook refuse a
commit whose `docs/_index.md` is stale, and typecheck when a `.ts`/`.tsx` file is staged.

The test runner strips types but **not JSX**; component tests go through `tests/jsdom-harness.ts`
(`typescript.transpileModule`). Page expressions are TS template literals, so a lone `\s` reaches the page
as `s` — write `\\s`. Production CSS loads `inbox.css → chat.css → layout.css`.

## Where to look

| you need | read |
|---|---|
| how it behaves for a person | `README.md` (install and use), `PLUGIN_OVERVIEW.md` (store page) |
| commands a person runs by hand | `docs/operator.md` |
| why a choice was made | `decisions/` — frozen, each dated and `Verified against the code` (`decisions/README.md`) |
| what a feature was scoped to | `specs/` — historical once shipped; opens with a status block |
| how work was planned, what was measured | `docs/plans/`, `docs/research/` — historical; a finished plan says "Superseded" |
| a defect and its evidence | `docs/bugs/` |
| a problem already solved, and the trap it taught | `docs/solutions/` — relevant before debugging the same area again |
| every document, one page | `docs/_index.md` (generated — `node --experimental-strip-types _tools/docs-index.ts`) |
| **which module owns which invariant** | **`src/CONTEXT.md`** — read this before grepping |
| the words for the product | `UBIQUITOUS_LANGUAGE.md` — one word for one thing; the code wins if they disagree |
| the shared adapter contract | `src/adapters/README.md`, `src/adapters/types.ts` |
| the RPC surface | `src/rpc-contract.ts` (the gateway handlers are `createGateway` in `src/gateway.ts`) |

Four kinds of document age at four speeds. `README.md`, `PLUGIN_OVERVIEW.md`, and `docs/operator.md` stay current. They have different jobs, so do not paste one into another.
If a decision and the code disagree, the code wins and the decision needs a current-state note, not an edit.

## Rules that bind an agent here

1. **This checkout is the live plugin.** It runs from `/Users/robert/dev/bb-plugin-unified-inbox` on `main`.
   Confirm with `bb plugin source unified-inbox` before you build. `npm run build` then `bb plugin reload
   unified-inbox` is what ships. A thread worktree is not live. A child thread never does this; the parent
   verifies live.
2. **Check the branch before merging.** `git merge` runs on whatever is checked out: `git branch --show-current`
   first. Child branches are generated names, not the spec's.
3. **A child's green report is not a commit.** Read `git log <branch> -1` before believing it.
4. **Never message Robert Sinke**, and never send from a name match — identity must be verified.
5. **LinkedIn and Gmail sends** pass one gate (`src/adapters/policy.ts`); a send without `allow: 'send'` is
   refused and recorded. LinkedIn writes are recorded, not approved (`decisions/0004`).
6. **Process leaks belong upstream** (BB), not in a workaround here.
7. **A finished child is archived, not left lying around.** Once its work is merged and its task is
   `done`, or once it has reported and its branch is settled, `bb thread archive <id>`. A spawn that
   died on a provider timeout is archived the moment its replacement exists. The live thread list is
   how the next reader finds what is still in flight; idle threads from last week are noise in it.

## Adding a document

Copy the shape of its neighbours, put `status:` in the frontmatter, and run `node --experimental-strip-types _tools/docs-index.ts`
before committing — a test fails if `docs/_index.md` is stale.
