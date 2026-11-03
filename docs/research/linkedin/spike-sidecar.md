---
title: "LinkedIn MCP sidecar spike"
status: settled
date: 2026-10-29
---

# LinkedIn MCP sidecar spike

**Date:** 2026-10-29  
**Machine:** local macOS checkout; LinkedIn MCP server 4.28.0 (`mcp-server-linkedin@latest`)  
**Endpoint tested:** `http://127.0.0.1:8000/mcp`  
**Evidence class:** observed against the signed-in account through the upstream MCP server. No cookies or message content are retained here.

## Verdict: NO-GO for U2 as currently scoped

The sidecar can return DM and InMail conversations, and repeated polling survived a 30-minute window. In a controlled check, a conversation the owner manually marked unread was marked read after one `get_inbox` call, according to the owner. Automatic polling can therefore destroy unread state; hiding unread indicators alone does not prevent this side effect. No suitable invitation-with-note sample was available. Do not start U2 until the invitation scope and this read-state side effect are explicitly resolved.

## Setup and first successful call

- The requested no-interaction launch used `--auto-import --transport streamable-http --host 127.0.0.1 --port 8000 --path /mcp`. It downloaded Patchright Chromium, then `get_inbox` reported that a LinkedIn login window was open and login was in progress. No keychain prompt was observed. The process was stopped; the human completed `--login` before the unattended test continued.
- After that login, the same auto-import/HTTP launch served successfully at the loopback endpoint. The MCP server advertised `get_inbox` and `get_conversation`; it did **not** advertise `get_session_status` in version 4.28.0.
- First successful inbox call after the signed-in server was ready took 9.65 s. Subsequent polling calls had a median of 10.9 s and maximum of 20.4 s. This is MCP call latency, not a complete process-install-to-first-call cold-start measurement.

## Inbox contents and payload shape

- `get_inbox` returned a `url`, `sections.inbox` (rendered inbox text), and `references.inbox` (conversation references with LinkedIn messaging URLs and visible participant labels). A conversation reference's URL contains the thread identifier. `get_conversation` with one observed thread ID returned `url`, `sections.conversation` (rendered conversation text), and `references.conversation`.
- Real DMs and an InMail were observed in the Messaging inbox. The InMail was visibly labeled `InMail` in the inbox; opening its thread returned its conversation text. This establishes DM and InMail support for the observed surface.
- A request for up to 50 items exposed 20 conversation references. No invitation, connection-request row, or invitation note appeared in the inspected inbox output. The account owner also reports they do not think there is currently an invitation with a message attached to test. This is **not** evidence that invitations never appear; pending-invitation coverage and invitation-note behavior remain **unobserved**.
- No synthetic or Gmail-derived rows were involved.

## IDs, restart, and re-login

- Across one controlled sidecar process restart (same saved login/profile), the same 15 thread-reference URLs were returned for the same `get_inbox(limit: 20)` call; the sorted URL-set SHA-256 was identical (`695808…fe0ad`). Thus the observed IDs were stable across this restart.
- Stability across a **re-login** was not tested. Re-login would require another human authentication step; no inference is made from restart stability.

## Read-state effects

- `get_inbox` did not return a structured unread flag or an unread count; its output was rendered UI text. The payload therefore does not establish whether inbox retrieval changes LinkedIn read state.
- `get_conversation` by the observed thread ID returned the real conversation. No before/after unread marker or count was available in the MCP result to establish whether opening it changed read state. The tool description warns that username-based resolution visits matching rows and may mark them read; that warning is not a measurement of this run's state change.
- **Controlled follow-up:** the account owner manually marked a conversation unread, then a fresh sidecar received exactly one `get_inbox(limit: 20)` call, which succeeded in 22.7 seconds and returned 15 conversation references. Immediately afterward, the owner reported that the conversation was marked read. This establishes the observed before/after sequence; no independent instrumentation excluded an outside concurrent change or isolated which navigation within the tool caused it. Treat `get_inbox` as potentially marking conversations read, including on automatic polls.
- The effect of `get_conversation` separately remains unobserved. Do not present LinkedIn unread state as authoritative; suppressing an indicator alone does not protect LinkedIn's actual read state.

## Failure behavior

- **Process absent:** after stopping the sidecar, connecting to `127.0.0.1:8000/mcp` failed with `TypeError: fetch failed`, cause `connect ECONNREFUSED 127.0.0.1:8000`.
- **Session expired / unauthenticated:** not tested. The session was kept intact; the server exposed no `get_session_status` tool. Do not infer the expired-session signature from the initial login-in-progress response.
- **Browser busy:** not induced; no concurrent browser client was run. Signature remains unobserved.

