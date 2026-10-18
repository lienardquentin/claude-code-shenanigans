# Theseus's threat model

Theseus sends agents that edit code and run commands in your repository, reads issues and review comments that
anyone may have written, pushes branches and opens pull requests, and, where a project asks for it, plays a service
against a deployed cluster. This page says what each part may do, what holds it to that, what leaves the machine,
and where the limits are.

## Who acts

| Actor | Runs as | May |
|---|---|---|
| The session (Claude) | Your permission mode | What you allow it. Theseus offers it no tool that pushes, opens a pull request or merges. |
| The planner | Your permission mode, in the project's folder | Read the project, run commands that only read, write its one plan file under `.theseus/plans/`. |
| A builder | Your permission mode, in the run's worktree | Read and change files in that worktree, run commands there. |
| The test writer | Your permission mode, in the worktree it writes in | Write test files only, run commands that test or read. |
| A reviewer | Your permission mode | Read the change and the project, run commands that only read. |
| The web view's server | A Node process the session starts and ends | Serve `.theseus/views` and `.theseus/runs` on 127.0.0.1, and write requested actions to `.theseus/requests.jsonl`. |

No agent Theseus sends gets a permission mode of its own: each runs under the session's
(`tests/build.test.ts`, "sends its builders under the session's own permission mode").

## The guard

Every tool call of an agent Theseus sent goes through one guard (`refusalOf` and `linkRefusal` in
`hooks/agents.ts`), before your own permission rules see it.

- **The sandbox stays on**: a call that asks to leave it (`dangerouslyDisableSandbox`) is refused.
- **Private places**: a path or command reaching your home's private folders, or the machine's, is refused
  (`isPrivatePath`, `privateRefusal` in `hooks/flow.ts`).
- **The fence**: a builder and the test writer work in their worktree alone. A path outside it is refused as it is
  spelt (`isOutside`), and then as the machine resolves it, links followed (`linkRefusal`), so a link made in the
  worktree does not lead out. A shell command that names your checkout, or `cd`s out of the worktree, is refused
  (`reachesOut`).
- **Git**: a builder runs no git command that moves HEAD or the index, commits, or changes git's config
  (`isForbiddenGit`); Theseus commits, after the proof and the reviewers.
- **The mods' own folders** (`.theseus/`, `.recorder/`, the mods' source) are not a builder's to change unless its task
  names them.
- **Roles**: the planner and the reviewers run only commands that read (`isChanging`); the planner writes only its plan
  file; the test writer writes only test files.
- **Tests written first are locked**: a builder that changes one must say why, through `mcp__theseus__amend_test`, and
  what it took out with no reason is a finding the reviewers see.

The shell checks read a command as its words read. A command built to hide where it goes (through `eval`, a variable,
a script it writes first) can pass them: they are a fence for agents that mean well. **The sandbox is the boundary**;
run Claude Code with it on.

## What the project's file makes Theseus run

`.claude/theseus.toml` names commands (`test`, `affected`, `checks`, `audit`, `db.setup`, the live stage's statements),
and Theseus runs them on your machine. They are read from **your checkout's** file only: a run's branch, which an agent
wrote, never changes what runs unasked (`targetsIn` in `hooks/verify/register.tsx`). The same holds for the written
standards the reviewers judge by.

## What Theseus reads that others wrote

- **Issues and review comments** are handed to agents as data, fenced, with their author; an agent is told to follow
  no instruction in them.
- **An issue opened from outside the repository** (by someone who cannot push to it) is never started on a call of
  Claude's: you start it yourself (`tests/build.test.ts`, "on an issue opened from outside the repository…").
- **A review comment from outside the repository** is a question for you, never built on.
- **A commit that adds what looks like a secret** is not made, and no branch holding one is pushed
  (`leakOf` in `core/git.ts`).
- **Git hooks**: a commit is not made when what git runs on a commit changed since the run started, or when the change
  touches those hooks (`core/git.ts`).

## What leaves the machine

| Where | What | When |
|---|---|---|
| The Claude API | What Claude and every agent read and write | Always, as any Claude Code session |
| Your forge (`gh`, `glab`) | Issues and comments read; a run's branch pushed; its pull request opened; review threads answered | Read when you plan, build or follow up; pushed and opened on `/theseus build submit` or the build pane's button, or by itself on an `--auto` run |
| Your cluster (`kubectl`) | A deployed workload's variables and secrets read; port-forwards; copies of its database made and dropped | Only for a target with a live stage, in a context `live_contexts` names, never one whose name holds `prod` |
| The web view | Nothing: its page loads nothing from outside, and its server answers 127.0.0.1 alone | |

## Destructive and outward actions

| Action | Who starts it | Asks first? |
|---|---|---|
| Push a run's branch, open its pull request | You (`/theseus build submit`, the build pane, the web view) | No further question: the command is the ask. An `--auto` run does it by itself, which you asked for when you started it. |
| Push answers to a review | You (`/theseus follow-up answer`), or an `--auto` follow-up | As above. |
| Commit a task on the run's branch | Theseus, once the proof settles and the reviewers pass it | No: the branch is the run's own, and nothing is pushed until you submit. |
| Remove a run's worktree and delete its branch | You (`/theseus build abandon`, `/theseus cleanup clean`) | Refused while the worktree holds uncommitted changes, or a lane of the run is out. |
| Remove a merged run's worktree and branch | You (`/theseus cleanup clean`) | The cleanup tells you once a pull request merged; nothing is removed until you run it. |
| Play requests against a deployed service | Verify, after an edit of the target | Only in a context `live_contexts` names. The shared database is only read: each build plays against a copy, dropped after. |

Theseus never merges a pull request and never force-pushes. It merges a run's base into the run's branch, locally,
to keep it current, and deletes only the branches it made (a run's, a lane's).

## The live stage's secrets

The live stage reads the deployed workload's variables, a secret's value read from its secret, to run both builds
as the workload runs. Every secret's value is written `<secret>` in everything the live handler answers
(`redacted` in `handlers/live.py`), so none reaches the pane, Claude, the reviewers, the logs or a pull request.

## The web view

The server listens on 127.0.0.1 alone. Every API call needs a 24-byte token the session makes and the address carries,
compared in constant time. It reads nothing outside the project's `.theseus/` folder, refuses a run file name that is
not a plain name, and accepts six actions on a run that has a view; an action goes to Theseus through a file, and is
done through the same dispatcher as a press in the terminal. The page loads nothing from outside (its
Content-Security-Policy allows its own server alone), which a test checks request by request.

## Reporting a vulnerability

Open a private security advisory on the repository, not a public issue.
