# src — which module owns which invariant

Read this before grepping. Every row below is a **decision that only one module is allowed to make**; if you
need to change it, change it there and let the rest follow. Rows carry module paths and, where the symbol *is*
the invariant, the symbol — never line numbers, which rot within a week.

Two things are deliberately absent: a function inventory (the editor gives you that for free) and anything
whose owner is still contested. A wrong owner is worse than no map, so the last section lists what is
unsettled rather than guessing.

## The invariants

| invariant | owner | what it decides |
|---|---|---|
| whether a send happens | `src/adapters/policy.ts` | the policy per account, the 5-minute window, single spend, and that the `allowed` audit row is written *before* delivery; `.observe` for page-confirmed LinkedIn sends |
| whether mail approval matches the actual send | `src/mail-approval.ts`, reached only through `createSendGate.mail` | exact frozen mail binding, required pins, prepare/compatibility/require, atomic unique spend plus audit before dispatch; `src/send-approval/canonical.ts` mirrors Home's shared vectors |
| what a source is | each adapter's `source` declaration, typed by `src/adapters/source.ts` | label, icon, poll interval, page size — the one place a source describes itself |
| what a source can do | `src/adapters/capability.ts` (`CAPABILITY_KEYS`) | the vocabulary; every adapter declares every key, so a missing capability is a type error, not a runtime surprise |
| how a source delivers a message | `src/adapters/index.ts` (`createRegistry`) | one `sync`, one `media`, one `send` per account — transport differences are absorbed here, never in the gateway |
| whether a Gmail credential exists, and when its access token is renewed | `src/gmail-oauth.ts` | the one 0600 record per account in the plugin data dir, the access-token cache and its expiry margin, one refresh in flight per account, and the last failure kept on the record; no other module reads or writes the credential file |
| whether a whatsapp account exists, and what is in its account state | `src/whatsapp/auth.ts` | one 0700 directory in the plugin data dir with 0600 files, AES-256-GCM blobs under a key kept beside them; a blob that will not decrypt is refused, never replaced — a fresh identity is a re-pair, and re-pairing is the ban lever |
| when a whatsapp socket exists, and what it reports | `src/whatsapp/connection.ts`, with `src/whatsapp/version.ts` | connect, the 5 s → 60 s reconnect ladder, `loggedOut` as terminal, the pairing events; the version probe and its fallback constant are one decision, and the socket gets a silent logger because its info lines carry the registration payload |
| that only one whatsapp socket exists per account state | `src/whatsapp/lock.ts` | an `O_EXCL` pid lock in that same directory, released on stop or dispose: a live holder is a refusal, a dead one is stale and replaced |
| what the whatsapp transport remembers | `src/whatsapp/store.ts`, written through `src/whatsapp/ingest.ts` | the `wa_*` tables in the plugin database — messages with their raw envelope (so Baileys' `getMessage(key)` answers and a replay is idempotent), chats with the read cursor (`last_read_msg_id`, which is what "unread" is derived from and what a read mark moves forward), contacts and reactions; history that was synced starts read, live messages do not; `clear_cache` empties them (`src/inbox-cache.ts`) and the account state is deliberately not among them |
| what answers a whatsapp read | `src/whatsapp/transport.ts` | the `WhatsAppTransport` seam: chat names, previews and unread derived from stored rows, a sender's display name, whether media has cached bytes, a read mark, a send over the socket. A read never needs the socket; a send and a receipt do, and nothing here asks a second program |
| what the RPC surface is | `src/rpc-contract.ts` | every input and output schema; the handlers in `src/gateway.ts` are checked against it, and the panel's client is typed by it |
| what an agent can read and inspect | `src/inbox-agent-tools.ts` | `inbox_list` browses the cache and `inbox_search` returns ranked cached excerpts; media references must belong to the named cached conversation; image bytes are returned as image content, never as text |
| what the panel may ask for | `src/gateway.ts` (`createGateway(deps)`) | method bodies, paging cursors, and the older-page deadline |
| source refresh and freshness | `src/inbox-refresh.ts`, wired by `server.ts` and `src/gateway.ts` | backend service lifetime, per-source single flight, attempts versus live success; `src/inbox-cache.ts` persists status and independent body timestamps |
| the panel's state and timing | `src/inbox-session.ts` | the snapshot, every intent, cache observation and open-thread watch, draft and attachment rules, `olderRows` |
| a conversation's identity | `src/linkedin-conversation.ts` | urn → short key → mailbox, one spelling per conversation; `pageConfirmedConversation` in `src/linkedin-ui.ts` decides what value a row may take from the page |
| what a LinkedIn write may replay | `src/linkedin-page-session.ts` and `src/linkedin-write.ts` | the page envelope, the recorded request, and the rule that a replay needs `confirm: true` |
| the LinkedIn session's life | `src/linkedin-chrome.ts` | profile dir, prewarm, idle stop, shared operation gate; list/probe failures preserve the interactive page, interactive failures reset it; the session is never exported |
| what is remembered between runs | `src/inbox-cache.ts`, `src/inbox-drafts.ts`, `src/send-audit.ts` | cached rows, stored drafts (words, never bytes), and the audit table |
| the size of a draft | `src/inbox-session.ts` beside the composer | the encoded-message ceiling, not the raw byte count (`decisions/0002`) |
| what the panel draws | `src/inbox-appearance.ts`, `src/composer-mode.ts`, `src/format.ts` | bubble geometry per source, composer mode, and text shaping — not the components |

## Where the seams are, and why

- **Panel ↔ gateway** is a typed RPC call, not an import. `src/inbox-session.ts` takes
  `rpc: Pick<PluginRpcClient<typeof rpcContract>, 'call'>`, so a renamed method or reshaped input fails `tsc`
  rather than a live call.
- **Gateway ↔ source** is the adapter registry. `account ===` branches in the gateway or the panel are a bug:
  capability or declaration decides layout and behaviour.
- **Adapter ↔ Gmail** is the `GmailTransport` factory in `src/adapters/types.ts`. `server.ts` hands out one
  `src/gmail-client.ts` client per account over the single credential store, so no adapter knows whether a
  read went over a socket or a process.
- **Adapter ↔ WhatsApp** is the `WhatsAppTransport` interface in `src/adapters/types.ts`, built once in
  `server.ts` over the plugin's store and its own socket. The adapter cannot tell a live answer from a
  stored one, which is what keeps a read working when the socket is down.
- **Page ↔ plugin** is the LinkedIn page session. Nothing else evaluates an expression in that profile.

## Unsettled — do not treat as settled

- **Who owns the list and where the next page starts.** The cursor lives in `src/gateway.ts`, the deadline and
  the "rows the user already sees" guard live in `src/inbox-session.ts`. Two owners today.
- **The panel's render decisions.** `app.tsx` still decides facts inside JSX; a view model is the named next
  step in `decisions/0001`.
- **Whether `Message` stays one union across five sources.** It is the contract's shape today
  (`src/rpc-contract.ts`), and a sixth source may force a split.
