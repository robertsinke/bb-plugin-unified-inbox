---
title: "Messages send approval: smallest enforceable boundary"
status: historical
date: 2026-10-29
---

# Messages send approval: smallest enforceable boundary

Status: **proposal only at the time (2026-10-29); the send gate has since shipped.** Messages sending is
enabled and every send is refused without `allow: 'send'` and recorded before delivery
(`src/adapters/policy.ts`, `src/send-audit.ts`). The containment question this proposal raises is still
open — see OQ-1 in `specs/001-unified-inbox-gateway/spec.md`.

## Framing

- **Beneficiary:** the Mac's owner, who wants agents to send Messages without an agent ever sending one unreviewed.
- **Observable change:** every agent-originated send is blocked unless the owner approves that exact recipient set and content; the owner's own Send in the composer still sends in one click.
- **Forced decision:** do we accept plugin-scoped enforcement now (agents with shell access can still bypass it), or do we also restrict agent OS capabilities so the guarantee is real?

## What BB actually enforces today

Evidence from `get-bb/bb` at `3bacfac9ed69d42392076e5b3da2815bec822cd8` (static read, not a live exploit test; this checkout is not proven identical to the installed 0.48.0 build):

| Mechanism | What it proves | Gap |
|---|---|---|
| `apps/server/src/services/plugins/plugin-rpc-caller.ts` | A server-held per-load token distinguishes *plugin-to-plugin* calls (`kind: "plugin"`). | Everything else — desktop UI, CLI, agents — is `kind: "client"`. The UI is not distinguishable from an agent. |
| `apps/server/src/routes/threads/interactions.ts` → `pending-interactions.ts` | A plugin form can be created, listed, and responded to. | The response carries only `{threadId, interactionId, value}`. No human identity, no gesture, no origin check. |
| `apps/cli/.../thread/interactions.ts` + its `respond` test | The CLI legitimately posts a form's JSON value. | An agent can answer its own approval card. Approval-by-plugin-card is therefore not a human check. |
| `apps/server/src/server.ts` (loopback + origin guard, no user auth) | Browser cross-origin requests are filtered. | Any local process, including an agent's shell, can call the same API and the `bb` CLI. |
| `requestPluginInteraction` | Persists the full plugin payload in `pending_interactions`. | Putting a whole message body in a card has a data-retention cost. |

**Conclusion:** no existing BB mechanism can distinguish "the human clicked" from "an agent called". A plugin-only approval card, a client-side confirm, or a digest stored by the plugin is forgeable by any agent with shell access.

## Bypass inventory (independent of the plugin)

1. `imsg` is on the agent's PATH (`~/.local/bin/imsg` → v0.20.0) and `imsg send` uses Messages' AppleScript surface. An agent can send directly, today.
2. `osascript -e 'tell application "Messages" to send …'` uses the same Automation grant BB already holds; TCC attributes the request to BB's process tree.
3. Accessibility / System Events can click Approve or drive the Messages UI, if BB is granted Accessibility (must be verified; it is not established by this review).
4. Browser automation of the local web UI can POST the approval endpoint unless approvals require a desktop-main-only credential.

So: **the guarantee depends on containment, not on the card's design.**

## Smallest host change that is actually meaningful

Reuse the existing interaction pipeline rather than build a new approval service:

1. **New interaction origin `action-approval`** (one discriminated-union member) carrying `{pluginId, method, inputDigest, summary, expiresAt}` — *digest and display fields only, not the message body*. Content stays in the plugin's memory.
2. **Server-side approval gate** in `respondToInteraction`: this origin can be resolved only by a request carrying a boot credential generated in server memory at startup and handed to the desktop main process over IPC. The credential is never exposed to the renderer, the CLI, or the HTTP surface. Result is `{outcome:"approved", approvalId}` or denied/expired.
3. **Single-use, bound consumption** in the plugin RPC path: the plugin's send method requires `approvalId`; the server verifies `pluginId`, `method`, and a canonical `inputDigest` (account, service, chat GUID, sorted recipient handles, exact body, attachment content hashes), checks unconsumed/unexpired, and marks it consumed in one transaction *before* dispatch. One approval authorizes exactly one send.
4. **Composer path:** the desktop main process mints an approval internally for the Send click and forwards it with the request; no card is shown. The renderer never holds the ability to mint.
5. **UI:** render the card from the trusted desktop shell, not from a page that a local HTTP caller can reach.

