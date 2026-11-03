---
title: LinkedIn as an inbox source — access options
description: Which LinkedIn surfaces can feed unified-inbox, which access paths exist, and what each costs in maintenance and account risk
type: research-note
status: settled
date: 2026-11-03
tags:
  - research
  - provisional
  - linkedin
  - unified-inbox
sources:
  - resource: ./sources/2026-10-28-linkedin-user-agreement.md
  - resource: ./sources/2026-10-28-linkedin-api-getting-access.md
  - resource: ./sources/2026-10-28-linkedin-marketing-program.md
  - resource: ./sources/2026-10-28-linkedin-mcp-server-readme.md
  - resource: ./sources/2026-10-28-linkedincli-readme.md
  - resource: ./sources/2026-10-28-beeper-linkedin-bridge-readme.md
  - resource: ./sources/2026-10-28-beeper-linkedin-bridge-roadmap.md
  - resource: ./sources/2026-10-28-hiq-v-linkedin.md
  - resource: ./sources/2026-10-28-unipile-docs-index.txt
  - resource: ./sources/2026-10-28-github-candidate-metadata.csv
---

> **Closed by** [`decisions/0003`](../../../decisions/0003-the-session-is-minted-where-it-reads.md): the plugin reads
> LinkedIn inside a Chrome it starts with its own profile, and the session never leaves that browser. The
> sidecar, cookie-auth and commercial-intermediary paths argued below were not taken; the reasoning is kept.

## Question

Can LinkedIn message threads be pulled into the Unified Inbox plugin — and if so, which access path is actually viable for an unattended local connector, at what maintenance cost and what account risk?

## Context

The plugin today has two adapters behind one contract (`account → list_source / open / action`): Gmail through the `gws` CLI, and WhatsAgent through a local MCP endpoint ([server.ts](../../../server.ts)). Adding LinkedIn means adding a third source. This research exists to decide *which transport* that source uses before any code is written, because every candidate path has a different owner of the risk: LinkedIn (official API), an OSS project (MCP server / library), or us (browser or raw HTTP client).

Decision informed: which LinkedIn transport the plugin should adopt, and what it is allowed to do on day one (read-only vs read+reply).

## Findings

### 1. The official API path is effectively closed for a personal inbox

Self-serve LinkedIn API access is limited to "Open Permissions" plus explicitly approved products ([Getting Access to LinkedIn APIs](./sources/2026-10-28-linkedin-api-getting-access.md)). The self-serve products are Sign In with LinkedIn (OpenID Connect, profile only) and Share on LinkedIn (posting on behalf of the member).

The paid/partner program is the Marketing API, and its documented scope is advertising, events, lead sync, and Community Management for **company Pages** — page admin roles, follower analytics, comments, reactions, mentions ([LinkedIn Marketing API Program](./sources/2026-10-28-linkedin-marketing-program.md)). A member's personal DM inbox is not in the public documentation set, and the marketing docs table of contents contains no messaging integration at all (verified against `learn.microsoft.com/en-us/linkedin/marketing/toc.json`, 2026-10-28).

Consequence: any "official" route for personal DMs means a partner application, a company entity, and a review LinkedIn is under no obligation to grant. Not a path for a personal inbox prototype.

### 2. The de-facto protocol is LinkedIn's internal `Voyager` API with cookie auth

Every practical implementation drives the same thing: a logged-in session (`li_at` + `JSESSIONID` cookies, CSRF token derived from `JSESSIONID`) against `linkedin.com/voyager/api/...`, or a real browser rendering the same routes.

- `bcharleson/linkedincli` — TypeScript CLI + MCP, 43 commands including messaging, explicit "cookie session auth", cookie sources: Chrome cookie-jar import, `--li-at`/`--jsessionid` flags, env vars, or `~/.linkedin-cli/config.json`; warns that `li_at` "can also be invalidated immediately when the client TLS fingerprint does not look like Chrome" ([README](./sources/2026-10-28-linkedincli-readme.md)).
- `beeper/linkedin` — the Beeper Matrix bridge implemented full messaging over this protocol: text, media, mentions, edits/deletes, reactions, typing notifications, read receipts, mark-as-read ([roadmap](./sources/2026-10-28-beeper-linkedin-bridge-roadmap.md)). **Archived 2025-03-17**, last functional commit 2024-08 ([repo metadata](./sources/2026-10-28-github-candidate-metadata.csv)). Proof the protocol is workable at production quality; proof that a serious team stopped maintaining it.
- `stickerdaniel/linkedin-mcp-server` — 4.0k★, Apache-2.0, pushed the day of this research. Does **not** hand-roll HTTP: it drives a Patchright (stealth Playwright) Chromium against the real site and exposes MCP tools `get_inbox`, `get_conversation`, `search_conversations`, `send_message` ([README](./sources/2026-10-28-linkedin-mcp-server-readme.md)).

