# Safer transport for the linkedincli unread-state experiment

**Date:** 2026-10-29  
**Scope:** static research and a synthetic loopback test only. No LinkedIn session, cookie, Keychain entry, or external LinkedIn endpoint was accessed.


> **Closed by** [`decisions/0003`](../../../decisions/0003-the-session-is-minted-where-it-reads.md): no cookie store
> or session is read out of a browser, so this patched cookie transport was not taken. Kept for its finding.
## Finding

The most direct candidate is a **small, locally patched copy of linkedincli's curl-impersonate transport**, limited to the initial GET-only experiment: pass sensitive request headers to curl's `--config -` through a private stdin pipe instead of `-H` command-line arguments. This addresses the specific process-argument leak in [the reviewed implementation](https://github.com/bcharleson/linkedincli/blob/88f775ef95c5b8ad1d3b6d1056f94ef92282b8bb/src/core/transport.ts); it does **not** make the session or account risk-free. No patch has been implemented or tested with linkedincli or curl-impersonate.

The existing experimental CLI can import a Chrome cookie jar directly, but that reads local browser cookies, briefly copies the encrypted database, and may prompt for Keychain access. A patched transport would still hold cookie values in the CLI and curl process memory. Same-user inspection, crash dumps, debug output, malicious dependencies, and other local compromise remain risks. Neither a Chrome-like fingerprint nor a GET request guarantees that LinkedIn will preserve unread state or the login session.

## Evidence

- Upstream passes every non-skipped header using `args.push('-H', ...)` and launches the child with `spawn(...)`; its request headers include cookie and CSRF values. These values can therefore appear in the subprocess command line.
- Curl supports reading configuration from standard input using `--config -` ([curl manual](https://curl.se/docs/manpage.html#-K)). A local synthetic test used system curl 8.7.1, an ephemeral loopback HTTP server, and a dummy header. The server received the correct header; curl exited successfully; a `ps` snapshot of the curl child did not contain the dummy value. This proves the basic stdin mechanism only, **not** compatibility with the separately packaged `curl_chrome123` wrapper, TLS fingerprint fidelity, or LinkedIn behavior.
- `curl_chrome123` is not installed on this machine. Installation, supply-chain review, version pinning, and verification of its actual executable/wrapper behavior are prerequisites; do not silently fall back to Node `fetch`.

## Implementation and validation constraints if authorized

1. Use a pinned, reviewed copy of linkedincli and a pinned curl-impersonate binary; preserve the upstream transport's required HTTP behavior and normal certificate verification. Disable reading default curl config. Never include secrets in argv, environment, temporary config files, logs, errors, debug output, or test artifacts. Quote and validate curl-config input safely, rejecting newline/control-character injection.
2. For the **GET-only spike**, send curl config over stdin; reject non-GET methods and bodies rather than conflating config input with upstream's body-on-stdin mechanism. A future general transport supporting replies needs a separate design for body delivery and must not inherit a GET-only assumption.
3. Test with synthetic secrets and loopback HTTP only: correct headers, no secret in child argv or environment, rejected unsafe header characters, redirects not followed, timeout/abort cleanup, and error output sanitization. Inspect the actual curl-impersonate wrapper and child process tree—not just the parent command line. Do not use real credentials in tests.
4. For the live experiment, require explicit owner approval for Chrome-profile/Keychain access and LinkedIn API calls, then follow [the controlled protocol](./linkedincli-unread-test.md). Stop on challenges, rate limits, unexpected behavior, or any session problem. Do not send messages, invoke `login`, or mark threads read as part of the experiment.

An alternative is to issue requests inside an already authenticated browser context rather than exporting its cookies into a CLI and subprocess. That could avoid the CLI cookie-import path, but it requires browser-side implementation and investigation of session ownership, CSRF handling, cross-origin protections, and unintended page/read-state effects; none has been tested here. Neither candidate is proven safer for LinkedIn account restriction risk.

## Verdict

**Promising mitigation, not ready for account access.** The synthetic test validates only the standard curl stdin-config mechanism. A patched, pinned curl-impersonate path plus synthetic tests is the next technical step; the user must approve account access before any live test. Unread preservation remains unverified.
