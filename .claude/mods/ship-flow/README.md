# ship-flow

A Claude Code mod that takes one feature from an idea or a GitHub issue to a pull request. You are with it up to one
checkpoint; from there it builds unattended, in git worktrees, and never in your own working tree.

It automates the flow of the `mattpocock-skills` plugin (grill, spec,
tickets, implement, review), with the spec and the tickets kept as local files and the loop driven by the mod's
hooks module instead of by the model.

## Install

It needs `git`, `gh` signed in to the repo's GitHub, and the `mattpocock-skills` plugin for the grilling.

```
claude plugin marketplace add <path to this clone>/.claude/mods/ship-flow
claude plugin install ship-flow@ship-flow-mods
```

## Commands

| Command | What it does |
| --- | --- |
| `/ship <idea>` | Starts a run from an idea, typed as a sentence. |
| `/ship #<issue>` | Starts a run from a GitHub issue. One labelled `ready-for-agent` skips the grilling. |
| `/ship resume [feature]` | Approves the checkpoint; takes up a run that was paused, stopped or cut off; on a run whose pull request is open, follows up its failing checks and new comments. |
| `/ship stop [feature]` | Stops a run that is building, reviewing or waiting on the quota. |
| `/ship clean <feature>` | Removes a run's folder, its worktrees and their branches. The run's branch and its pull request are left. |
| `/ship status` | How every run of the repo stands, ticket by ticket. |
| `/ship pane` | The same, live, in a pane, with buttons to approve, resume, follow up and stop. |
| `/ship help` | The list above. |

One bare word that is none of these starts no run: an idea is a sentence.

## A run, step by step

### With you: up to the checkpoint

1. **Grilling.** You are grilled about the feature (`grilling` and `domain-modeling`), which may change
   `CONTEXT.md` and add ADRs.
2. **Spec.** `.scratch/<feature>/spec.md` is written: the decisions, the seams to test at, and the commands the run
   executes itself under `## Verification` (and `## Setup`, when a fresh worktree needs dependencies installed).
3. **Tickets.** `.scratch/<feature>/issues/<NN>-<slug>.md`, one vertical slice each, with what blocks it, the files
   it expects to change (`**Touches:**`), and what it does that reaches outside the working tree
   (`**Outward actions:**`).
4. **Checkpoint.** You are shown the spec, the tickets, and under them:
   - the **blast radius**, an estimate: the files the tickets touch, the files that depend on those, the tests
     among them, and every outward action;
   - the **schedule**, an estimate too: the waves the tickets would be built in and the longest chain of tickets
     waiting on one another, so you can see whether the `Touches:` lines buy any parallelism.

   The mod also reads the tickets as the turn ends and hands the model what is worth putting right: a broken graph,
   a ticket with no `Touches:` (built alone), only folders in `Touches:`, no `Outward actions:`, no criterion.

Nothing is published before you approve. Change the files by hand or by asking, then type `/ship resume`.

### Without you: building

Approval opens the run's one GitHub issue from the spec (when the run started from an idea), makes the branch
`ship/<feature>`, commits what the grilling changed, and starts the walk of the ticket graph.

- Each ticket is built by a fresh subagent in its own worktree, `.scratch/<feature>/trees/<NN>`. Tickets whose
  blockers are done and whose `Touches:` do not overlap are built side by side.
- When its implementer ends, **the run** executes the verification commands in that worktree, commits, and puts the
  commit on the run's branch by fast-forward. If the branch moved meanwhile, the commit is rebased and verified
  again first.
- A ticket has two attempts:
  - work that **does not pass** stays in its worktree, and the second implementer is told to put it right;
  - work that passed and **could not land** (a conflict with a ticket built beside it) is built anew on the branch as
    it now is, at no cost to its attempts, twice at most;
  - anything else is discarded and tried once more.

  After that the ticket is `blocked`, with the tickets that hang off it, and the run goes on with the rest.
- An implementer that fills too much of its context is stopped and its ticket marked `too-large`: split it.

### Without you: finishing

When no ticket is left to take, the branch is reviewed once by a fresh agent on the strong model, in a worktree of
its own (`trees/finish`); one fix pass acts on the findings and is verified and committed like a ticket. The branch
is pushed and a pull request opened, a draft when any ticket is unfinished. Its body says, for each ticket, its
commit, how long it took, the files it changed outside its `Touches:` and the criteria its implementer left
unticked; then what could not be built and why, the review, what the fix pass did, and what the run spent of your
quota.

### After the pull request

`/ship resume` on that run reads the pull request's failing checks and the reviews and comments made since the last
time, writes them to `.scratch/<feature>/followup.md`, and gives them to a fresh implementer in the finishing
worktree. What it builds is verified, committed, pushed, and added to the pull request's body. With nothing failing
and nothing new said, nothing happens.

To go on after tickets were blocked: fix the ticket that **failed** and set its `**Status:**` back to `ready`. The
tickets that were blocked only for hanging off it are ready again by themselves at the next `/ship resume`.

## What a run keeps to

