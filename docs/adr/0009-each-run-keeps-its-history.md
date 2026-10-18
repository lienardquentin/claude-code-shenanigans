# Each run keeps its history

A run moves through a fixed course (`core/phases.ts`), and the build kept only where it stood: its phase, the task
out, the last proof and verdict. Why it stood there, and what moved it, was lost. Work is set off from five places (a
command, a tool Claude calls, the clock, an agent's turn ending, a press on a pane), because the engine holds an agent
only when it is sent from a hook; so "what is it doing, and why" had no answer short of reading the code.

So every change the build keeps of a run is told as events, appended to the run's log in `.theseus/runs/<run>.jsonl`:
what happened, when, and its cause. The events are worked out from the run as it was and as it is kept
(`eventsOf` in `core/events.ts`), in the one function every change passes through (`keep` in
`hooks/build/register.tsx`), so no part writes the log itself and none can forget to.

The cause travels with each ask: a command or a press asks for work that a hook does later, and several runs' asks
are done side by side, so the cause is kept per ask and per run, not as one value for the session.

## Consequences

- `/theseus`, `/theseus log` and the build pane read a run from its log. The run views to come (#160, #161) read the
  same log.
- The log is a file of the project, ignored with the rest of `.theseus/`. It grows with the run and is read whole; a
  run's log is a few hundred lines.
- `$.fs` has no append: a log is read and written again, one write at a time.