### 3. A maintained MCP server already exposes exactly the tools the plugin needs

`linkedin-mcp-server` supports `--transport streamable-http --host 127.0.0.1 --port 8000 --path /mcp` — the same shape as the WhatsAgent endpoint the plugin already speaks through `StreamableHTTPClientTransport` ([README, transport modes](./sources/2026-10-28-linkedin-mcp-server-readme.md)).

Tool-to-contract mapping is near 1:1:

| Plugin contract | LinkedIn MCP tool |
|---|---|
| `list_source` | `get_inbox` |
| `open` | `get_conversation` |
| `action: reply` | `send_message` (confirmation-gated upstream) |
| `search` | `search_conversations` |

Operationally it is a heavy dependency: a bundled Chromium cache under `~/.linkedin-mcp/patchright-browsers`, a persistent profile at `~/.linkedin-mcp/profile`, session import from an already signed-in local browser (`--auto-import`, may trigger one macOS keychain prompt), a 180s default per-tool timeout, an idle browser timeout (600s default), serialized tool calls with a "browser is busy" error, and a documented browser-version check that refuses to launch an older Chromium than the one that last wrote the profile — with `--login` as the recovery path.

### 4. Browser-session persistence is the real engineering problem, not the scraping

What the README documents is a session lifecycle, not a parser:

- Session acquisition: reuse a local signed-in browser (import full cookie jar) or open a login window; 2FA/checkpoint handled by the human once.
- Session storage: a profile directory that holds cookies plus derived state; rotating/clearing it deletes the profile **and its parent**.
- Session expiry: "Sessions expire over time. When tool calls start asking for authentication, repeat the login command."
- Session fragility: Chrome 127+ app-bound cookie encryption (`v20`) can make cookie import impossible without OS elevation — then only an interactive login works.

That is the honest shape of the "headless browser with stored session id" option: it works, and it needs a human-visible recovery path roughly every few weeks.

### 5. ToS position is unambiguous, and the legal cases do not help

LinkedIn's User Agreement §8.2 prohibits, verbatim: "Use bots or other unauthorized automated methods to access the Services, add or download contacts, **send or redirect messages** …", and "Develop, support or use software, devices, scripts, robots … to scrape or copy the Services", and using another's account "such as sharing log-in credentials or **copying cookies**" ([User Agreement excerpts](./sources/2026-10-28-linkedin-user-agreement.md)).

`hiQ v. LinkedIn` only ever addressed *public profile* scraping under the CFAA; hiQ still lost on breach of contract and settled ([case summary](./sources/2026-10-28-hiq-v-linkedin.md)). Nothing in that line of cases protects authenticated inbox access or automated messaging.

The OSS projects say the same thing in their own words: "LinkedIn's User Agreement prohibits automated access, and accounts using automated tools can be restricted or banned. Use at your own risk; there is no guarantee of account safety."

### 6. Commercial intermediaries sell exactly this, and take the maintenance

`Unipile` markets a hosted LinkedIn API plus a "Unified Inbox" solution and ships an MCP server; its docs index lists chat/message endpoints (start chat, edit/delete message, reactions), InMail credit balance, and raw-endpoint passthrough ([Unipile docs index](./sources/2026-10-28-unipile-docs-index.txt)). `gtm-api/linkedin-mcp` claims "20,000+ accounts on this stack, under 1% ever restricted" (vendor claim, unverified).

These remove the browser/session work, not the account risk — and they add a paid dependency and a third party that holds a live LinkedIn session.

### 7. A zero-risk read-only fallback already exists in the inbox

LinkedIn sends message and InMail notification emails. The plugin already has a Gmail adapter (`gws`), so a `from:linkedin.com` filter can surface "you have a new message from X" as inbox items without touching LinkedIn at all. Coverage is shallow — subject line, sender name, deep link, no thread body — and depends on the account's notification settings. Adequate as a signal, not as a conversation view.

