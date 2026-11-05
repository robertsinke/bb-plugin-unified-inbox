---
title: "Bug report — the plugin's browser outlives the plugin and keeps the LinkedIn profile"
status: fixed
date: 2026-11-05
---

# Bug report — the plugin's browser outlives the plugin and keeps the LinkedIn profile

**Filed:** 2026-11-05 · **Owner:** this plugin · **Status:** reproduced on the live plugin, recovery added, tests pin it

## Symptom

After a plugin reload, every LinkedIn call failed and the row said only:

```
LinkedIn unavailable. Check its connection.
```

Re-checking the connection — the one act the sentence named — could not help, because the cause was
on this machine, not on LinkedIn.

## What was measured

Reproduced on the live plugin (2026-11-05). A headless Chrome for Testing, launched at 14:54 and
reparented to `launchd`, was still running with:

```
--user-data-dir=/Users/robert/.bb/plugins/unified-inbox/linkedin-profile
--remote-debugging-port=0
```

`kill <pid>` of that browser fixed it instantly: `sync` returned real conversations, with no other
change. So the plugin's browser outlives the plugin that started it, and the next instance cannot
take the profile: Chrome's own `ProcessSingleton` refuses the second launch.

The message was the second half of the defect. `chromeStartupError` classifies that abort as the
sign-in window (`Close the LinkedIn sign-in window before refreshing the inbox.`), the sentence is
not one the gateway passes through (`DESCRIBED_FAILURE`), so the owner got the generic line and the
classification was dropped. `src/gateway.ts` now writes it to the log as `note` — no amount of
re-checking a connection says "a browser of mine is holding the profile".

## Two answers, and the one taken

| answer | what it costs | why not / why |
|---|---|---|
| **adopt** the browser through the `DevToolsActivePort` it wrote into the profile | nothing dies; the page keeps the state it has | **taken.** The endpoint is already on disk, and attaching is one socket to a browser that is exactly the one the plugin wanted |
| find the process holding the profile and stop it | a window the owner may be looking at dies | refused: it cannot be done without a process hunt that classifies by command line, and the sign-in window carries the same profile directory |

Adoption is also the answer that keeps the invariant "one browser, one socket": the profile is only
ever held by one browser, and after adoption it is *this* instance's browser, closed through the
protocol (`Browser.close`) when it idle-stops instead of killed by signal.

## Telling an orphan from the owner's sign-in window

Only one of the two wrote an endpoint, and only one of the two calls itself headless:

| case | `DevToolsActivePort` in the profile | `Browser.getVersion` product | outcome |
|---|---|---|---|
| the plugin's browser, left by a previous instance | present, and the port answers | `HeadlessChrome/...` | adopted |
| the owner's sign-in window (`openLinkedInSignIn`, no `--remote-debugging-port`) | absent | — | not adopted; the launch aborts, and is still reported as the sign-in window |
| a window somebody opened on the profile themselves | present only if it was started with remote debugging | `Chrome/...` | not adopted, and **not closed** — the probe asks one question and leaves |
| an endpoint whose browser already exited | present but stale | nothing answers | not adopted; the launch proceeds and succeeds |

A failure to adopt is never a failure to read: every branch falls through to the launch that was
there before, with its abort classification unchanged.

## What was changed

| change | file |
|---|---|
| `runningBrowserUrl` reads the endpoint the browser wrote into the profile | `src/linkedin-chrome.ts` |
| `isPluginBrowser` accepts only a browser that calls itself `HeadlessChrome` | `src/linkedin-chrome.ts` |
| `adoptRunningBrowser` attaches (5 s bound), and closes it through `Browser.close` rather than a signal | `src/linkedin-chrome.ts` |
| `warmPage` adopts before it launches | `src/linkedin-chrome.ts` |

## Tests

`tests/linkedin-chrome.test.ts`, all with a fake transport and a temp profile — no Chrome is started
and no process is touched:

- the endpoint parses to a ws url; a directory without one (what the sign-in window leaves) and a
  half-written file both read as none;
- a headless browser is adopted, and its `stop()` sends `Browser.close`;
- a browser that does not call itself headless is not adopted and receives no `Browser.close`;
- an endpoint with nothing behind it reads as no browser, so the launch path still runs.

## What this does not fix

- **The browser still outlives the plugin.** A second orphan after a second reload is adopted the
  same way, so the owner sees nothing; but nothing in the plugin can exit a browser whose parent
  process is gone. Making the browser die with its owner is upstream (BB), per `AGENTS.md` rule 6 —
  see `docs/bugs/2026-11-02-orphaned-automation-processes.md`.
- **Two live instances on one profile.** If the previous instance were still running rather than
  dead, the newer one would adopt the older one's browser and both would drive the same page. A
  reload leaves the previous instance dead, which is the reproduced case; a concurrent second
  instance is not something this code can distinguish.
- **The live proof is the parent's.** Adoption was proven against fakes here; whether the live
  profile's orphan answers and adopts needs the plugin rebuilt and reloaded in its own worktree.
