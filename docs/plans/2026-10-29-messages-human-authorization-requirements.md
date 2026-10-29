# Messages human authorization: host requirements

Status: **blocked; sending remains disabled.** This is a host integration and verification requirement, not an implementation or evidence of an existing authorization API.

## Required behavior

- An agent may propose a message, but each dispatch requires its own interactive ask-user card and explicit human approval. No setting, prompt instruction, API flag, standing permission, or agent-accessible response may bypass the card.
- The card must present the exact service/account, actual chat and all recipients, message text, and any attachments the user is approving. Approval applies to only that exact operation, once. Change, cancellation, expiration, replay, restart ambiguity, or uncertainty fails closed.
- A human composing directly in the inbox may send with one Send click, without a second approval. Agents must not be able to invoke that direct-human path.
- Keep Messages actions blocked until both paths are demonstrably enforceable. Other Messages capabilities are separate from the sending policy and must not be claimed available until individually supported and tested.

## Existing host evidence

The installed BB plugin SDK documents `experimental_caller` as `plugin` only for server-verified plugin-to-plugin calls, and `client` for the app, CLI, agents, and bb alike (`backend-sdk.md`, “Calling another plugin's RPC”). It does not distinguish a human composer click from an agent's client call. `bb thread interactions respond` can submit JSON to a plugin form; `bb.ui.requestInput` alone is therefore not evidence of a human-only response. The SDK documentation establishes available interfaces, not a complete adversarial audit of BB.

Source review of `get-bb/bb` commit `3bacfac9ed69d42392076e5b3da2815bec822cd8` confirms the SDK description: `apps/server/src/services/plugins/plugin-rpc-caller.ts` returns `client` when there is no plugin caller token. `apps/server/src/routes/threads/interactions.ts` forwards the response payload to `pending-interactions.ts`, whose plugin submission handler receives the interaction ID, thread ID and JSON value, not a verified human identity. `apps/cli/src/__tests__/command-output/thread-interactions.test.ts` tests that the CLI posts the form response. This is a static source review, not a live exploit test; the checked-out host revision is not yet proven to be the exact installed build. The host also persists the request payload in `pending_interactions` (`requestPluginInteraction`), so putting a complete message in an ordinary plugin form has a data-retention consequence.

A frontend boolean, `isTrusted` check, unverified caller label, secret embedded in frontend JavaScript, plugin-owned confirmation RPC, or card that agents can resolve does not satisfy the requirement. Plugin-only tests and simulated human events cannot demonstrate the trust boundary. Browser automation and remote sessions also need explicit treatment; an authenticated browser session is not, by itself, proof of human intent.

## Host capability needed

BB must provide a host-enforced mechanism that (1) accepts an agent's immutable proposal, (2) obtains an actual human decision through the required card, (3) supplies the plugin an unforgeable, one-use authorization bound to the exact proposal, and (4) rejects agent/CLI/programmatic resolution and replay. Separately, the host must verify that a direct composer Send was genuinely human-initiated and bind it to the same immutable content; it must not equate an ordinary plugin RPC from the UI with proof of a human action. No particular API or authentication mechanism is assumed here; host owners must define the trusted input mechanism, its remote-access and automation threat model, and lifecycle semantics.

The plugin must resolve and display the actual recipients before the decision and revalidate them before dispatch, particularly for group membership changes. Attachment identity must cover exact bytes, not just a mutable file path. The server, not the agent or UI, enforces authorization and atomic single consumption immediately before dispatch. Any uncertain send must be reconciled rather than automatically retried. Approval and message text should not be unnecessarily persisted to thread history, logs, or general-purpose tokens.

**Scope:** A plugin gate alone cannot stop an agent with independent OS access from running `imsg` or otherwise automating Messages directly. A system-wide guarantee additionally requires an OS/host sandbox or equivalent controls on those independent paths. The eventual deployment must state and test the scope it actually enforces.

## Acceptance tests before enabling sending

Run against the actual BB host and actual UI, with no real message sent during adversarial tests. Substitute a dispatch recorder at the last boundary, and separately verify the authorized real transport only with explicit user consent and a known recipient.

1. A genuine human approves one agent-proposed message; exactly one dispatch occurs. Denial, timeout, cancellation, or host restart without an unambiguous decision dispatches nothing.
2. An agent calls the direct-human endpoint, submits or resolves the card by CLI/SDK/RPC, uses browser automation, forges caller metadata, or replays/copies an authorization: all fail without dispatch.
3. A genuine human types and clicks Send in the inbox; exactly one dispatch occurs and no second card is shown. Programmatic or agent-originated equivalents fail the human path.
4. Changes to message text, account, chat, recipient set, attachment bytes, or operation after presentation invalidate approval. Concurrent or repeated attempts dispatch at most once.
5. Verify group routing, stale proposals, host disconnects, Automation permission denial, process crashes, and unknown delivery. Unknown results never trigger an automatic duplicate.
6. Verify any promised system-wide restriction against direct `imsg`, other automation paths, and agent-controlled processes—not merely the plugin RPC. If those controls are absent, explicitly document the narrower plugin-only scope.

Do not enable sending until these tests pass and a separate live send is authorized. The installed read-only plugin remains the recovery baseline.
