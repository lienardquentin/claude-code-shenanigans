# Claude Code Shenanigans

Personal Claude Code mods. The workflow mod takes one feature from an idea or an issue to a pull request.

## Language

**Mod**:
A plugin that changes Claude Code's own interface or behaviour, here mostly a pane opened by a slash command.
_Avoid_: Extension, add-on

**Surface**:
Where a session is drawn: the terminal, the desktop app, VS Code or mobile. Each draws a different set of elements.
_Avoid_: Client, platform, frontend

**Diagram**:
One Mermaid source found in a reply, shown in the pane as text drawn by termaid in the terminal, and as a picture drawn by Mermaid itself on the other surfaces.
_Avoid_: Chart, graph, figure

**Lane**:
One row of the timeline pane: the main conversation's, or one subagent's from its spawn to the end of its run.
_Avoid_: Track, swimlane, thread

**Span**:
One stretch of work drawn in a lane: a turn of the main conversation, or one tool call, with when it started and ended.
_Avoid_: Event, entry, bar

**Auto run**:
A run that goes on by itself: each task sent once the one before is committed, and the pull request opened at the end. What its plan left open it settles with the planner's recommended option, and lists as decided without the person.
_Avoid_: Auto mode, YOLO run, unattended run

**Context budget**:
How much of one context window a builder may fill before it is stopped and its task said to be too large, to be split.
_Avoid_: Session usage, token limit

**Quota**:
The plan's usage allowance that a run spends, by time window: past a threshold, no task starts.
_Avoid_: Session usage, rate limit, credits

**Status line**:
The one line a mod pins under the prompt: folder, branch, model and context fill.
_Avoid_: Status bar, footer, prompt line

**Context fill**:
How much of the current session's context window is used. A measure, where a context budget is a limit a run sets.
_Avoid_: Session usage, context usage, tokens left

## Theseus

Theseus ([lienardquentin/theseus](https://github.com/lienardquentin/theseus), the `theseus` marketplace) takes an issue, or a pull request's review, to committed
and reviewed work. The `theseus` plugin holds the parts of the workflow: the issues pane lists the issues,
the planner plans, the build builds, the test writer writes tests first, verify checks and reviews, the review follow-up reads
review, and the cleanup clears what is merged. The recorder and the runtime, plugins of their own, watch what the code does.

**Part**:
One of the workflow's seven pieces inside the `theseus` plugin (the issues pane, the planner, the build, tests first,
verify, the review follow-up, the cleanup), with its own folder, command and pane. Parts call one another as functions.
_Avoid_: Mod (for a part), module, sub-plugin

**Sent agent**:
A subagent a part sends (the planner, a builder, the test writer, a reviewer), registered, recorded and guarded in one place:
held to what its role allows under the session's own permission mode.
_Avoid_: Worker, helper, bot

**Run**:
One piece of work the build (`/build`) takes to a pull request, or to a push: a plan, an errand or a review. Several
runs go at once, one an issue or pull request.
_Avoid_: Quest, job, flow

**Issues pane**:
The pane of the origin's open issues (/issues), where the person sends one as an errand to the build or to the
planner; an issue a run is on already is left to the build.
_Avoid_: Rings, backlog, inbox

**Plan**:
The planner's (`/planner`) split of one issue into tasks, with the questions the person answers and the risks they decide before a run
on it may start.
_Avoid_: Spec, ticket list

**Errand**:
A run on an issue small enough for one change, built with no plan; its builder hands it back when it is not.
_Avoid_: Quick fix, small run

**Review run**:
A run the review follow-up (`/follow-up`) hands over: the review comments of an open pull request that ask for a change, each a task
answered on the pull request's own branch, and pushed there, never opened as a new pull request.
_Avoid_: Gate run, review run

**Task**:
One step of a run, built in one change and committed alone: a plan's task, an errand's whole issue, or one review
comment.
_Avoid_: Ticket, step, job

**Run worktree**:
The git worktree a run is built in, under `.theseus/trees/`; the person's own checkout is never switched by a
run. A review whose branch is already checked out somewhere is built there instead.
_Avoid_: Sandbox, clone, workspace

**Lane**:
One task of a plan's run built beside its others, in a worktree and on a branch of its own off the run's, when the
tasks ready share no file (three at most). Once passed, it lands on the run's branch: rebased onto what landed before
it and proved again, or sent back to its builder where the two conflict.
_Avoid_: Ticket worktree, parallel task, sub-run

**Builder**:
The subagent that builds one task in the run worktree (light, CLI, service, frontend, heavy or last, chosen by the
task's weight and target, a rung up on each try, the last builder last).
_Avoid_: Implementer, worker, companion

**Hand back**:
A builder's ending its turn with `Handed back:` and why, building nothing more: a plan that must be revised (the last builder
alone), an issue that is no errand, a review comment only the person can answer.
_Avoid_: Refuse, give up, bail

**Kept run**:
A command-line run (`$` line of `.claude/recorder`) or a service request (`requests` of a target in `.claude/theseus.toml`) the project keeps,
played on HEAD's build and the working tree's to see what a change altered.
_Avoid_: Fixture, golden, snapshot

**Radius**:
The kept runs whose answer a change altered, each `bare` or `marked` by a test.
_Avoid_: Blast radius, diff, impact

**Pinned**:
A changed run whose test fails on HEAD's source and passes on the working tree. A change is settled once every changed
run is pinned and no test it can break is broken.
_Avoid_: Covered, tested, green

**Proof**:
Verify's (`/checks`) check of a change: its radius afresh, then the tests on both sides, the tests and checks it can break (and
the audit of the dependencies whose manifests it touches), settled or not.
_Avoid_: CI, test run, validation

**Reviewers**:
Verify's two reviewers, both sent on every settled change: one for correctness, one for security. A
blocking finding, or one whose severity they do not call minor, sends the change back to its builder.
_Avoid_: Statues, judges, reviewers' bots, checks

**Tests first**:
The failing tests the test writer (`/tests`) writes for a plan's task that is not light, before its builder starts; locked until committed,
changed only with a reason the reviewers are shown.
_Avoid_: Spec tests, red tests, TDD tests

**Leftover**:
What a part keeps of a run (its branch, worktree, plan, tests first), which the cleanup (`/cleanup`) clears once its
pull request is merged.
_Avoid_: Relic, cache, artefact

**Core**:
The workflow's code that never touches the engine (`theseus/core` in its repository): it runs commands through a shell it
is handed, so the mod and a runner outside Claude Code can share it. Written in plain names.
_Avoid_: Engine, kernel, lib

**Forge**:
The core's one way to a repository's host: GitHub through `gh`, GitLab through `glab`. No part builds a forge's command
itself.
_Avoid_: Host (for the forge), provider, remote
