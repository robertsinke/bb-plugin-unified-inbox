# docs — four shelves, four ages

Everything here is history except `PLUGIN_OVERVIEW.md` at the repo root. This file says which shelf answers
which question, so a reader stops at one shelf instead of walking the whole tree.

| shelf | holds | is it current? | how to read a file there |
|---|---|---|---|
| `plans/` | how a slice of work was planned, and handoffs between sessions | no — historical | a finished plan opens with **Superseded** and names what replaced it |
| `research/` | what was measured and argued, including verbatim captures under `research/*/sources/` | no — evidence, never rewritten | a path a decision closed opens with **Closed by**; `sources/` is upstream text, do not edit |
| `bugs/` | a defect, its evidence, and the proposed fix | as current as its last measurement | each records when it was re-checked |
| `solutions/` | a solved problem and the trap it taught | stable once solved | read before debugging the same area again |

## The status vocabulary

`status:` is what makes `docs/_index.md` a status board and not just a file list. Seven words, one meaning each:

| status | means | who reads it |
|---|---|---|
| `current` | describes the system as it is today | a reader who needs behaviour, not history |
| `open` | a live question or defect with no answer yet | whoever picks the work up next |
| `proposal` | a design nobody has accepted | the person deciding whether to build it |
| `settled` | the question it asked was answered; kept as evidence | someone re-arguing the same choice |
| `historical` | what happened, in order; nothing depends on it being current | someone reconstructing why |
| `shipped` | a spec whose work is in the code | someone reading the scoping, not the contract |
| `superseded` | replaced by a named successor | someone who followed an old link |

`decisions/` uses the ADR set instead — `accepted`, `superseded`, `deprecated` — because a decision is not a
document about work, it is a record of a choice. `docs/CONTEXT.md` and `docs/_index.md` declare no status:
they are the catalogue, not content.

## The line between a shelf and a decision

A shelf records **what happened and what was measured**. A decision (`decisions/`) records **what was chosen**.
When a plan, a research note or a bug argues for something a decision later settled, add one line at the top
of the note — `Closed by decisions/000N` — and leave the body alone. Do not rewrite history to look prescient,
and do not leave a reader chasing a path that was never taken.

## Adding to a shelf

1. Put it in the shelf whose question it answers, not in `docs/` directly.
2. Start it with its own status: frontmatter `status:` plus `date:`, or a bold **Date:** line for the
   notes that predate frontmatter.
3. Link to the neighbours it extends — a link beats a copy, and one fact lives in one place.
4. Run `node --experimental-strip-types _tools/docs-index.ts` so `docs/_index.md` still matches what is on disk.

## What does not go here

Code comments explaining a function, and the current contract of the RPC surface: those live beside the code
(`src/adapters/README.md`, `src/rpc-contract.ts`, `PLUGIN_OVERVIEW.md`). A fact with two homes is a fact that
will disagree with itself.