## Unattended polling and idle close

- Ran 30 consecutive `get_inbox(limit: 20)` calls at 60-second intervals for a full 30-minute window (09:11:42–09:41:42 UTC). All 30 succeeded; no MCP error occurred. Each response continued to include an InMail row. Calls after the 600-second browser idle-close threshold also succeeded (first observed at 09:21:42 UTC, 10 minutes after polling began).
- This demonstrates survival under the tested polling cadence for this account/session and server version. It does not establish behavior after session expiry or LinkedIn-side throttling.

## Invitation follow-up

After explicit approval for the read-state risk, one `get_inbox(limit: 50)` call succeeded and returned 22 conversation references. The rendered inbox text did not contain an obvious invitation or note label. No invitation was opened and no message was sent. The sidecar was stopped after the check.

The user clarified that pending invitations and their notes appear in LinkedIn's invitations UI, not as messaging conversations until accepted. Consequently, checking `get_inbox` cannot establish pending-invitation coverage. Offline inspection of the installed 4.28.0 tool registrations found no tool to list received invitations; linkedincli has a `connections received` command, but authentication failed in earlier tests. Access to the separate invitation surface, including its note and stable identifier, remains unverified; never accept or reject an invitation as part of this read-only investigation.

## Findings for U2

| Question | Finding |
| --- | --- |
| Endpoint | `http://127.0.0.1:8000/mcp` |
| DM / InMail surface | Both observed; rows are rendered inbox text plus thread URL references |
| Pending invitations / notes | Unobserved; none appeared in the inspected inbox output |
| ID stability | Stable across one process restart; re-login untested |
| Read-state effect | Owner-marked unread conversation was read after one `get_inbox` call; `get_conversation` separately untested |
| Absent process | MCP connection fails with `fetch failed` / `ECONNREFUSED` |
| Expired session / unauthenticated call | Unobserved; no session-status tool in 4.28.0 |
| Browser busy | Unobserved |
| 60-second polling beyond idle close | 30/30 successful calls during a 30-minute run |
| U2 decision | **NO-GO** until invitation scope and the observed read-state side effect are explicitly resolved |

## Chosen path: read-only page-context reads (verified)

The sidecar needs no further use. The working mechanism is a same-origin read inside the signed-in BB browser:

- `GET /voyager/api/me` gives the member reference used as the mailbox urn.
- `messengerConversations` returns 20 conversations with `entityUrn`, `lastActivityAt`, `unreadCount`, and `descriptionText`.
- `messengerMessages` returns one conversation's messages with `body.text`, `deliveredAt`, and sender references.
- `identity/dash/profiles/<urn>` resolves participant and sender display names.
- `relationships/invitationViews?q=receivedInvitation` returns the 4 pending invitations observed on this account, including the one with a note.

Verified during implementation: 20 conversation rows with stable `urn:li:msg_conversation:` ids, 4 invitation rows with stable `urn:li:fs_relInvitation:` ids and timestamps, exactly one invitation carrying a note, and a conversation whose inbound message sender resolved to a display name. No conversation, invitation, or message was clicked, accepted, or sent. `customMessage` is a boolean "has a note" flag, so the note text comes from `message`; rendering `customMessage` produced a literal "true".

Unread came back as zero for every conversation, consistent with the earlier sidecar and browser scans having already consumed those indicators; the API field itself (`unreadCount`, `unseen`) is the authority and is passed through unchanged. The GraphQL query hash is build-specific, so the script prefers the hash the loaded page itself used and only falls back to a pinned one; a stale tab whose build no longer matches answers HTTP 400. The reader reuses a single `/feed/` tab rather than opening and closing one per poll: two consecutive runs under Aside left the LinkedIn tab count unchanged at 2. This is one visible browser tab that stays open, not a headless process.

## Cookie reuse outside the browser was rejected by evidence

Reading the BB browser cookie store and calling LinkedIn from Node also worked at first: 200 on `/voyager/api/me`, the conversations query, the invitations query, and one conversation's messages (20 conversations, 4 invitations, 1 with a note, 20 messages). Every cookie value was stored plaintext, so no Keychain decryption was needed.

Minutes later the BB browser's LinkedIn session was gone: `li_at` had disappeared from the cookie store and the BB browser redirected `/feed/` to `/uas/login`. LinkedIn rotates and can invalidate a session used from a different client, which is the same failure linkedincli showed as a login redirect. So the plugin must not hold the session outside the browser, however convenient it is: the read stays in-page, and only BB's own browser automation is used.
