# LinkedIn authenticated-browser diagnostic: offline review

**Date:** 2026-10-29  
**Status:** the original sidecar diagnostic below was not run. A separately approved BB browser list check was performed; see results below. Sending remains disabled.

## Findings

The existing LinkedIn MCP sidecar owns a separately authenticated browser profile; it is not the same thing as attaching to the user's signed-in Chrome profile. The earlier spike established that its browser can render real DM and InMail content, but one `get_inbox` call was followed by an owner-marked unread conversation becoming read ([spike](./spike-sidecar.md)).

Inspection of the installed sidecar 4.28.0 shows that `get_inbox` first navigates to LinkedIn Messaging and extracts page text, then navigates to the compose page and clicks conversation rows to derive thread URLs. It warns that such clicks may mark rows read. Thus it cannot isolate whether **opening Messaging**, the automatic active conversation, or the subsequent click scan caused the observed change. Its sidebar text alone may offer a way to observe summaries without exporting cookies, but the code notes that conversation rows have no thread anchors or thread-id attributes. A summary is not enough to establish stable thread IDs or full-message support.

A request executed inside an authenticated page could in principle let the browser attach its session automatically instead of exporting cookies. However, the inspected [linkedincli implementation](https://github.com/bcharleson/linkedincli/blob/88f775ef95c5b8ad1d3b6d1056f94ef92282b8bb/src/core/client.ts) explicitly derives a CSRF header from a session cookie. We have not established whether an in-page API call can succeed without accessing that cookie, whether it would change read state, or whether the API endpoint remains usable. No in-page fetch is proposed for the first diagnostic.

## BB browser list check — observed

After explicit approval, a new tab in the existing signed-in BB browser navigated once to LinkedIn Messaging. A browser snapshot showed inbox rows with names, previews, dates, an InMail label, and at least one unread indicator. No thread was clicked; no cookies were extracted, MCP server started, or message sent. The browser session was closed afterward.

LinkedIn identified one conversation as active without an explicit click. No controlled unread-state baseline was established before navigation, so preservation and the effect of automatic selection remain unproven. The snapshot returned more page content than the intended list-only summary, including private message previews; no message content is copied into this document. Future checks should scope extraction to the list and return only the agreed fields.

A second controlled check followed: the user marked a conversation unread, then a new BB browser tab navigated once to Messaging and inspected a snapshot without clicking threads. The list and an unread indicator were visible, and LinkedIn again automatically selected an active conversation. Afterward, the user confirmed their selected conversation was still unread. The snapshot was processed to return only boolean observations, not message content; the session was closed. No cookies were extracted and no message was sent.

This supports unread preservation for that one passive-list observation, not for other conversations, automatic selection, or future runs. It establishes that the BB browser can display a list in its current signed-in session, not that a complete or unattended inbox source exists. Stable identifiers, full-message access, invitation coverage, and generally unread-safe operation remain unverified.

## Original sidecar diagnostic — not run

1. Use **one already authenticated sidecar browser session** only if its owner and lifecycle are clear; do not attach to another browser profile, copy/export cookies, start a second profile owner, or use linkedincli. Have the owner mark a known conversation unread and confirm the marker immediately before the test. Stop any independent polling and avoid other LinkedIn activity during the observation.
2. With consent, navigate the sidecar browser **once** to the ordinary LinkedIn messaging page, without invoking `get_inbox`, its click scan, `get_conversation`, search, or any send/connection tool. Page navigation itself can issue multiple background network requests and can automatically open a conversation; it is not a guarantee of zero side effects or a single HTTP request. Do not use `fetch`, inspect network headers, read cookies, or click any thread.
3. Inspect only the rendered inbox list using DOM text/attributes, without clicking, scrolling into new content, or capturing screenshots/raw messages. Record only whether the page loaded, whether list rows and an unread marker are observable, and whether the DOM offers a stable thread reference; do not persist names, content, session values, or raw page text. Stop immediately on login, checkpoint, auth error, challenge, unexpected navigation, or rate limit; no automatic retry.
4. Ask the owner to verify whether the selected conversation remains unread without opening it. If it changed, record that navigation alone was followed by the change; do not claim causality if other activity cannot be excluded. If it remains unread, this supports only the specific passive listing case; it does not prove thread opening, full-message retrieval, future unattended operation, or other conversations preserve read state.
5. Separately decide whether another experiment is justified before navigating to a conversation or making any API request. A later in-browser API probe needs a new explicit approval and a method that does not access or expose cookies; absent such a method, do not attempt it. Sending remains disabled throughout.

This diagnostic tests whether a **passive list view** is possible, not whether a complete inbox connector exists. Unread and invite coverage, stable IDs, thread messages, future action paths, and account risk remain unresolved.
