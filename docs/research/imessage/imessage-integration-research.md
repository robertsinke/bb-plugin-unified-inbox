---
title: Full-featured Messages integration research
description: Feasibility of reading and acting on Messages conversations from Unified Inbox
type: research-note
status: draft
date: 2026-10-28
tags: [research, provisional, imessage]
sources:
  - resource: ./sources/imsg-readme.md
  - resource: ./sources/imsg-send.md
  - resource: ./sources/imsg-advanced-imcore.md
  - resource: ./sources/imsg-rpc.md
  - resource: ./sources/reddit-search-results.html
  - resource: ./sources/imessage-kit-readme.md
  - resource: ./sources/spectrum-readme.md
  - resource: ./sources/spectrum-packages-imessage-local-src-index.ts
  - resource: ./sources/spectrum-packages-imessage-local-src-local-send.ts
  - resource: ./sources/spectrum-packages-imessage-src-remote-api.ts
  - resource: ./sources/spectrum-packages-imessage-src-remote-reactions.ts
  - resource: ./sources/spectrum-auth.ts
  - resource: ./sources/advanced-imessage-readme.md
  - resource: ./sources/photon-documentation.txt
  - resource: ./sources/photon-pricing.html
  - resource: ./sources/bluebubbles-server-docs.txt
  - resource: ./sources/bluebubbles-private-api-docs.txt
  - resource: ./sources/bluebubbles-server-readme.md
  - resource: ./sources/messageRouter.ts
  - resource: ./sources/chatRouter.ts
  - resource: ./sources/attachmentRouter.ts
  - resource: ./sources/beeper-bridge.html
  - resource: ./sources/mautrix-setup.html
  - resource: ./sources/apple-automation.html
  - resource: ./sources/apple-privacy.html
---

## Question

Which integration can give Unified Inbox a full-featured Messages channel, and what security, compatibility and operational compromises does it require? This is a technical survey, not a promise of feature parity or a decision to change system security.

## Findings

### Access paths

**Correction:** The original survey omitted [iMessage Kit](./sources/imessage-kit-readme.md), a strong candidate identified by the user. It is a macOS TypeScript SDK using database access and AppleScript, not merely a plan to build those pieces ourselves. It documents reading, watching, text and file sending, and group sending, and describes macOS 26 group identifiers. Its README points users to Spectrum for advanced actions such as reactions, threaded replies, editing, unsending and typing; that does not establish how Spectrum implements them or that its local provider supports them. Its `send()` resolves on AppleScript exit, not verified delivery, and multiple attachments are non-transactional. [iMessage Kit README](./sources/imessage-kit-readme.md); [Spectrum README](./sources/spectrum-readme.md).

1. **BlueBubbles bridge:** a macOS server reads and polls `chat.db`; it uses AppleScript for basic sending, attachment sending and chat creation, with an optional injected Private API helper for additional functions. Its documentation says AppleScript sending is less reliable than the private API. The server is macOS-only and needs a working Messages account. [Server documentation](./sources/bluebubbles-server-docs.txt); [server README](./sources/bluebubbles-server-readme.md).
2. **Build our own database + AppleScript adapter:** same basic building blocks without another service, but we would own database schema changes, text decoding, synchronization, automation, and everything else a bridge already solves. Neither database access nor AppleScript alone establishes full feature parity. [BlueBubbles server documentation](./sources/bluebubbles-server-docs.txt).
3. **mautrix-imessage bridge:** another Mac-based project; its README distinguishes basic use on a normal Mac from deeper integration on a Mac with SIP disabled. It introduces Matrix bridge infrastructure, making it a larger fit to assess for an inbox without an existing Matrix backend. [Bridge README](./sources/beeper-bridge.html); [setup documentation](./sources/mautrix-setup.html).

### Capability matrix

The following describes documented or code-exposed functionality, **not end-to-end verification**. Private API availability depends on the OS and installation. The private helper documentation reports testing through macOS 13; it does not establish compatibility with newer releases.

