# 0010 — A source's transport is the plugin's own, or a tool it drives itself

- **Type:** architecture decision
- **Description:** Where the plugin can talk to a source directly it does so in its own process with its own credential; a delegate is allowed only as a stateless tool the plugin drives (the `imsg` CLI) or a browser the plugin starts and signs in (LinkedIn), never as a second long-running product with its own state.
- **Status:** accepted
- **Date:** 2026-11-05
- **Deciders:** Robert (owner)
- **Supersedes:** nothing
- **Verified against the code:** 2026-11-05 — `src/gmail-oauth.ts` and `src/gmail-client.ts` own Gmail over HTTPS with a per-account 0600 record; `src/whatsapp/{auth,connection,lock,store,transport}.ts` own WhatsApp with an in-process socket and a 0700 state directory; `src/imsg-client.ts` shells out to `imsg` for Messages; `src/linkedin-chrome.ts` starts and drives its own Chrome profile. `grep -rn whatsagent src server.ts` returns nothing, so no source reaches a separate agent process any more. `src/adapters/deps.ts` and `src/adapters/index.ts` are the only places a transport difference reaches the registry.
- **Tags:** architecture, transports, credentials, portability, dependencies

## Context

Five sources sat behind four different arrangements: Gmail through the `gws` CLI, WhatsApp through the
WhatsAgent desktop app's loopback MCP endpoint, Messages through `imsg`, LinkedIn through a Chrome the
plugin starts. Only the last two were the plugin's own doing. The first two made the plugin a client of
someone else's product — and WhatsAgent exists on one machine, so an install anywhere else shipped a
WhatsApp tab that could not work at all. That is not a configuration gap; it is a decision that had been
made by accident.

Both couplings also carried the same defect in different clothes: a second process held the credential and
the state, so the plugin could not say why a source was unavailable, could not renew a credential, and
inherited whatever the other product did with a shared connection.

## Decision

A source the plugin can reach directly gets a transport the plugin owns: its own credential, its own
connection, its own state, in its own process. That is Gmail over HTTPS with a per-account record
([0008](0008-the-plugin-owns-the-gmail-credential.md)) and WhatsApp over the pinned Baileys client with
its own paired account state ([0009](0009-the-plugin-owns-the-whatsapp-account.md)).

A delegate remains acceptable in exactly two shapes, and both are the plugin driving something rather than
a product existing beside it:

- **A stateless command** — Messages via `imsg`. Apple exposes no API, and the tool keeps no state the
  plugin depends on: the plugin passes a request and reads an answer.
- **A browser the plugin starts** — LinkedIn via its own Chrome profile, signed in once. The plugin creates
  it, drives it and closes it. No third party's process boundary enters the picture.

A second long-running product with its own state, discovery mechanism and lifecycle is not acceptable,
even when it is ours and even when it works.

The difference between transports stops at `src/adapters/deps.ts` and `src/adapters/index.ts`. Above that
line a source declares what it can do and answers the same six calls; nothing above knows which of the
three shapes it is.

## Consequences

- The plugin carries the cost it used to delegate: bundle size (Baileys is most of a 6 MB server bundle,
  loaded lazily so a start that never opens a socket does not pay for it), protocol churn (the client is
  pinned and patched at build time — see `_tools/patch-baileys.mjs`), and the credential's lifetime.
- A credential becomes a thing the user can lose. WhatsApp pairs as a linked device, so a discarded state
  directory spends a device slot and needs a fresh scan; that cost is now written where the state is
  described, because "delete it to clean up" is the natural wrong move.
- Failure is now expressible. A source that cannot connect says which layer failed — no credential, a
  refused socket, an expired token — because the plugin holds the layer.
- A source can be added without another product: the question "which program does this need" no longer
  has an answer other than the plugin itself, or a tool it drives.
- The old couplings are gone rather than supported in parallel: `src/adapters/gws.ts` and
  `src/adapters/whatsagent.ts` are deleted, and `gws` survives only inside the one-shot
  `bb unified-inbox import-gws-account` that seeds a credential the plugin then owns.
