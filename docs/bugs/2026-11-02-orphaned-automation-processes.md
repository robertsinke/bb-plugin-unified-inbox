# Bug report — automation browsers and MCP children outlive their owner

**Filed:** 2026-11-02 · **Owner:** BB / agent tooling (not this plugin) · **Status:** evidence + proposed fix, no workaround added here

## Symptom

The machine ran at **load average 200** with 230 `node` processes, 84 Chrome processes, 47
`executor` MCP processes and 57 pnpm/exec processes. A child agent thread could not run `npm` or
`tsc` and died twice for that reason before any code was written. One interactive action (archiving
four error threads) dropped load 200 → 78; killing four orphaned Playwright shells dropped it to
6.4.

## What was measured

| measurement | value |
|---|---|
| `agent-browser-chrome-*` temp profiles on disk | 4 |
| processes inside those 4 instances | 36 (8–11 each) |
| oldest instance | 25 days (`etime` 25-10:39) |
| next three | 20 d, 20 d, 17 d |
| `~/.agent-browser/browsers/chrome-*` processes with a live parent | some; others reparented to PID 1 |
| Playwright `chrome-headless-shell` processes | 4, ages 5 d+, **92% CPU between them** |
| `executor mcp` processes | 47 |
| `executor` parents | `cursor-agent` (`.local/bin/cursor-agent`), other `executor` processes, and 18-day-old `node` hosts; several reparented to launchd |

## The controlled experiment (proves `close` works, and only `close`)

```
before:            chrome-headless-shell 0, agent-browser Chrome instances N
bb browser-automation open --backend local --headless   → processes appear under
                                                          ~/.agent-browser/browsers/chrome-151.0.7922.47/
bb browser-automation close <session>                   → those processes exit
```

So disposal on explicit `close` is correct. What is missing is disposal **without** it.

## Attribution — what is proven, what is likely

- **Proven:** BB's browser automation launches `~/.agent-browser/browsers/chrome-*` (not
  `~/.cache/puppeteer` and not `ms-playwright`), and a session opened and closed in this session
  left no process behind.
- **Proven:** the 4 leaked `agent-browser` instances carry UUID temp profiles that no live session
  references, and one more leaked browser is `user-data-dir=…/T/opencode/mail-browser`, which is
  not BB at all.
- **Likely, not proven:** the 4 Playwright `chrome-headless-shell` processes were an
  `rea-agents` MCP (a `npm exec rea-agents@6.7.0 mcp` process was running at 24.7% CPU at the
  time). They were killed before their ownership could be traced; that is a recorded gap, not a
  conclusion.

Conclusion: at least two different launchers leak the same way — the pattern, not one product, is
the bug.

## Why it leaks (mechanism)

1. A browser session exists so long as its control channel does. When the owning agent exits,
   crashes, or its thread is archived, nobody calls `close`; the Chrome it launched keeps running
   with a temp profile that is never removed. Session metadata expiry (`expiresAt`, 30 min) is
   bookkeeping only — it does not terminate the process.
2. MCP children are spawned per agent start and are never reaped when the owning session ends. The
   parent exits, the child reparents to launchd and stays forever.

## Proposed fix

Belongs in BB (browser-automation plugin host) and in the agent/MCP supervisor, not in this repo.

1. **Dispose on expiry, not only on close.** When the session sweeper observes `expiresAt` in the
   past, terminate the Chrome process tree it launched and delete its temp profile. Keep the
   session row (marked closed) so `list` still explains what happened.
2. **Reap on startup.** At host boot, terminate any `agent-browser-chrome-*` instance whose profile
   UUID is not in the live session table, and delete orphaned profile directories. This is the only
   fix that recovers from a crash of the daemon itself.
3. **Own the process group.** Launch each session's Chrome as a process-group leader and kill the
   group, so renderer children cannot survive the parent.
4. **MCP children follow their owner.** Have the supervisor terminate MCP children when the agent
   process that spawned them exits (`--parent-death`-style: kill on parent exit, and a boot sweep
   for the ones already reparented to launchd).
5. **Make it observable.** A `bb browser-automation list --orphans` (or the same flag on
   `bb sessions`) that reports sessions whose process tree is gone and processes whose session is
   gone would have made this visible in one command instead of a `ps` archaeology session.

## What was done on this machine, and what was deliberately not

- Killed 4 orphaned Playwright `chrome-headless-shell` processes (92% CPU). Load 200 → 6.4.
- Archived four `error`-state threads and deleted their environments; that released their processes.
- **Not touched:** the 4 `agent-browser` instances and the 47 `executor` MCP processes. Two of the
  browser instances could belong to live agent work, and the `executor` processes were explicitly
  left alone by the owner. They are listed above so they can be reaped deliberately, not blindly.

## Reproduce

```sh
ps -Ao pid,etime,args | grep agent-browser/browsers | grep -o 'user-data-dir=[^ ]*' | sort | uniq -c
ls -ldt ${TMPDIR}/agent-browser-chrome-*            # profiles with no live session
bb browser-automation list --json | jq '.sessions[] | select(.state=="closed")' | wc -l
ps -Ao pid,ppid,etime,args | grep '[e]xecutor mcp' | awk '{print $2}' | sort | uniq -c
```
