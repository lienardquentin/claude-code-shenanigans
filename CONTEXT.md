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

**Run**:
One feature taken from an idea or an existing issue to a pull request by the workflow mod.
_Avoid_: Job, pipeline, session

**Feature issue**:
The single issue a run starts from, or opens from its spec at the checkpoint, on the repo's forge (GitHub or GitLab), closed by the run's pull request (a merge request on GitLab).
_Avoid_: Parent issue, epic

**Spec**:
The document that states what a run builds, written locally; a run that started from an idea publishes it as its feature issue.
_Avoid_: PRD, plan

**Ticket**:
One local file describing a vertical slice of a spec, with the tickets that block it.
_Avoid_: Task, sub-issue, step

**Flight**:
One ticket being built: its implementer at work in a git worktree of its own, on a branch cut from the run's branch. A run has several at once when their tickets' reaches do not overlap.
_Avoid_: Job, worker, slot

**Run card**:
A run's card in the workflow pane: its standing, quota and actions, with a ticket card for each of its tickets nested inside.
_Avoid_: Issue card, run row

**Ticket card**:
One ticket drawn inside its run card: number, title, state, what blocks it, how far it got, and its reach and outward actions.
_Avoid_: Ticket row, ticket line

**Checkpoint**:
A point in a run where it stops for the user's decision; an auto run passes it by itself.
_Avoid_: Gate, approval step

**Auto run**:
A run the user opted to be asked nothing in: each question takes the recommended option, and its checkpoint approves itself.
_Avoid_: Auto mode, YOLO run, unattended run

**Blast radius**:
What building a ticket is estimated to touch, in two parts never folded into one figure: its reach and its outward actions. A run's blast radius is the union of its tickets'.
_Avoid_: Impact, risk score, scope

**Reach**:
The files a ticket expects to change, and the files that depend on them.
_Avoid_: Footprint, surface area

**Outward action**:
Something a ticket expects to do that reaches outside the working tree or is hard to reverse.
_Avoid_: Side effect, dangerous command

**Context budget**:
How much of one context window a phase of a run may fill before its work must move to a fresh window.
_Avoid_: Session usage, token limit

**Quota**:
The plan's usage allowance that a run spends, by time window.
_Avoid_: Session usage, rate limit, credits

**Status line**:
The one line a mod pins under the prompt: folder, branch, model and context fill.
_Avoid_: Status bar, footer, prompt line

**Context fill**:
How much of the current session's context window is used. A measure, where a context budget is a limit a run sets.
_Avoid_: Session usage, context usage, tokens left

## Middle-earth

The Middle-earth mods (`.claude/mods`, the `middle-earth` marketplace) take an issue, or a pull request's review, to
committed and reviewed work. The `middle-earth` plugin holds the parts of the workflow: the Rings list the issues,
Elrond plans, the Fellowship builds, Lothlórien writes tests first, the Argonath check and review, the Black Gate reads
review, and Mount Doom cleans up. Andúril and the palantír, plugins of their own, watch what the code does.

**Part**:
One of the workflow's seven pieces inside the `middle-earth` plugin (the Rings, Elrond, the Fellowship, Lothlórien, the
Argonath, the Black Gate, Mount Doom), with its own folder, command and pane. Parts call one another as functions.
_Avoid_: Mod (for a part), module, sub-plugin

**Sent agent**:
A subagent a part sends (the council, a builder, Galadriel, a statue), registered, recorded and guarded in one place:
held to what its role allows under the session's own permission mode.
_Avoid_: Worker, helper, bot

**Quest**:
One piece of work the Fellowship takes to a pull request, or to a push: a plan, an errand or a review. Several quests run
at once, one an issue or pull request.
_Avoid_: Run, job, flow

**Rings**:
The pane of the origin's open issues (/rings), where the person sends one as an errand to the Fellowship or to the
council to be planned; an issue a quest is on already is left to the Fellowship.
_Avoid_: Backlog, issue list, inbox

**Plan**:
Elrond's split of one issue into tasks, with the questions the person answers and the risks they decide before a quest
on it may start.
_Avoid_: Spec, ticket list

**Errand**:
A quest on an issue small enough for one change, built with no plan; its builder hands it back when it is not.
_Avoid_: Quick fix, small quest

**Review quest**:
A quest the Black Gate hands over: the review comments of an open pull request that ask for a change, each a task
answered on the pull request's own branch, and pushed there, never opened as a new pull request.
_Avoid_: Gate run, review run

**Task**:
One step of a quest, built in one change and committed alone: a plan's task, an errand's whole issue, or one review
comment.
_Avoid_: Ticket, step, job

**Quest worktree**:
The git worktree a quest is built in, under `.fellowship/trees/`; the person's own checkout is never switched by a
quest. A review whose branch is already checked out somewhere is built there instead.
_Avoid_: Sandbox, clone, workspace

**Builder**:
The subagent that builds one task in the quest worktree (a member of the Fellowship, chosen by the task's weight and
target, a rung up on each try, Gandalf last).
_Avoid_: Implementer, worker, companion

**Hand back**:
A builder's ending its turn with `Handed back:` and why, building nothing more: a plan that must be revised (Gandalf
alone), an issue that is no errand, a review comment only the person can answer.
_Avoid_: Refuse, give up, bail

**Kept run**:
A command-line run (`$` line of `.claude/anduril`) or a service request (`$` line of `.claude/argonath`) the project keeps,
played on HEAD's build and the working tree's to see what a change altered.
_Avoid_: Fixture, golden, snapshot

**Radius**:
The kept runs whose answer a change altered, each `bare` or `marked` by a test.
_Avoid_: Blast radius (that is ship-flow's), diff, impact

**Pinned**:
A changed run whose test fails on HEAD's source and passes on the working tree. A change is settled once every changed
run is pinned and no test it can break is broken.
_Avoid_: Covered, tested, green

**Proof**:
The Argonath's check of a change: its radius afresh, then the tests on both sides, the tests and checks it can break (and
the audit of the dependencies whose manifests it touches), settled or not.
_Avoid_: CI, test run, validation

**Statues**:
The Argonath's two reviewers, both sent on every settled change: Isildur for correctness, Anárion for security. A
blocking finding, or one whose severity they do not call minor, sends the change back to its builder.
_Avoid_: Judges, reviewers' bots, checks

**Tests first**:
The failing tests Galadriel writes for a plan's task that is not light, before its builder starts; locked until committed,
changed only with a reason the statues are shown.
_Avoid_: Spec tests, red tests, TDD tests

**Relic**:
What a mod keeps of a quest (its branch, worktree, plan, tests first), which Mount Doom clears once its pull request is
merged.
_Avoid_: Leftovers, cache, artefact