## Trade-offs

| Path | Maintenance | Account risk | Depth | Fits existing code |
|---|---|---|---|---|
| Notification emails via Gmail | none new | none | subject + sender + link | trivial (existing Gmail adapter) |
| OSS MCP server (`linkedin-mcp-server`, streamable HTTP) | follow an active project; own a Chromium + profile + login recovery | ToS violation; restriction possible | full threads, replies, search | strong — same MCP client as WhatsAgent |
| Raw Voyager client (`linkedincli` style, `li_at` + `JSESSIONID`) | low code, high fragility (TLS fingerprint, endpoint drift) | highest — headless cookie reuse is the exact pattern LinkedIn targets | full threads | medium — new HTTP client |
| Own Playwright/Patchright connector | highest — selectors, session, detection | high | whatever we script | medium — new sidecar process |
| Managed API (Unipile / Cadenza / gtm-api) | lowest | unchanged (their session, your account) | full threads + extras | strong — REST or MCP |
| Official partner API | application + review | none | not available for personal DMs | n/a |

Cross-cutting: every authenticated path concentrates risk on one personal account, and that account is the user's professional identity. A read-only connector is materially safer than one that sends, because `send or redirect messages` is named explicitly in the User Agreement.

## Open questions

1. Does `linkedin-mcp-server` survive unattended use on this Mac — cold start, 600s idle browser close, and its serialized queue — under a 60s poll? (Needs a spike, not more reading.)
2. How often does a session actually expire in practice here, and what does the recovery look like when the plugin, not a human, is the caller?
3. Does the notification-email path cover DMs, InMail, and connection requests, or only some? (Check the account's notification settings against a week of real mail.)
4. Is Unipile's per-account pricing tolerable, and does their session survive without periodic re-auth? Pricing page is JS-rendered — needs a sales conversation or dashboard trial.
5. Would a second, dedicated LinkedIn account (not the primary professional identity) change the risk calculus enough to make any path acceptable?

## Tentative recommendation

Do not build a client; attach to the maintained MCP server.

Attach `linkedin-mcp-server` as a sidecar over streamable HTTP, exactly the way WhatsAgent is attached: discover an independently-managed local process, fail closed if it is absent, and map `get_inbox → list_source`, `get_conversation → open`. Read-only, with no send, connect, or accept branch registered at all.

**Not chosen: deriving items from LinkedIn notification email.** That path is zero-risk and was an early suggestion, but it shows LinkedIn's notification mail rather than the conversation, so it does not answer a request for messages, InMail, and invites. Recorded here so it is not re-proposed; see [the plan](../../plans/2026-10-28-002-feat-linkedin-inbox-source-plan.md).

Reuse over reinvention: writing our own Voyager client duplicates a battle-tested, actively maintained project and inherits all of its fragility without its user base. Owning a Patchright connector ourselves is the worst combination — maximum maintenance, maximum detection surface, no upstream fixes.

The honest caveat, stated once: any authenticated path violates LinkedIn's User Agreement §8.2, and the failure mode is restriction of the account that holds the user's professional network.

## Further reading

- [LinkedIn User Agreement — automation clauses](./sources/2026-10-28-linkedin-user-agreement.md)
- [Getting Access to LinkedIn APIs](./sources/2026-10-28-linkedin-api-getting-access.md)
- [LinkedIn Marketing API Program](./sources/2026-10-28-linkedin-marketing-program.md)
- [linkedin-mcp-server README](./sources/2026-10-28-linkedin-mcp-server-readme.md)
- [linkedincli README](./sources/2026-10-28-linkedincli-readme.md)
- [Beeper LinkedIn bridge README](./sources/2026-10-28-beeper-linkedin-bridge-readme.md) / [roadmap](./sources/2026-10-28-beeper-linkedin-bridge-roadmap.md)
- [hiQ v. LinkedIn summary](./sources/2026-10-28-hiq-v-linkedin.md)
- [Unipile docs index](./sources/2026-10-28-unipile-docs-index.txt)
- [Candidate repo metadata](./sources/2026-10-28-github-candidate-metadata.csv)
- Browser choice for the reads we already do: [Obscura as the LinkedIn browser](./obscura-as-linkedin-browser.md) (no-go: headless-only, no sign-in window)
- Existing plugin plan: [reliable unified inbox plan](../../plans/2026-10-28-001-feat-reliable-unified-inbox-plan.md)
