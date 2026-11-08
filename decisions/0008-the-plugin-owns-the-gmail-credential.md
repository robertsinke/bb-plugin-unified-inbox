# 0008 — The plugin owns the Gmail credential; no external CLI holds it

- **Type:** architecture decision
- **Description:** Gmail credentials live in one 0600 file per account under the plugin's own data directory, written and renewed by `src/gmail-oauth.ts`, so reading, sending and recovering mail never require `gws`, its config directories or a terminal.
- **Status:** accepted
- **Date:** 2026-11-05
- **Deciders:** Robert (owner)
- **Supersedes:** nothing
- **Verified against the code:** 2026-11-05 — `src/gmail-oauth.ts` resolves the credential directory to `~/.bb/plugins/unified-inbox/gmail-credentials` (overridable with `UNIFIED_INBOX_GMAIL_CREDENTIALS`), writes one file per `GmailAccount`, and owns the access-token cache and single-flight refresh; `server.ts` builds `createGmailCredentials()` once and hands out `createGmailClient({ account, credentials })` per account; `bb unified-inbox import-gws-account` is the only remaining `gws` invocation; `src/adapters/gws.ts` no longer exists.
- **Tags:** credentials, oauth, gmail, portability, security

> **Current state (2026-11-08): a Desktop client may be supplied in settings.**
> Sign-in writes `source: 'login'`. Refresh tokens are still files and are still
> read only by `src/gmail-oauth.ts`. Consent-screen verification is still not done.
> A Testing client can still expire a refresh token after 7 days. The settings row
> shows `invalid_grant`.

## Context

Until this decision the plugin borrowed the `gws` CLI for Gmail, and the CLI held three things at once: the transport, the OAuth client, and the credential. The plugin therefore contained no auth code at all — and could not run on any machine that had not installed the CLI and signed it in.

That arrangement failed in a way that hid the failure. The personal account's refresh token was issued by a Google Cloud project whose OAuth consent screen was in *Testing*, and Google expires such refresh tokens after 7 days. The token was issued at `2026-10-28 17:16:50`, and the first read after `2026-11-04 17:16` failed with `invalid_grant`. The plugin could see none of this: it saw a process exit code, rendered as `Personal Gmail gmail gmail-personal request failed (2; expired, invalid, keyring, token)`, and served cached messages while the cause and the remedy both lived outside the plugin. Recovery required a human typing `gws auth login` in a terminal, which no part of the plugin could ask for, verify or explain.

The business account, using a different project, kept working — so the defect was not "Gmail is unreliable", it was "the credential's lifetime is decided by a project the plugin does not control and cannot inspect".

Three shapes were considered for who holds the credential.

- **Keep the CLI.** Zero work, and every failure above stays: an unseeable credential, unrecoverable without a terminal, and no other machine can install the plugin.
- **`bb.settings` secret descriptors.** They store one value per key, so two Gmail accounts cannot both be expressed, and they put a long-lived refresh token in a setting the frontend can read.
- **The plugin's database.** Refresh tokens would sit in the same file that `bb plugin logs` and storage tooling read, mixed with cache rows that are meant to be disposable.
- **One file per account under the plugin's data directory.** Per-account by construction, inspectable by its owner, disposable independently of the cache, and never exposed over RPC.

The fourth is chosen. The trade is explicit: the plugin now holds a secret at rest and is responsible for renewing it, in exchange for being able to read, send and recover on its own.

## Decision

The plugin owns Gmail credentials.

`src/gmail-oauth.ts` is the only module that knows whether a credential exists, where it is, and when it is renewed. It writes one JSON record per `GmailAccount` — client id, client secret, refresh token, cached access token with expiry, scopes, provenance, and the last refresh error — to a 0600 file under `~/.bb/plugins/unified-inbox/gmail-credentials`, atomically, and refreshes single-flight per account when the cached token nears expiry or when a request comes back 401. No other module reads the token file, and no RPC returns its contents.

Reading and sending go over HTTPS through `createGmailClient`, not through a process. A failure still reaches `src/adapters/provider-error.ts` as an HTTP status plus the provider's own reason and message, so the existing classification and redaction keep working — that is why a rejected token still reads as `(401; invalid, token)` and not as an opaque network error.

`gws` survives in exactly one place: the one-shot import command `bb unified-inbox import-gws-account <account> [--force]`, which copies an existing working credential out of a `gws` config directory so the CLI can then be removed. It never runs on a timer, never runs when a credential still works, and refuses to overwrite without the flag.

Send authorization is untouched by this. `src/adapters/policy.ts` and `src/mail-approval.ts` still decide whether a send happens; this decision only changes how its bytes leave.

## Consequences

Easier:

- A dead credential is visible and explainable from the plugin itself: present, has refresh token, last error.
- Nothing about mail requires a terminal, a CLI on `PATH`, or a Google Cloud project per machine.
- Recovery is a documented command in the plugin's own vocabulary rather than an external tool's.
- Provenance is recorded per account, so a future login flow can be distinguished from an imported credential without changing the record's shape.

Harder, and accepted:

- A refresh token now exists at rest on this machine. It is 0600, in the plugin's data directory, never logged and never sent to the panel; that is mitigation, not absence.
- The plugin is responsible for renewal. A refresh bug is now the plugin's bug, where it used to be the CLI's.
- The missing-credential message must stay actionable — it currently names a redacted path, and naming the import command instead is a follow-up on this decision.
- The other two sources still borrow their owners: WhatsApp through the WhatsAgent app, Messages through `imsg`. This decision sets the shape they will follow, and does not implement it.
- Any per-user or per-account Google project arrangement remains a non-goal: no consent-screen publishing, no verification, no vendor-held tokens.
