# Source adapters

`server.ts` is the transport; these adapters are the sources. The boundary is:

## The toolbox owns

- **Transport and validation** — the RPC schemas, the `capabilities` output, and
  every call into the registry.
- **Routing** — `createRegistry(deps)` maps one `Account` to one `Adapter`. The
  canonical account list is the `accounts` tuple in `types.ts`.
- **Cache and search** — `inbox-cache` stores conversations and threads;
  `search-index` ranks cached rows. Adapters write the cache; they do not own it.
- **Unread preservation, error isolation, and the send policy** — a failing
  source contributes an error without failing the other sources, and
  `send_gmail` decides whether a declared send may run at all.

## An adapter owns

How **one source** lists conversations, opens a thread, serves media and
attachments, and performs its actions. That includes source-specific mapping,
validation, refusal text, cache-only decoration and repair, and the
**capability declaration** this adapter promises to keep.

## The rule

A new source is a **new adapter plus a capability declaration**, never a new
`account === …` branch in `server.ts`.

1. Add the account to the `accounts` tuple in `src/adapters/types.ts`.
2. Implement `Adapter` in `src/adapters/<source>.ts` and declare `Capabilities`.
3. Register it in `createRegistry` in `src/adapters/index.ts`.
4. Prove the declaration in `tests/adapters/<source>.test.ts` with stubbed deps.

Behaviour is chosen by asking the registry or reading `capabilities()`, not by
testing the account name. A capability set to `false` means the adapter refuses
the operation **before** it touches the source. `canChange()` in
`capability.ts` is the shared mapping for `read`, `unread`, and `archive`;
`send`, `media`, and attachment entry points are implemented only where their
flag is true.

Declaration meanings:

| Flag | True means |
|---|---|
| `send` | The source can originate a message: Gmail through `send()`, WhatsApp and Messages through `action('reply')`. |
| `markRead` | `action('read')` and `action('unread')` are accepted. |
| `archive` | `action('archive')` is accepted. |
| `media` | Inline media can be served for an open conversation. |
| `attachments` | Named files can be served for a message. |
| `threads` | The conversation is a thread of messages, so the inbox reads it top to bottom and answers in a composer. False means the source opens a document with its own reading surface and mail form. |
| `followsList` | Re-reading one conversation is cheap enough that the open thread may follow a list refresh. LinkedIn declares false: its read is seconds long, so it keeps what it showed until reopened. |

These exist because `app.tsx` used to decide them by asking which source it was looking
at: a `threaded` that named LinkedIn and a re-read that skipped LinkedIn. A declaration is
the same decision, made by the source that owns it, so a new source inherits the right
behaviour by declaring it instead of by being mentioned in the UI.

**WhatsApp sends through the owner's composer, not the agent's proposal.** `reply` on
WhatsApp posts to WhatsAgent's `POST /api/chats/:jid/messages`, which dispatches the `send`
action as `caller: 'frontend'` — the owner's own composer — and enqueues to the single paced
outbox. The agent's `propose-send` tool refuses a group outright (WhatsAgent R8 excludes the
*drafting agent* from groups while AE4 keeps groups writable by the owner), so the inbox,
which types for the owner, belongs on the composer path. That is why a group chat sends from
here, and why there is no two-phase "propose, then confirm" in this UI: nothing is being
approved but the owner's own sentence.

## Known asymmetries

- **Gmail sending is implemented but disabled by policy.** The adapter declares
  `send: true` and `send()` works against the runner; `send_gmail` in
  `server.ts` still refuses every call. The capability is honest about the
  adapter; the policy narrows it at the RPC boundary.
- **Messages read state is local.** Messages exposes no read state to sync, so
  `read`/`unread` update `inbox-cache` only and never call `imsg`.
- **Media and attachment entry points are not unified yet.** WhatsApp uses
  `media()`, Gmail uses `gmailAttachment()`, and Messages uses `imsgMedia()`.
  `media: true` for Messages means the source can serve media through its own
  shipped entry point, not that the generic `media()` accepts it. Unifying these
  under `media()` is T9 in `specs/001-unified-inbox-gateway/tasks.md`.

## Tests

`tests/adapters/` has one test per account. Every dependency is a stub; no test
reaches Gmail, WhatsAgent, Messages, or LinkedIn. Each test exercises every
declared flag in the direction it is declared — a `true` reaches the stubbed
runner, a `false` refuses and leaves the runner untouched.
