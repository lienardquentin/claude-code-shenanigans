# Tickets are built in worktrees, side by side

`ship-flow` builds each ticket in a git worktree of its own (`.scratch/<feature>/trees/<NN>`, on a branch
`<run's branch>--<NN>` cut from the run's branch as it is when the ticket starts), and builds up to three tickets at
once. Built one at a time in the repo's own working tree, a run was as slow as the sum of its tickets, and a failed
attempt was discarded with `git reset --hard` and `git clean` in the checkout the person works in.

Which tickets go together is decided from what they declare, not found out by merging: a ticket is started beside
those being built only when its blockers are done and its `**Touches:**` paths are neither theirs nor under them. A
ticket that declares nothing may touch anything, so it is built alone. We rejected starting the whole frontier and
letting git sort it out: every conflict costs a full implementer attempt, and the estimate is already written at the
checkpoint for the blast radius.

A ticket's work lands by fast-forward only. The run verifies it in the worktree and commits it there; if the run's
branch has moved meanwhile, the commit is rebased onto it and verified again, and only then put on the branch. So
every commit on the run's branch has passed the verification commands as it stands there, which a merge commit made
after separate verifications would not guarantee.

What becomes of an attempt that does not land depends on what was wrong with it:

- Work that does not pass verification stays in its worktree, and the ticket's one retry is a fresh implementer told
  to put it right. Rebuilding from nothing cost a whole attempt to fix what was often one failing test.
- Work that passed and could not land (a rebase that conflicts, a branch that kept moving, a fast-forward git
  refused) is discarded and the ticket built anew on the branch as it now is, without being charged an attempt, twice
  at most. The fault there is the `**Touches:**` estimate that let two tickets go side by side, not the implementer.
- Anything else (a turn cut short, nothing changed) is discarded and charged, as before.

The end of a run works the same way. The branch is reviewed, fixed and, later, followed up in one more worktree
(`trees/finish`, on `<run's branch>--finish`), and a pass's commit lands on the run's branch by fast-forward as a
ticket's does. Nothing of a run is built, reset or cleaned in the repo's own working tree.

## Consequences

- A fresh worktree holds only what git tracks. A spec whose verification needs more (installed dependencies) names
  the commands that put it there under `## Setup`, and the run executes them in each worktree. Worktrees are made one
  after the other, which is how git makes them; their setups run side by side.
- The record holds a list of flights, one a ticket being built, where it held one ticket and one agent. Several
  tickets end when they end, so every step that reads and writes the record is taken alone, one after the other,
  and nothing that takes minutes (verification, setup) happens inside a step while tickets are being built.
- An agent that writes may write only under its worktree, and a ticket's implementer to its own ticket file too; the
  `tool.check` hook refuses the rest. Reading is not narrowed.
- A run starts and goes on whatever the person has uncommitted in the repo's own working tree, and whatever branch
  they are on. The one thing their tree can still do to a run is refuse a fast-forward of the run's branch while it
  is checked out with changes to the same files: that landing fails, and is tried again as any landing is.
- One run at a time still: the attended phase writes the glossary and the ADRs in the repo's own working tree.
- The spawn's `cwd`, by which an agent is put in its worktree, is declared by the engine and seen in
  `claude plugin test`; it has not been seen in a live run yet.