| Capability | Evidence | What remains unverified |
|---|---|---|
| List chats, history, new messages, attachments | Database polling and attachment access are documented; chat and message query handlers exist. [Server docs](./sources/bluebubbles-server-docs.txt), [chat router](./sources/chatRouter.ts), [message router](./sources/messageRouter.ts). | Pagination, edits and deletion reconciliation, local database WAL behavior, group identity, source transport and exact unread fidelity. |
| Send text and attachments; create chats | AppleScript supports basic sending and chat creation; send handlers exist. [Server docs](./sources/bluebubbles-server-docs.txt), [message router](./sources/messageRouter.ts). | Real delivery, failures, duplicate prevention, group behavior and transport-specific support. |
| Reactions, threaded replies, typing | Private helper lists these; replies require macOS 11+. [Private API docs](./sources/bluebubbles-private-api-docs.txt). | Actual operation on this Mac and with SMS/RCS or mixed groups. |
| Read and unread | Private helper documents marking read and marking unread (macOS 13+); router exposes both. [Private API docs](./sources/bluebubbles-private-api-docs.txt), [chat router](./sources/chatRouter.ts). | Cross-device synchronization and read receipts; marking unread is not necessarily reversal of a sent read receipt. |
| Edit and unsend | Private helper documents both on macOS 13+; corresponding handlers exist. [Private API docs](./sources/bluebubbles-private-api-docs.txt), [message router](./sources/messageRouter.ts). | Timing and recipient restrictions, error behavior, OS compatibility and correct propagation. |
| Groups and deletion | Private helper lists group rename, membership, leave, group photo, delete chat and delete message. [Private API docs](./sources/bluebubbles-private-api-docs.txt). | Which operations are local deletion versus unsending, and which group/transport combinations work. |
| SMS and RCS | Messages can contain more than iMessage; no source inspected here establishes complete bridge support for SMS/RCS. | Capabilities, required iPhone setup and labeling must be tested per transport. |

### imsg: standard reactions without disabling SIP

[imsg](./sources/imsg-readme.md) is a Swift macOS CLI and long-running JSON-RPC service which reads the local database, watches updates and sends via Messages automation. Its [send guide](./sources/imsg-send.md) documents six standard tapbacks through UI scripting without private framework injection. This is a correction to any earlier implication that all outgoing reactions require disabling SIP. The selected or last message receives the reaction, so exact target selection cannot be guaranteed; Messages must be foregrounded, and UI state, permissions and concurrent interaction matter. Local database confirmation does not prove remote delivery or exact targeting; retrying an uncertain reaction can remove it. Custom-emoji tapbacks cannot be sent this way.

