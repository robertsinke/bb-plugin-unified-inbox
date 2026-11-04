---
title: One RPC call arrived as null and as an empty object
date: 2026-11-04
category: integration-issues
module: RPC contract (unified-inbox plugin)
problem_type: integration_issue
component: tooling
symptoms:
  - "rpc capabilities failed: rpc input validation failed (Invalid input: expected null, received object)"
  - "rpc list failed: rpc input validation failed (Invalid input: expected null, received object)"
  - "rpc send_audit failed: rpc input validation failed (Invalid input: expected object, received null)"
  - "rpc mail_approval_status failed: rpc input validation failed (Invalid input: expected object, received null)"
root_cause: missing_validation
resolution_type: code_fix
severity: medium
tags: [rpc, zod, contracts, null, cli, validation]
status: settled
---

# One RPC call arrived as null and as an empty object

## Problem

The plugin's contract declared each method's input as exactly one shape, and callers sent two.
A no-argument method was `z.null()`, so a client that always sends a body (`{}`) was refused before
its handler ran; the two reads whose every field is optional were declared as a bare object, so a
caller with nothing to ask (`null`) was refused the same way. The refusals are the caller's problem
to look at and nobody's to act on: the call carried no information either way.

## Symptoms

| logged | method | shape refused |
|---|---|---|
| 2026-10-31 20:49 (×2) | `capabilities` | `expected null, received object` |
| 2026-10-31 20:57, 2026-11-01 14:03 (×4) | `list` | `expected null, received object` |
| 2026-11-01 14:03 | `linkedin_sync` (since removed) | `expected null, received object` |
| 2026-11-03 14:53 | `send_audit` | `expected object, received null` |
| 2026-11-03 17:16 | `mail_approval_status` | `expected object, received null` |

No caller in this repository produced them, which was the first wrong turn: see below.

## What Didn't Work

- **Reading the plugin counter as a live signal.** `bb plugin list` showed `54 errors` and I took it
  for current breakage. It is cumulative since install: 46 more handler calls moved the count not at
  all, and `docs/bugs/2026-11-03-handler-error-counter-conflates-timeouts.md` already records that the
  counter cannot say which calls failed. The log had to be read per entry instead.
- **Looking for the caller in this repo.** No call site passes `null` to `send_audit` or
  `mail_approval_status`, and `inbox-session.ts` passes `null` correctly to the no-argument calls. The
  `null` and the `{}` both come from outside: `bb plugin rpc call` defaults to `--input-file` → `null`,
  and an RPC bridge that always sends a body sends `{}`. A contract that admits one and refuses the
  other will keep failing for a caller this repository does not own.
- **Fixing the two already-fixed cases again.** `send_audit.output` refusing a null `reason` and
  `send_gmail.input` requiring `cc` looked like part of the same defect, and both were already fixed
  (`fed43bd`, `cba1c51`) before this work started. Checking `git merge-base --is-ancestor` first saved a
  second patch for a bug that no longer existed.

## Solution

One schema now says a no-argument call may arrive either way (`src/rpc-contract.ts:34`), and every
no-argument method uses it:

```ts
// A method that takes nothing still gets called more than one way: `null` from the panel, the CLI
// and the mention provider, `{}` from a client that always sends a body. Both name the same call, so
// they mean one thing here instead of a schema refusal for whichever way the caller happens to send.
const noArgs = z.union([z.null(), z.object({}).strict()]);
```

The two reads whose fields are all optional admit the empty call the same way `list` already did
(`src/rpc-contract.ts:74`, `:101`):

```ts
send_audit:           { input: z.object({ limit: z.number().int().min(1).max(50).optional() }).strict().nullable(), … },
mail_approval_status: { input: z.object({ approvalId: …optional(), keyId: …optional() }).strict().nullable(), … },
```

A nullable input reaches the handler as `null`, so the handlers read through it rather than
destructuring (`src/gateway.ts:221`) or touching a property (`src/mail-approval.ts:86`):

```ts
async send_audit(input) { return { rows: audit.list(input?.limit ?? 5) }; }
async function status(input: { approvalId?: string; keyId?: string } | null) { … input?.approvalId … }
```

Strictness is untouched: `{ limit: 5 }` sent to `cached` is still refused, and an unlisted field is
still refused everywhere. Only the call that carries nothing is now accepted twice over.

## Why This Works

`defineRpcContract` derives both the handler input type and the caller's argument list from the input
schema, and `PluginRpcCallArgs` makes the argument optional exactly when `null` is assignable to the
input. So one schema choice fixes the three places that disagreed: the server's validation, the
handler's parameter type, and the client's arity. `z.object({}).strict()` accepts only `{}` — no
unknown key slips in under cover of tolerance.

## Prevention

- A method that takes nothing is declared `noArgs`, never `z.null()`; a method whose fields are all
  optional is `.nullable()`. Both shapes are pinned by test in `tests/rpc-contract.test.ts` ("a call
  that takes nothing parses as null and as an empty object", "the audit and approval-status reads
  survive a caller with nothing to ask"), and the handlers by `tests/gateway.test.ts` ("a call with
  nothing to say answers the same for null, empty and missing").
- When a refusal arrives with no call site in this repo, look at the RPC default before the code:
  `bb plugin rpc call` sends `null` unless given `--input-file`.
- Before treating a validation failure as new, check whether it is already fixed:
  `git log --oneline -S "<the schema line>"` and `git merge-base --is-ancestor <commit> HEAD`.
- The same class is visible in BB's own plugins (`connect`, `github`, `combined-sidebar` all log
  refusals of this kind), so the durable fix is at the RPC boundary upstream, not one schema at a
  time here.

## Related Issues

- `docs/bugs/2026-11-03-handler-error-counter-conflates-timeouts.md` — why the error count cannot be
  read as "how many calls failed just now".
- `decisions/0007-reject-unknown-fields-in-signed-contracts.md` — strictness on the signed-claim
  boundary, which this change does not loosen; the empty call is not an unknown field.
- `docs/solutions/logic-errors/recorded-writes-read-back-empty-2026-11-02.md` — the other shape of the
  same trap: a read-out that reports nothing without saying which kind of nothing.
