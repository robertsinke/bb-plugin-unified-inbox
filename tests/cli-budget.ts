// A subprocess a test spawns gets a named budget, never a magic number and never none.
//
// Two failure modes this rules out. A short fixed budget turns a busy machine into a failure that
// reads exactly like the defect under test — that is how `check-send-audit` reported a loaded box as
// "audit NOT CHECKED". No budget at all turns a wedged tool into a suite that never finishes, which
// is worse than a failure because it reports nothing.
//
// 30 s is the figure `src/adapters/gws.ts` already allows a real CLI, and `_tools/check-send-audit.ts`
// now allows `bb status`. The override exists so a timeout can be tested deliberately rather than
// waited for.
export const CLI_BUDGET_MS = Number(process.env.UNIFIED_INBOX_TEST_CLI_TIMEOUT_MS ?? 30_000);
