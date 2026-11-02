# 0003 — The LinkedIn session is minted in the browser that reads it

- Status: accepted
- Date: 2026-11-03 (finding measured 2026-10-31)
- Evidence: `docs/research/linkedin/obscura-as-linkedin-browser.md` and its three probe logs.

## Context

LinkedIn has no API for reading DMs, InMail and invitations, so the inbox reads them from a page. That
requires an authenticated session, and the session is the scarce thing: LinkedIn revokes it when it
dislikes how the account is being used, and a plugin that refreshes every few minutes spends it often.

Three ways to keep a session were on the table: keep the cookies and hand them to a faster client; run
a headless engine (obscura.sh, Rust, headless-only, no sign-in window) that reads the authenticated
pages; or drive one browser that signs itself in and stays warm. The first two were measured on a
burner account, and the measurement is the point of this note.

## Decision

The session is minted inside the browser that reads it, and never exported. Concretely
(`src/linkedin-chrome.ts`): a dedicated Chrome for Testing profile signs in once, `--remote-debugging-port`
is driven over CDP for every read, the profile is never copied, and no cookie store is read or written
by the plugin. A warm page is reused while the plugin runs; when the profile locks, the plugin waits
rather than opening a second browser.

Obscura is rejected: **no-go**, not "not yet benchmarked".

## What the probe showed

Round 3 is single-variable — sign-in, one Chrome read, then obscura as the only outside client:

- obscura's read succeeded (11.8 s, correct data) and within 90 s `li_at` was **gone from the account's
  own profile**, with LinkedIn returning the login page.
- So the handoff works exactly once and costs the account its session. For a reader that ticks every
  few minutes, that is one read per sign-in.
- The transport case for obscura was real and is worth recording: 753 ms versus 8.9 s cold, 0.9–1.4 GB
  versus 22–40 MB resident. It lost on session survival, not on speed.
- Cleanup: cookie files, throwaway profiles and obscura storage dirs were deleted; no processes left.

What would reopen this: a session minted *inside* obscura via its own browser-automation login,
surviving repeated reads. That arm could not be measured — obscura's login hit Cloudflare's block page
on this IP, and Chrome was blocked in the same minute, which points at the address rather than
obscura's fingerprint. Obscura's latest release (v0.2.6, the same day) adds request interception and
CDP responsiveness; it still ships no headful mode and no sign-in window.

## Consequences

- Reads pay Chrome's cost. That is the price of not spending the session, and it is not negotiable
  against a 10× speedup that logs the account out.
- Anything that needs the session — a new read path, a retry after a long sleep, a second LinkedIn
  feature — runs in that same browser. A helper process that "just reads one page" is a session risk,
  not a convenience.
- Re-proposals should answer one question first: does it sign in where it reads? If not, the probe
  above is the answer, and no new benchmark changes it.
- This note is about authentication, not authorisation: whether to read LinkedIn at all is the owner's
  decision, recorded in `docs/research/linkedin/linkedin-inbox-options.md`.
