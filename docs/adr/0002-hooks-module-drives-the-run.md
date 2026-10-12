# The ship-flow hooks module drives a run, not the model

After the checkpoint, `ship-flow` walks the ticket graph from its hooks module: it reads the ticket files, spawns one
subagent per frontier ticket, and writes each ticket's status when the subagent returns. The obvious design is an
orchestrator skill that the model follows in the main session, as `implement-spec` does. We rejected it because the
main window then grows with every ticket and the loop is lost on a compaction or a restart, which defeats the
context budget the mod exists to keep. With the module driving, the main conversation receives one notice per
ticket, the state is the ticket files, and the quota rule (pause above a threshold, resume by timer after the reset)
is enforced by code that reads `$.session.usage()` rather than by an instruction the model may forget.

## Consequences

- The loop's logic is TypeScript under test, not prose in a skill, so changing the flow means changing code.
- The model cannot improvise mid-run: a ticket that fails twice is marked `blocked` and the run goes on without it.
- Tickets ran one at a time on the feature branch; running them in parallel needed worktrees and a merge step, which
  [0004](0004-tickets-are-built-in-worktrees-side-by-side.md) adds.
