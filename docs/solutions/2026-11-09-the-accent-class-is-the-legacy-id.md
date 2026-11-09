---
status: current
date: 2026-11-09
---

# The Gmail accent class is the legacy id

## What it looked like

Personal Gmail and Inhouse Gmail drew colorless marks after a plugin reload. The same marks were red
and blue on a reload that still held `gmail-personal` and `gmail-business`.

## Why

The row class and the bubble class were the account id. The color rules name `gmail-personal` and
`gmail-business`. A reload renames each mailbox to its address when the profile read succeeds, and
leaves the legacy id when that read fails. An address matches no color rule.

This is the second time. The selectors were updated when the ids changed from `personal` /
`business` to `gmail-personal` / `gmail-business` (`42f027d`). The next rename, to the mailbox
address, kept those same selectors.

## What to do

`accentToken` in `src/adapters/types.ts` maps both spellings onto the legacy id. `sourceClass` and
`bubbleClass` use that token. The addresses live in `legacyGmailAddresses`, which `gmailFromAddress`
also reads. A mailbox that was never one of those two files still has no color rule.
