# docs/_index.md — every document, one page

**Generated** by `node --experimental-strip-types _tools/docs-index.ts` from the files on disk — do not edit by hand. Status and date
are what each file states about itself. `docs/research/*/sources/` holds 50 verbatim upstream captures and is not listed here.

Which shelf answers which question: `docs/CONTEXT.md`. How to work in this repo: `AGENTS.md`.

## Current

| document | status | date | says |
| --- | --- | --- | --- |
| [`PLUGIN_OVERVIEW.md`](../PLUGIN_OVERVIEW.md) | current |  |  |
| [`README.md`](../README.md) | current |  |  |

## Reference

| document | status | date | says |
| --- | --- | --- | --- |
| [`docs/operator.md`](operator.md) | current | 2026-11-10 | Commands for an existing gws login, the credential files, the send log, and a cache clear. |
| [`docs/mail-approval.md`](mail-approval.md) | current | 2026-11-03 | Mail approval RPC, rollout settings, pinning, refusal codes, and remaining panel integration limits. |
| [`docs/notes-icons.md`](notes-icons.md) | current | 2026-11-01 |  |

## Decisions

| document | status | date | says |
| --- | --- | --- | --- |
| [`decisions/0008-the-plugin-owns-the-gmail-credential.md`](../decisions/0008-the-plugin-owns-the-gmail-credential.md) | accepted | 2026-11-05 |  |
| [`decisions/0009-the-plugin-owns-the-whatsapp-account.md`](../decisions/0009-the-plugin-owns-the-whatsapp-account.md) | accepted | 2026-11-05 |  |
| [`decisions/0010-a-source-transport-is-the-plugins-own.md`](../decisions/0010-a-source-transport-is-the-plugins-own.md) | accepted | 2026-11-05 |  |
| [`decisions/0002-the-ceiling-is-the-encoded-message.md`](../decisions/0002-the-ceiling-is-the-encoded-message.md) | accepted | 2026-11-03 |  |
| [`decisions/0003-the-session-is-minted-where-it-reads.md`](../decisions/0003-the-session-is-minted-where-it-reads.md) | accepted | 2026-11-03 |  |
| [`decisions/0005-keep-sends-enabled-until-verified-approval.md`](../decisions/0005-keep-sends-enabled-until-verified-approval.md) | accepted | 2026-11-03 |  |
| [`decisions/0006-the-inbox-owns-the-pin-list.md`](../decisions/0006-the-inbox-owns-the-pin-list.md) | accepted | 2026-11-03 |  |
| [`decisions/0007-reject-unknown-fields-in-signed-contracts.md`](../decisions/0007-reject-unknown-fields-in-signed-contracts.md) | accepted | 2026-11-03 |  |
| [`decisions/0004-linkedin-writes-are-recorded-not-approved.md`](../decisions/0004-linkedin-writes-are-recorded-not-approved.md) | accepted | 2026-11-02 |  |
| [`decisions/0001-deepen-the-inbox-panel-into-a-session-module.md`](../decisions/0001-deepen-the-inbox-panel-into-a-session-module.md) | accepted | 2026-11-01 |  |

## Specs

| document | status | date | says |
| --- | --- | --- | --- |
| [`specs/001-unified-inbox-gateway/plan.md`](../specs/001-unified-inbox-gateway/plan.md) | shipped | 2026-11-03 | Build phases and risks for the Unified Inbox gateway and adapter refactor |
| [`specs/001-unified-inbox-gateway/tasks.md`](../specs/001-unified-inbox-gateway/tasks.md) | shipped | 2026-11-03 | Task breakdown for the Unified Inbox gateway and adapter refactor |
| [`specs/001-unified-inbox-gateway/spec.md`](../specs/001-unified-inbox-gateway/spec.md) | shipped | 2026-10-29 | Restructure Unified Inbox into one gateway with per-provider adapters, so agent-reachable surfaces narrow to o |

