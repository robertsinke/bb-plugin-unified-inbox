---
status: current
date: 2026-11-10
description: "Commands for an existing gws login, the credential files, the send log, and a cache clear."
---

# Operator commands

A person who installs the plugin follows [README.md](../README.md). This file is the command list. How a module behaves is in [src/CONTEXT.md](../src/CONTEXT.md). This file does not restate that.

## Gmail contact scopes

A sign-in asks for this scope list:

- `openid`
- `https://www.googleapis.com/auth/userinfo.email`
- `https://www.googleapis.com/auth/userinfo.profile`
- `https://www.googleapis.com/auth/gmail.modify`
- `https://www.googleapis.com/auth/gmail.send`
- `https://www.googleapis.com/auth/contacts.readonly`
- `https://www.googleapis.com/auth/contacts.other.readonly`

`gws auth login --scopes` replaces the requested set. Name the whole list. If you drop one scope, that account stops reading and sending mail.

Enable the People API in the Google Cloud project. Add both contact scopes on the OAuth consent screen.

`_tools/gmail-faces-personal.sh` and `_tools/gmail-faces-business.sh` walk one account each and check the grant. `_tools/gmail-project-move.sh` moves the personal client to its own project. Each script reads the project id from that account's client secret file.

The settings page is the normal door. The commands below copy an existing `gws` config. They name the two accounts on this machine.

```sh
GOOGLE_WORKSPACE_CLI_CONFIG_DIR=~/.config/gws gws auth login --scopes openid,https://www.googleapis.com/auth/userinfo.email,https://www.googleapis.com/auth/userinfo.profile,https://www.googleapis.com/auth/gmail.modify,https://www.googleapis.com/auth/gmail.send,https://www.googleapis.com/auth/contacts.readonly,https://www.googleapis.com/auth/contacts.other.readonly
bb unified-inbox import-gws-account gmail-personal --force

GOOGLE_WORKSPACE_CLI_CONFIG_DIR=~/.config/gws-inhouse gws auth login --scopes openid,https://www.googleapis.com/auth/userinfo.email,https://www.googleapis.com/auth/userinfo.profile,https://www.googleapis.com/auth/gmail.modify,https://www.googleapis.com/auth/gmail.send,https://www.googleapis.com/auth/contacts.readonly,https://www.googleapis.com/auth/contacts.other.readonly
bb unified-inbox import-gws-account gmail-business --force
```

The browser opens on Google's consent screen. The screen names contacts and Gmail. After you grant access, the import copies the new refresh token over the old one. `--force` is required to replace a live record. Photos appear on the next refresh. You do not reload the plugin. `bb unified-inbox import-gws-account` without `--force` refuses and names the account that already has a record.

The account id is the mailbox address after a profile read publishes the email-named credential file. Until that file exists, `gmail-personal` and `gmail-business` still serve. Refresh tokens stay in per-mailbox files under `~/.bb/plugins/unified-inbox/gmail-credentials`. `src/gmail-oauth.ts` owns those files.

A missing contact grant leaves rows on initials. One log line names the missing scope. The cost of those scopes is in [what each source costs](research/2026-11-05-gmail-faces-what-each-source-costs.md).

## WhatsApp login files

The linked account state lives in `~/.bb/plugins/unified-inbox/whatsapp-auth`. Deleting that directory discards the device WhatsApp remembers. The account then needs a fresh scan, and that scan spends one linked-device slot. `src/whatsapp/auth.ts` owns that directory.

Pair from the settings page. `bb unified-inbox whatsapp-link [phone-number]` is the command form of that pairing.

## LinkedIn

`bb unified-inbox linkedin-signin` opens the same Chrome window as the settings button. `UNIFIED_INBOX_CHROME` sets the Chrome binary. `UNIFIED_INBOX_LINKEDIN_PROFILE` moves the profile directory. `src/linkedin-chrome.ts` owns that session.

Two other LinkedIn paths were tried and rejected. The evidence is in [spike-sidecar.md](research/linkedin/spike-sidecar.md) and [linkedin-inbox-options.md](research/linkedin/linkedin-inbox-options.md).

## Send log and cache clear

`bb unified-inbox send-audit [limit]` prints what the send gate allowed or refused. The same rows open from the inbox menu's Send log. The gate is `src/adapters/policy.ts`. Mail approval settings are in [mail-approval.md](mail-approval.md). [Decision 0005](../decisions/0005-keep-sends-enabled-until-verified-approval.md) records why sends stay enabled.

`bb plugin rpc call unified-inbox clear_cache` clears the plugin cache. It does not clear Gmail, and it does not remove the WhatsApp account state. What the clear includes is the `src/inbox-cache.ts` row in [src/CONTEXT.md](../src/CONTEXT.md).
