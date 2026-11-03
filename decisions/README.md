# Decisions — how an ADR is written here

One file per decision: `NNNN-short-title.md`. A decision is **frozen once accepted**: it records what was
chosen, on what day, against what alternatives. Nothing in the body is rewritten later — a decision that
stops holding is superseded by a new one, which links back with `Supersedes:`.

## Metadata, in this order

```
# NNNN — the decision in one line

- **Type:** architecture decision | product decision | policy
- **Description:** one sentence a reader can act on
- **Status:** accepted | superseded | deprecated
- **Date:** YYYY-MM-DD
- **Deciders:** who
- **Supersedes:** NNNN, or "nothing"
- **Verified against the code:** YYYY-MM-DD — what was checked, or "not applicable: no code shape"
- **Tags:** a few, lower case
```

## Why `Verified against the code` exists

An ADR is read as current even though it is a record of one day. Its reasoning cannot rot; its numbers and
file shapes can — and a rotted number is worse than a missing one, because a reader treats it as fact.

So a decision carries the date someone last opened the code and checked the parts of it that name code. The
line does not make the decision true; it tells the next reader whether to trust the details, and when to look
again. If the check finds the decision still holds, say so — "still holds" is the most useful sentence an
ADR can carry years later. If a detail moved, add a short **current-state note** under the metadata that
says what moved and where it lives now, and leave the body alone.

The same rule applies to the rest of the tree, at a different speed:

| document | what it is | how it ages |
|---|---|---|
| `decisions/` | why a choice was made | frozen; add `Verified` and a current-state note |
| `specs/` | how a feature was scoped | historical once shipped; open with a status block |
| `docs/plans/` | how work was planned | historical; open with "Superseded" |
| `docs/research/` | what was measured and argued | kept as evidence; mark what a decision closed |
| `PLUGIN_OVERVIEW.md`, `README.md` | how it works now | **must** be current — this is the one to maintain |