## Plans

| document | status | date | says |
| --- | --- | --- | --- |
| [`docs/plans/2026-11-12-001-feat-inference-pii-redaction-plan.md`](plans/2026-11-12-001-feat-inference-pii-redaction-plan.md) | active | 2026-11-12 |  |
| [`docs/plans/2026-11-11-001-feat-linkedin-profile-link-plan.md`](plans/2026-11-11-001-feat-linkedin-profile-link-plan.md) | active | 2026-11-11 | The other person's name in an open one-to-one LinkedIn conversation opens their public profile in the system b |
| [`docs/plans/2026-11-10-001-feat-mute-conversations-plan.md`](plans/2026-11-10-001-feat-mute-conversations-plan.md) | completed | 2026-11-10 | The owner can mute any conversation. The row stays in the list. The Decisions plugin is not asked. |
| [`docs/plans/2026-11-10-002-feat-linkedin-shared-post-card-plan.md`](plans/2026-11-10-002-feat-linkedin-shared-post-card-plan.md) | active | 2026-11-10 | A shared post in an open LinkedIn chat shows the post's words and picture. The list does not wait on that read |
| [`docs/plans/2026-11-09-001-feat-whatsapp-poll-card-plan.md`](plans/2026-11-09-001-feat-whatsapp-poll-card-plan.md) | active | 2026-11-09 |  |
| [`docs/plans/2026-11-09-002-feat-marketplace-inbox-ux-plan.md`](plans/2026-11-09-002-feat-marketplace-inbox-ux-plan.md) | active | 2026-11-09 | A new person can connect Gmail, WhatsApp, LinkedIn, and Messages and use the inbox. The store page describes t |
| [`docs/plans/2026-11-08-001-feat-account-connect-settings-plan.md`](plans/2026-11-08-001-feat-account-connect-settings-plan.md) | active | 2026-11-08 |  |
| [`docs/plans/2026-11-06-001-feat-message-reactions-and-replies-plan.md`](plans/2026-11-06-001-feat-message-reactions-and-replies-plan.md) | completed | 2026-11-06 |  |
| [`docs/plans/2026-11-05-001-feat-whatsapp-transport-in-the-plugin-plan.md`](plans/2026-11-05-001-feat-whatsapp-transport-in-the-plugin-plan.md) | shipped | 2026-11-05 |  |
| [`docs/plans/2026-11-05-002-feat-lazy-loading-and-search-reach-plan.md`](plans/2026-11-05-002-feat-lazy-loading-and-search-reach-plan.md) | accepted | 2026-11-05 | Seven units: search membership stops being the cache's listing, WhatsApp and Messages index what they already  |
| [`docs/plans/2026-11-04-001-refactor-own-source-transports-plan.md`](plans/2026-11-04-001-refactor-own-source-transports-plan.md) | active | 2026-11-04 |  |
| [`docs/plans/2026-11-03-001-fix-mail-approval-rollout-plan.md`](plans/2026-11-03-001-fix-mail-approval-rollout-plan.md) | active | 2026-11-03 |  |
| [`docs/plans/2026-11-02-next-slices.md`](plans/2026-11-02-next-slices.md) | historical | 2026-11-02 |  |
| [`docs/plans/2026-11-02-slice-b-work-units.md`](plans/2026-11-02-slice-b-work-units.md) | historical | 2026-11-02 |  |
| [`docs/plans/2026-11-01-handoff-inbox-session-and-next-candidates.md`](plans/2026-11-01-handoff-inbox-session-and-next-candidates.md) | historical | 2026-11-01 |  |
| [`docs/plans/2026-10-30-inbox-source-sync-model.md`](plans/2026-10-30-inbox-source-sync-model.md) | historical | 2026-10-30 |  |
| [`docs/plans/2026-10-29-inbox-branch-consolidation.md`](plans/2026-10-29-inbox-branch-consolidation.md) | historical | 2026-10-29 |  |
| [`docs/plans/2026-10-29-messages-human-authorization-requirements.md`](plans/2026-10-29-messages-human-authorization-requirements.md) | historical | 2026-10-29 | A plugin gate alone cannot stop an agent with independent OS access from running `imsg` or otherwise automatin |
| [`docs/plans/2026-10-29-messages-integration-handoff.md`](plans/2026-10-29-messages-integration-handoff.md) | historical | 2026-10-29 |  |
| [`docs/plans/2026-10-29-messages-send-approval-proposal.md`](plans/2026-10-29-messages-send-approval-proposal.md) | historical | 2026-10-29 |  |
| [`docs/plans/2026-10-28-001-feat-reliable-unified-inbox-plan.md`](plans/2026-10-28-001-feat-reliable-unified-inbox-plan.md) | superseded | 2026-10-28 |  |
| [`docs/plans/2026-10-28-002-feat-linkedin-inbox-source-plan.md`](plans/2026-10-28-002-feat-linkedin-inbox-source-plan.md) | superseded | 2026-10-28 |  |
| [`docs/plans/2026-10-28-003-feat-local-messages-inbox-plan.md`](plans/2026-10-28-003-feat-local-messages-inbox-plan.md) | superseded | 2026-10-28 |  |

