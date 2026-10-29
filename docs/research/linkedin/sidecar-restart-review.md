# Sidecar restart without session copying: offline review

**Date:** 2026-10-29  
**Scope:** inspection of installed `mcp-server-linkedin` 4.28.0 source and documented CLI only. No sidecar was started, no browser or session data opened, and no LinkedIn request made.

## Finding: no verified stock restart meets all constraints

The installed sidecar's existing-profile browser path uses its persistent profile, but it is not a no-session-access/no-export path. In `drivers/browser.py`, `_authenticate_existing_profile` starts the browser, calls `_restore_portable_session_if_the_store_lost_it`, then calls `_feed_auth_succeeds` (a LinkedIn feed navigation). The restore function reads browser-context cookies and can import the sidecar's portable cookie file into the profile. Browser shutdown in the same module can export cookies to a portable file. These are upstream session-lifecycle operations even if our diagnostic never asks to see a cookie value.

The direct server's `browser_lifespan` starts setup and an idle/handoff watcher; the browser starts lazily when a browser-backed tool is invoked. A bare HTTP server restart is therefore not a restart of an authenticated browser, nor does it expose a passive DOM-inspection tool. The standard `get_inbox` tool additionally navigates and clicks threads, contrary to the approved bounded diagnostic. The normal MCP server registers sending tools; simply starting it does not enforce a sending-disabled interface.

## Exact stock server-only command (not executed)

```sh
uvx mcp-server-linkedin==4.28.0 --no-auto-import --transport streamable-http --host 127.0.0.1 --port 8000 --path /mcp
```

`--no-auto-import` prevents automatic import from a signed-in local browser; it does **not** disable the sidecar's own portable-session restore/export or its feed-validation navigation when a browser-backed tool starts. Starting the server may run background browser setup; it is not a proof that an authenticated browser exists. Loopback alone is not a guarantee of authorization: other local clients can reach the server, which exposes tools including send. Do not start it for this diagnostic while the requirement is to keep sending disabled.

## What a compliant live diagnostic would require

A reviewed, explicitly scoped local mechanism that owns the existing profile lease, opens the persistent browser without the sidecar's cookie inspection/import/export and automatic feed navigation, blocks sending and other mutating tool access, and gives controlled access to the page for the single approved navigation. It must honor the sidecar's browser-version checks, profile locking, cleanup and failure handling; directly launching Patchright on the profile while bypassing those protections is not a safe substitute. Chromium itself necessarily reads and writes its profile to maintain an authenticated session; avoiding explicit cookie extraction/copying is different from preventing the browser from using its own session data.

No supported stock CLI mode was found in the inspected paths that guarantees those properties. Whether a small safe diagnostic can reuse the sidecar's lifecycle while suppressing the unwanted operations remains unverified. No exact live restart steps are asserted as safe until that mechanism is established and reviewed. Separately, navigating Messaging can itself mark a conversation read, and LinkedIn can challenge or restrict an automated session.

The prior [bounded diagnostic](./browser-session-diagnostic.md) remains blocked. Further approval is required before starting a browser or navigating; stop on any authentication error or challenge and do not send messages.
