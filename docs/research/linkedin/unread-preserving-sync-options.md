---
title: "LinkedIn sync and unread-state alternatives"
status: settled
date: 2026-11-03
---

# LinkedIn sync and unread-state alternatives

**Date:** 2026-10-29  
**Question:** Can we sync real LinkedIn conversations automatically without marking them read, while retaining a path to future replies and other actions? Read-only is a safety boundary for initial testing, not the product's permanent scope.


> **Closed by** [`decisions/0003`](../../../decisions/0003-the-session-is-minted-where-it-reads.md): none of the
> candidates below (sidecar, linkedincli, Unipile, Beeper bridge) was adopted — reads happen in the plugin's own
> Chrome page, and the delta check keeps unread state through the mailbox marker (`src/linkedin-delta.ts`).
## Conclusion

**A preserving alternative is plausible, but not yet verified on the account.** The sidecar tested in [the spike](./spike-sidecar.md) is not proof that all integrations mark conversations read: its `get_inbox` implementation obtains thread IDs by clicking conversation rows. The account owner's controlled before/after check found that one unread conversation became read after this call. Upstream source explicitly warns that row clicks may mark rows read. We cannot yet recommend accepting that limitation as unavoidable.

The strongest local candidate is **linkedincli's direct conversation-list and message endpoints**, which have separate explicit mark-read and send commands. The strongest managed candidate is **Unipile's message webhooks and message-history API**. Neither has been tested against this account, and neither documentation nor source establishes LinkedIn's actual read-state side effects. Confirm via a controlled unread-before/after test before choosing either.

## Candidates

| Candidate | Evidence | Future actions | Unknowns and costs |
| --- | --- | --- | --- |
| Current `linkedin-mcp-server` 4.28.0 | `get_inbox` navigates to messaging, extracts rendered text, then clicks rows to derive thread IDs; owner observed an unread conversation become read after a call. [Upstream implementation](https://github.com/stickerdaniel/linkedin-mcp-server/blob/main/src/linkedin_mcp_server/linkedin/conversations.py) (the inspected installed 4.28.0 implementation) | Advertises `send_message`; connection actions also exist upstream. V1 remains non-mutating apart from side effects of reads. | Already demonstrated side effect; no structured unread flag in observed output. Requires a browser and account-risk caveat. |
| [linkedincli](https://github.com/bcharleson/linkedincli/blob/88f775ef95c5b8ad1d3b6d1056f94ef92282b8bb/src/commands/messaging/messaging.ts) | Its conversation list issues a GET to `/messaging/conversations`; message retrieval GETs conversation events; mark-read is a separate POST. This is a client-code observation, **not** proof that the server leaves unread untouched. | Implements send to an existing thread and new conversations, plus explicit mark-read. | Unofficial Voyager endpoints, cookie session and TLS fingerprint fragility; actual endpoint support, invitation/InMail coverage, payload and read-state effects unverified. Installing and authenticating another connector needs a separate controlled test. |
| [Unipile](https://developer.unipile.com/docs/get-messages) | Vendor documentation advertises LinkedIn message history and real-time [new-message webhooks](https://developer.unipile.com/docs/new-messages-webhook), plus periodic message retrieval. | Vendor documents sending, edits, reactions and other LinkedIn actions. | External service holds access to the account; paid service, privacy and account risk; unread behavior during initial sync, history retrieval and webhooks is not documented in the inspected pages and is unverified. Webhooks require a reachable receiver. |
| [Beeper LinkedIn bridge](./sources/2026-10-28-beeper-linkedin-bridge-roadmap.md) | Historical bridge roadmap lists real-time messaging and a distinct mark-as-read capability. This suggests independent sync/read operations were possible historically, not that they work today. | Historically supported messages, edits, reactions and read receipts. | Archived in 2025, no current compatibility or preservation proof; not a supported dependency without further work. |

No Gmail notification fallback is proposed: the user needs real conversations. No candidate has demonstrated pending-invitation notes on this account. The LinkedIn User Agreement prohibits unauthorized automated access and explicitly mentions automated messaging; none of these approaches removes account restriction risk.

## Recommended next experiment

Test linkedincli **without sending, marking read, or importing credentials into this plugin**. First inspect its authentication and execution path; then, with the owner's approval for a second connector and its cookie-access implications, establish one manually unread message. Execute only the list-conversations operation, ask the owner to verify LinkedIn read state, and record the exact success/error shape without storing credentials or private message bodies. If list succeeds and preserves unread, separately test fetching that thread's messages and verify again. Do not conflate source-code GET requests with a guarantee of no server-side mutation. If the endpoint fails or changes read state, evaluate the managed alternative only after the user decides whether third-party account access and cost are acceptable.

The existing MCP approach remains NO-GO under the original plan until its side effect and invitation scope are resolved. The owner has expressed a conditional preference for automatic sync with the limitation if no practical preserving method exists; that condition has not yet been established.