## Research

| document | status | date | says |
| --- | --- | --- | --- |
| [`docs/research/linkedin/feed-update-read.md`](research/linkedin/feed-update-read.md) | current | 2026-11-10 | The signed-in page reads one activity with the feed updates request. The card uses three fields. |
| [`docs/research/linkedin/writes.md`](research/linkedin/writes.md) | current | 2026-11-10 |  |
| [`docs/research/2026-11-05-baileys-rc14-against-the-pin.md`](research/2026-11-05-baileys-rc14-against-the-pin.md) | settled | 2026-11-05 | rc14 installs, patches after a one-line anchor fix, keeps 487 tests green, grows the bundle by 426 bytes, and  |
| [`docs/research/2026-11-05-baileys-whatsapp-transport.md`](research/2026-11-05-baileys-whatsapp-transport.md) | superseded | 2026-11-05 | What the plugin asks of WhatsAgent today, what an in-plugin Baileys transport would make us own, the first pro |
| [`docs/research/2026-11-05-gmail-faces-what-each-source-costs.md`](research/2026-11-05-gmail-faces-what-each-source-costs.md) | current | 2026-11-05 | The two live Gmail credentials carry no contact scope; Google has no photo-only scope, so a face means read ac |
| [`docs/research/2026-11-05-lazy-loading-and-search-reach.md`](research/2026-11-05-lazy-loading-and-search-reach.md) | settled | 2026-11-05 | Measured: the panel sees 111 of 699 WhatsApp chats, and search indexes 111 conversations with 999 of 6,186 sto |
| [`docs/research/2026-11-05-whatsapp-transport-a-stranger-can-install.md`](research/2026-11-05-whatsapp-transport-a-stranger-can-install.md) | settled | 2026-11-05 | Under the real constraint — a plugin user has no WhatsAgent — what has to ship, how a stranger pairs, which of |
| [`docs/research/linkedin/messenger-conversations-paging.md`](research/linkedin/messenger-conversations-paging.md) | settled | 2026-11-05 | Measured read-only on the signed-in page: the newest-page query ignores every paging variable, and the web app |
| [`docs/research/linkedin/linkedin-inbox-options.md`](research/linkedin/linkedin-inbox-options.md) | settled | 2026-11-03 | Which LinkedIn surfaces can feed unified-inbox, which access paths exist, and what each costs in maintenance a |
| [`docs/research/linkedin/linkedincli-safer-transport.md`](research/linkedin/linkedincli-safer-transport.md) | settled | 2026-11-03 | static research and a synthetic loopback test only. No LinkedIn session, cookie, Keychain entry, or external L |
| [`docs/research/linkedin/linkedincli-unread-test.md`](research/linkedin/linkedincli-unread-test.md) | settled | 2026-11-03 |  |
| [`docs/research/linkedin/sidecar-restart-review.md`](research/linkedin/sidecar-restart-review.md) | settled | 2026-11-03 | inspection of installed `mcp-server-linkedin` 4.28.0 source and documented CLI only. No sidecar was started, n |
| [`docs/research/linkedin/unread-preserving-sync-options.md`](research/linkedin/unread-preserving-sync-options.md) | settled | 2026-11-03 |  |
| [`docs/research/linkedin/obscura-as-linkedin-browser.md`](research/linkedin/obscura-as-linkedin-browser.md) | settled | 2026-11-02 | Protocol, persistence, macOS support, measured startup and memory, and containment for obscura 0.2.5 against t |
| [`docs/research/linkedin/browser-session-diagnostic.md`](research/linkedin/browser-session-diagnostic.md) | historical | 2026-10-29 |  |
| [`docs/research/linkedin/spike-sidecar.md`](research/linkedin/spike-sidecar.md) | settled | 2026-10-29 |  |
| [`docs/research/imessage/imessage-integration-research.md`](research/imessage/imessage-integration-research.md) | settled | 2026-10-28 | Feasibility of reading and acting on Messages conversations from Unified Inbox |