- **Your working tree.** Tickets, the review and every pass are built in worktrees; nothing is reset or cleaned in
  your checkout, and a run starts whatever you have uncommitted and whatever branch you are on. (Starting a *new*
  run still wants a clean tree, because the grilling's changes are committed with it.)
- **Your quota.** No ticket starts when the 5-hour window is past its threshold: the run pauses and goes on by
  itself after the reset, in this session or in the next one you open in the repo. Under the threshold it starts
  only as many tickets as the window has room for, at what a ticket has cost so far. The review waits the same way.
  Past the weekly threshold the building stops and the pull request is opened on what was built, unreviewed, and
  says so.
- **Nobody to ask.** Every tool call of a run's agent is decided by the mod, never put to you. An implementer has
  its file tools and a shell that runs only the spec's verification commands, exactly as written, and a short list
  of git commands, with no option that writes a file or opens a pager; the reviewer only reads. An agent that
  writes may write under its own worktree, and a ticket's implementer to its ticket file, and nowhere else.

## Ticket format

```
# 03: A cart is paid by card

**What to build:** The behaviour this ticket makes work, end to end.

**Blocked by:** 01, 02

**Status:** ready

**Touches:** src/cart/pay.ts, src/cart/pay.test.ts
**Outward actions:** installs the npm package `stripe`

- [ ] An acceptance criterion
- [ ] Another
```

`**Status:**` is `ready`, `in-progress`, `done`, `blocked` or `too-large`; the run moves it. `**Model:** <model>`
puts one ticket on another model than the default. `Touches:` is an estimate, not a limit: it decides what is built
side by side, and the pull request says how far it was from what the ticket changed.

## Settings

| Setting | Default | What it sets |
| --- | --- | --- |
| `implementerModel` | `sonnet` | The model a ticket, the fix pass and a follow-up are built on. |
| `strongModel` | `opus` | The model of the grilling, the spec, the tickets and the review. |
| `exploreModel` | `haiku` | The model of reading the codebase. |
| `shortWindowPercent` | 90 | How full the 5-hour quota window may be for a ticket to start. |
| `weeklyPercent` | 90 | How full the weekly quota window may be for a ticket to start. |
| `contextPercent` | 70 | The share of a 200,000-token window an implementer may fill before it is stopped. |
| `parallelTickets` | 3 | How many tickets are built at once, from 1 to 8. |

## What a run leaves on disk

Everything is under `.scratch/<feature>/`, which the mod has git ignore:

| Path | What it is |
| --- | --- |
| `source.md` | The idea as typed, or the issue's text. |
| `spec.md` | The spec. |
| `issues/` | The tickets. |
| `run.json` | The record: with the ticket files, the whole state of the run. |
| `review.md`, `fixes.md` | What the reviewer found, and what the fix pass reported. |
| `followup.md`, `followed.md` | What the pull request had met, and what the follow-up pass reported. |
| `trees/` | The worktrees, while they are in use. |

`/ship clean <feature>` removes all of it.

## Working on the mod

```
claude plugin validate .claude/mods/ship-flow
claude plugin test .claude/mods/ship-flow
```

The hooks module is `hooks/register.ts`, the only file that touches the engine: it builds a `Host` (`hooks/host.ts`)
that every other module is written against.

| Module | What it holds |
| --- | --- |
| `attended.ts` | Starting a run, the attended phase, the checkpoint and its approval. |
| `runner.ts` | The walk of the ticket graph: taking tickets, judging and landing their work, resume and stop. |
| `finisher.ts` | The review, the fix pass, the pull request and its follow-up. |
| `guard.ts` | The permission decision for each tool call of a run's agent. |
| `tickets.ts` | Ticket files, the graph, what may be built side by side, the schedule. |
| `radius.ts`, `reading.ts` | The blast radius, and reading the repo for it. |
| `budget.ts` | The settings, the context budget and the quota rules. |
| `shell.ts`, `spec.ts`, `work.ts` | The shell allowlist, the spec's commands, and git, worktrees and subagents. |
| `folders.ts`, `run.ts`, `history.ts` | Reading and writing a run's files, the record, and what past runs say of a ticket's size. |
| `clean.ts`, `status.ts`, `pane.tsx` | `/ship clean`, `/ship status` and the pane. |

The pane is drawn with the ui-kit parts copied into `hooks/kit/`. The decisions behind the mod are in
[`docs/adr`](../../../docs/adr) (0002, 0003, 0004), its vocabulary in [`CONTEXT.md`](../../../CONTEXT.md), and what
was learnt about the mod API in [`docs/research/ship-flow-mod-api.md`](../../../docs/research/ship-flow-mod-api.md).

## Not seen live yet

The tests run the mod against a stand-in for the engine. In a live run an agent's shell started where the session
is, not in its worktree, so its verification commands ran against the repo's own working tree. The mod now takes
each shell command of a run's agent to the agent's worktree itself, as `(cd '<worktree>' && <command>)`, and judges
the command as the agent wrote it. That has been seen in the tests and not in a live run yet.