Touched files (smallest set): `apps/server/src/services/interactions/pending-interactions.ts`, `apps/server/src/routes/threads/interactions.ts`, the pending-interaction union in `packages/server-contract` / `@bb/domain`, one desktop IPC channel in `apps/desktop/src/main.ts`, one card component, and the plugin's send RPC contract. No new service, no new database for message bodies.

## Guarantees this buys

| Threat | With host change only | With host change + containment |
|---|---|---|
| Agent calls the plugin's send RPC without approval | Blocked | Blocked |
| Agent forges/edits an approval, replays it, or reuses it for other content or recipients | Blocked | Blocked |
| Agent answers its own card through CLI/HTTP | Blocked (boot credential is IPC-only) | Blocked |
| Agent runs `imsg send` / `osascript` directly | **Not blocked** | Blocked |
| Agent clicks Approve via Accessibility or automation | **Not blocked** | Blocked |
| Human uses composer Send | One click, no card | One click, no card |

The plugin cannot honestly claim "every agent-sent iMessage needs approval" until the bottom two rows are closed.

## Required permission restrictions

1. **Deny agent shells the send primitives:** no execution of `imsg`, and no AppleEvents to Messages. PATH removal is insufficient; needs a sandbox profile (`deny appleevent-send`, deny exec of the `imsg` path) or agent execution under a separate macOS user without the Automation/FDA grants.
2. **Deny agent processes Accessibility / System Events**, so UI approval cannot be clicked programmatically, and the composer cannot be driven.
3. **Keep the send helper outside that boundary:** the host launches the supervised `imsg` child from an unsandboxed path that retains the existing Automation grant. This preserves today's working send path.
4. **Approvals are desktop-only.** Remote web sessions and browser automation must not be able to mint; otherwise the loopback UI becomes the bypass.
5. **Leave all other agent permissions untouched.** Restricting AppleEvents and the `imsg` binary is narrower than removing shell access; the agent keeps reading messages, running tests, and editing code.
6. **Flag the residual gap:** BB currently holds Full Disk Access, so agents can read `chat.db`. Approval governs sending only; message-content exposure is a separate decision.

## Tests (before any enablement)

**Unit — digest and consumption**
- Canonicalization: recipient order, phone/email normalization, Unicode normalization, attachment byte hashes; two semantically identical proposals produce the same digest.
- Transactional single use: two concurrent consumptions yield exactly one dispatch.
- Expiry, wrong `pluginId`, wrong `method`, missing approval → reject.

**Integration — real host, dispatch recorder at the `imsg` boundary**
- Forged approval: fabricated `approvalId`, valid-looking digest, no boot credential.
- Replay: the same `approvalId` after a successful dispatch.
- Mutation after approval: text changed, recipient added/removed/reordered, service switched iMessage↔SMS, attachment bytes swapped, chat GUID swapped — each rejected.
- Agent self-approval: `bb thread interactions respond`/`approve` and a direct loopback HTTP POST cannot resolve an `action-approval`.
- Human path: a real desktop click approves once and dispatches once; denial, timeout, and host restart dispatch nothing.
- Composer: a real Send click dispatches with no card; a scripted click is refused when containment is on.

**Containment tests (the ones that decide the guarantee)**
- Agent shell runs `imsg send …` → must fail.
- Agent shell runs `osascript` targeting Messages → must fail.
- Agent drives the approval card via Accessibility → must fail.
- Document the result either way; if any of these succeed, the release is plugin-scoped, not system-wide, and must say so.

## Open questions

- Does the installed desktop build grant Accessibility to BB (determines bypass 3)? Resolve by checking TCC state with the owner present.
- Can `sandbox-exec` deny `appleevent-send` for agent shells without breaking the plugin's send child? Resolve by a spike.
- Is the boot credential readable from the server process by a same-user agent? Resolve by attempting `ps e`/debugger attach without root.
- Retention: is a digest-only approval row acceptable, or is even the recipient list too sensitive?

**Not in scope:** read/unread, reactions, replies, attachments, and any send enablement. Sending stays disabled until the containment tests pass and the owner separately authorizes a live send.