## Bugs

| document | status | date | says |
| --- | --- | --- | --- |
| [`docs/bugs/2026-11-05-a-dead-socket-was-never-reopened.md`](bugs/2026-11-05-a-dead-socket-was-never-reopened.md) | settled | 2026-11-05 |  |
| [`docs/bugs/2026-11-05-the-browser-outlives-the-plugin.md`](bugs/2026-11-05-the-browser-outlives-the-plugin.md) | fixed | 2026-11-05 |  |
| [`docs/bugs/2026-11-04-media-download-failure-is-not-temporary.md`](bugs/2026-11-04-media-download-failure-is-not-temporary.md) | settled | 2026-11-04 |  |
| [`docs/bugs/2026-11-04-the-failure-line-hides-the-failure.md`](bugs/2026-11-04-the-failure-line-hides-the-failure.md) | fixed | 2026-11-04 |  |
| [`docs/bugs/2026-11-03-handler-error-counter-conflates-timeouts.md`](bugs/2026-11-03-handler-error-counter-conflates-timeouts.md) | open | 2026-11-03 |  |
| [`docs/bugs/2026-11-02-orphaned-automation-processes.md`](bugs/2026-11-02-orphaned-automation-processes.md) | open | 2026-11-02 |  |

## Solutions

| document | status | date | says |
| --- | --- | --- | --- |
| [`docs/solutions/2026-11-09-the-accent-class-is-the-legacy-id.md`](solutions/2026-11-09-the-accent-class-is-the-legacy-id.md) | settled | 2026-11-09 |  |
| [`docs/solutions/2026-11-05-a-name-only-arrives-with-live-traffic.md`](solutions/2026-11-05-a-name-only-arrives-with-live-traffic.md) | current | 2026-11-05 |  |
| [`docs/solutions/logic-errors/avatar-fetched-on-the-read-path-2026-11-05.md`](solutions/logic-errors/avatar-fetched-on-the-read-path-2026-11-05.md) | settled | 2026-11-05 |  |
| [`docs/solutions/integration-issues/one-rpc-call-arrives-as-null-and-as-empty-2026-11-04.md`](solutions/integration-issues/one-rpc-call-arrives-as-null-and-as-empty-2026-11-04.md) | settled | 2026-11-04 |  |
| [`docs/solutions/logic-errors/recorded-writes-read-back-empty-2026-11-02.md`](solutions/logic-errors/recorded-writes-read-back-empty-2026-11-02.md) | settled | 2026-11-02 |  |