[imsg's advanced guide](./sources/imsg-advanced-imcore.md) documents an optional injected helper for threaded replies, read state and other advanced operations. It states SIP must be disabled and warns macOS 26 library validation and entitlement checks can prevent functionality even then. It advises against relying on these advanced capabilities in production on macOS 26. [JSON-RPC](./sources/imsg-rpc.md) exposes capability/status probes, read, send and watch; verify exact RPC versus CLI support for tapbacks before integration.

Direct Reddit requests returned HTTP 403. [Search-result snippets](./sources/reddit-search-results.html) include BlueBubbles users discussing dedicated server Macs and private-API/SIP setup; these are unverified individual reports, not direct reading of threads or evidence of typical practice. The more authoritative technical support above comes from the tools' own documentation.

### Local non-sending check

On this Mac (macOS 26.6.2, Apple Silicon), SIP is enabled and `imsg` was not installed. The official v0.20.0 macOS release was downloaded into temporary storage; its SHA-256 matched the release checksum and its code signature passed integrity verification. No persistent installation, permission changes, message sends or private message reads were performed.

`imsg status` reported basic features enabled, advanced IMCore features disabled, and no bridge. Initially JSON-RPC status reported that the Messages database could not be opened. After the user granted BB Full Disk Access, a new RPC process reported the database ready; a bounded `chats.list` and one-message `messages.history` call both succeeded. Only counts and field names were printed, not private contents. The result included stable ID/GUID fields, sender, reactions, and attachment metadata fields. Its advertised supported-method list is not proof of readiness. Automation permission, actual sending, group routing, media contents and UI reactions remain untested.

Integration would use a supervised `imsg rpc` child with bounded JSON-RPC requests and independent failure handling. `chats.list`, history, and watch can supply the existing source model after permissions are granted; actual payloads and stable IDs still need verification. The ordinary standard-reaction CLI is distinct from the RPC `tapback` bridge method: do not assume the latter works with SIP on. The inbox's current schemas omit rich message identifiers and reaction/reply structures, and its `account !== 'whatsapp'` UI branches would misclassify a new channel as Gmail. Proper capability-based actions and confirmation-gated mutations are required; unknown sends must be reconciled before retry.

### Inbox integration contract and approval boundary

The [imsg RPC reference](./sources/imsg-rpc.md) exposes `chats.list` (limit and unread filter), `messages.history` (chat ID), `watch.subscribe` (ROWID cursor, attachment/reaction options), and `send` (exactly one chat selector or `to`, optional text/file/service). History and watcher mutation notifications include edited/unsent information; a ROWID replay covers insertions only, so a reconnect or overflow needs history reconciliation. A normal send can return an observed message ID/GUID, but automation success without database access is not delivery confirmation; ambiguous outcomes must not be retried blindly. `send.tracked` requires the injected helper and therefore is unavailable in the current SIP-on status. RPC `tapback`, `send.rich` for threaded replies, edit and unsend are bridge actions—not the SIP-on UI-driven `imsg react` CLI.

In [`server.ts`](../../../server.ts), add an explicit Messages account and dispatch branch for list/open, ensuring the Gmail fallback cannot receive it; update search's account allowlist and the separate aggregate list. In [`app.tsx`](../../../app.tsx), replace WhatsApp-versus-Gmail assumptions with explicit source capabilities; preserve independent failures and expose unavailable features honestly. The message schema must carry stable source message IDs, reaction relationships, attachment metadata, edit/unsend state and reply context where supported. Source ownership, process cleanup and bounded request framing require a supervised RPC client; do not treat the helper's reported method catalog as proof an operation is ready.

The existing WhatsApp approval (since replaced by one gate, `src/adapters/policy.ts`) was not a generic local confirmation service: the plugin proposes through WhatsAgent, hashes the reviewed text and sends confirmation to WhatsAgent's separate frontend endpoint, which enforces its own approval boundary. See [`server.ts`](../../../server.ts), [`src/whatsapp-confirm.ts`](../../../src/whatsapp-confirm.ts), and [`README.md`](../../../README.md). Copying a client-side confirm button or exposing a generic confirm RPC would let an agent call it and would not reproduce that protection. Before enabling Messages mutations, identify and test a BB-enforced user-approval boundary, bind approval to recipient/chat, payload and attachments, prevent replay, and define behavior for stale chats and uncertain dispatch. Do not assume the current WhatsAgent endpoint can authorize imsg.

After the user granted BB Full Disk Access, bounded chat and history reads succeeded without printing private content. Automation permission is separate and remains untested. No sending capability should be advertised based solely on the read check.

### Spectrum local versus advanced remote

Source inspection resolves the earlier local-provider question: Spectrum's [local provider](./sources/spectrum-packages-imessage-local-src-index.ts) wraps iMessage Kit and explicitly rejects edit, unsend, threaded reply, reactions, mark-read and group membership actions. Typing is a no-op. It cannot create group chats, although it can send to existing groups. Its [local send implementation](./sources/spectrum-packages-imessage-local-src-local-send.ts) uses synthetic message IDs, does not provide by-ID lookup or surface reactions, and rejects message effects and polls. These are Spectrum-local limitations; do not assume every one is a limitation of direct iMessage Kit usage.

The [remote provider](./sources/spectrum-packages-imessage-src-remote-api.ts) wires edit, unsend, reply, reactions, read, typing, and group operations to `@photon-ai/advanced-imessage` over gRPC. Its [reaction implementation](./sources/spectrum-packages-imessage-src-remote-reactions.ts) calls the remote API to set and remove reactions. The [advanced SDK documentation](./sources/advanced-imessage-readme.md) identifies an external Advanced iMessage server and supports an explicitly configured gRPC address and token; Spectrum's [cloud authentication code](./sources/spectrum-auth.ts) also provisions TLS-backed cloud clients. An SDK and self-configurable address do not demonstrate that the underlying advanced server is publicly available, self-hostable, compatible with the user's existing Apple account, or works with SIP enabled. Those questions require vendor documentation or direct confirmation. No test was performed against a server.

### Photon hosting, account and pricing investigation

Photon's [connection and routing documentation](./sources/photon-documentation.txt) distinguishes a local provider using the Mac's Messages account from cloud infrastructure using **Photon-provisioned lines**. Cloud Free/Pro use a shared pool; Business has project-dedicated lines. Free/Pro restrict sends to project-registered users and lack group creation and inbound group-change events; Business supports those group workflows. The documentation does not establish that an existing personal Apple account, number, or history can be attached to the advanced cloud backend. A dedicated Photon line is not evidence of access to the user's existing conversations.

The [pricing page](./sources/photon-pricing.html), captured 2026-10-28, advertises Free, Pro at $25/month, Business at $250/line/month, and custom Enterprise pricing; check current terms before purchasing. It describes the local open-source tier as using the user's iCloud account. It also advertises unlimited messaging with Auto Scale, while its [documentation](./sources/photon-documentation.txt) states default limits of 5,000 sends per server/day and 50 new conversations per line/day, subject to increases. Treat these as conditional marketing and operational limits, not a guaranteed unlimited quota.

The open-source Spectrum framework supports local adapters and configurable remote gRPC clients, but this research did not locate a public implementation or deployment guide for the advanced iMessage server: the attempted GitHub URLs for the named server and HTTP proxy returned 404 without authentication. This does not prove those repositories are private or nonexistent. The public SDK alone is not a self-hosted server. Spectrum Cloud's client code uses TLS and token renewal, but Photon backend processing, message storage and retention, account security, and server-side SIP requirements remain unverified. Ask the vendor before relying on them.

### Security and compatibility

- BlueBubbles asks for Full Disk Access; its setup says Accessibility is not required for basic operation. macOS also controls permission for apps to automate other apps. [Server setup](./sources/bluebubbles-server-docs.txt), [Apple Automation guide](./sources/apple-automation.html), [Apple file access guide](./sources/apple-privacy.html).
- BlueBubbles' private helper documentation instructs users to disable System Integrity Protection (SIP) to inject into Messages, and warns about associated risks. **Do not disable SIP as part of research or setup without a separate informed decision.** Its instructions are an upstream project's requirements, not an Apple-supported API guarantee. [Private API docs](./sources/bluebubbles-private-api-docs.txt).
- This machine reports macOS 26.6.2. The helper docs' stated test range ends at macOS 13, so compatibility here is **unknown**, not established by the documented minimum. Server and helper versions have separate compatibility constraints. [Private API docs](./sources/bluebubbles-private-api-docs.txt), [server README](./sources/bluebubbles-server-readme.md).
- A bridge can read private conversations and send as the account owner. A loopback-only, authenticated integration is preferable to exposing it publicly; actual bind, authentication, webhooks, credential storage and any cloud dependencies require verification. The server setup documents a manual notification setup that avoids Google sign-in; that alone does not prove every component can operate offline. [Server setup](./sources/bluebubbles-server-docs.txt).

## Fit with Unified Inbox

The existing [`server.ts`](../../../server.ts) has a fixed account enum and source-specific RPC paths; [`app.tsx`](../../../app.tsx) has source labels and action logic; [`src/inbox-cache.ts`](../../../src/inbox-cache.ts) stores local inbox data. The [README](../../../README.md) documents independent refreshes and a confirmation-gated WhatsApp send flow. A Messages integration needs explicit capabilities rather than letting a new source fall through Gmail-specific logic, and must preserve source isolation.

A full channel requires more than a transport adapter: it needs a message model and UI for attachments, delivery states, group participants, reactions, edits and unsends; bounded media access; synchronized read state; and explicit confirmation and authorization for mutating actions. Timeouts after a send require reconciliation before retry to avoid duplicate messages. Cached message content and media extend the existing sensitive-data footprint. These are design implications, not verified behavior of the current bridge.

## Trade-offs and tentative recommendation

**Evaluate imsg first for this personal inbox**, including its stdio RPC, macOS 26 behavior, and standard UI-automated reactions. It offers a promising SIP-on baseline, but cannot guarantee exact message targeting for those reactions. Threaded replies and richer actions still depend on its SIP-off helper and may fail on macOS 26; compare BlueBubbles only after testing those limits. Spectrum local uses the personal account but lacks key advanced actions; Spectrum cloud uses Photon-provisioned lines. No option currently establishes safe, complete parity. The alternative is implementing and maintaining an equivalent macOS integration ourselves. However, the documented route to advanced functionality requires disabling SIP and relies on private APIs; the current machine's OS is outside the documentation's tested range. Until these two issues are resolved, full capabilities are an unproven goal, not an implementation commitment. A dedicated Mac could isolate security exposure, but it does not establish compatibility.

## Open questions and verification

1. On macOS 26.6.2, which current iMessage Kit and BlueBubbles release and helper operations actually work? For Spectrum advanced, determine server availability, account onboarding, hosting, security requirements, pricing, privacy and whether an existing personal iMessage account is supported. Check maintained release notes and test on a non-production Mac/account; do not infer from older documentation.
2. Can the bridge bind only to loopback, authenticate all HTTP and event endpoints, and run without cloud relays? Inspect configuration and test locally.
3. With explicit permission and controlled test recipients, verify sends, groups, attachments, reactions, edits, unsends, read receipts, state synchronization, and transport-specific behavior. Do not send messages during this research.
4. Test reconnect, sleep, restart, denied permissions, stale events, duplicate-send protection and partial failures. Determine what data is retained in each component.
5. Determine whether the security trade-off of disabling SIP is acceptable before proposing installation; investigate supported alternatives where it is not.

## Source provenance

Captured 2026-10-28: [BlueBubbles server docs](https://docs.bluebubbles.app/server/llms-full.txt), [private API docs](https://docs.bluebubbles.app/private-api/llms-full.txt), [server README](https://github.com/BlueBubblesApp/bluebubbles-server), [router source](https://github.com/BlueBubblesApp/bluebubbles-server/tree/master/packages/server/src/server/api/http/api/v1/routers), [mautrix-imessage](https://github.com/mautrix/imessage), [mautrix setup](https://docs.mau.fi/bridges/go/imessage/mac-nosip/setup.html), [Apple Automation](https://support.apple.com/guide/mac-help/allow-apps-to-automate-and-control-other-apps-mchl108e1718/mac), and [Apple file permissions](https://support.apple.com/guide/mac-help/control-access-to-files-and-folders-on-mac-mchld5a35146/mac). Captures are snapshots; the upstream branch and documentation can change.
