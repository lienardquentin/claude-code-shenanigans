# Changelog

Each release bumps `version` in `.claude-plugin/plugin.json`: `claude plugin update` takes a plugin whose version has
not changed for up to date, whatever its files hold.

## 0.9.0

- A run's view model (#160, `core/view.ts`): the run, each task as a node of its graph with its five steps, who builds
  it, its commit or why it waits, and the actions open on it. Every view draws from it and derives nothing itself; a
  test fails when a field of the model is drawn by no view and not left out on purpose.
- `/theseus graph [run]` and the "Run graph" pane draw a run as its graph; picking a task shows its events, and the
  pane's buttons do the run's actions. `/theseus history` lists every run with a log.
- One dispatcher for every action a view offers (`dispatch`), through the verb of `/theseus build` it names; a new verb,
  `/theseus build go [run]`, has a run go on by itself.

## 0.8.1

- The three largest core modules are split by phase and concern, with no change in behaviour (#155): the build's
  loop into `core/loop/` (ports, start, send, prove, review, commit, submit), the run's work into `core/runs/`
  (builders, work, fence, prompts, texts, steps), the proof into `core/proofs/` (project, changes, answers, marks,
  verdict). `core/build.ts`, `core/run.ts` and `core/proof.ts` re-export them.
- The plugin type-checks against the engine's own types (`sh .claude/mods/kit/typecheck.sh .claude/mods/theseus`); the
  one error it found, in reading a comment's weight, is fixed.

## 0.8.0

- Each run keeps its history in `.theseus/runs/<run>.jsonl` (#154): every change the build keeps of it (started, a
  task sent, a commit, a proof, the reviewers' verdict, a wait for the quota, a pull request opened, a move from one
  phase to another, what the pane said) as an event with its time and its cause: your command, Claude's call, the
  clock, an agent's turn ending, a press on a pane.
- `/theseus` says each run's standing from its log: where it is, since when, what moved it there, and its last
  events. `/theseus log [run]` shows the whole history. The build pane shows the selected run's last events.
- The moves a run may make stay the one table in `core/phases.ts`; the events are worked out from what each kept
  change changed (`core/events.ts`), so no part writes the log by hand.

## 0.7.2

- What you read is plainer (#153, first part): command answers lead with what happened and name the next command
  ("Started an errand on #21. The build pane shows its progress."), failures say "failed" where they said
  "stumbled", and the pane's progress lines say what is being done ("Proving task 3…", "Reviewing task 3…").
  `docs/agents/writing.md` holds the rules.

## 0.7.1

- What Theseus adds to Claude's context at each turn is measured and held to budgets by a test (#152). Until a
  turn touches a target, verify says one line (about 60 tokens, from about 150): which targets, and the three steps
  after an edit; the full steps and the reviewers come once a target is touched. The README lists each cost.

## 0.7.0

- The names from before #104 are no longer read (#150): `.claude/argonath`, `.fellowship/trees` and
  `.fellowship/spend.jsonl`, and a test marked `sting:` (write `pins:`). A commit no longer leaves out the old
  folders `.anduril`, `.elrond`, `.argonath`, `.fellowship`, `.lothlorien`, `.blackgate`. The `pipeline` carry-over
  stays for one more release.

## 0.6.1

- The manifest names its author, homepage, repository, license (MIT) and keywords (#149).
- A README of its own: what Theseus does, a quickstart, how a run goes, its commands, options and files, and what to
  do when something goes wrong.

## 0.6.0

- The project file is `.claude/theseus.toml` (#148), specified in `docs/config.md`, with a JSON Schema
  (`schema/theseus.schema.json`) editors check it against. Every error names its line: an unknown key, a value of the
  wrong type, a missing required key. Errors are said once, listed by `/theseus doctor`, and stop a run.
- `/theseus init` proposes the file from the project's manifests (Cargo binaries, FastAPI apps, JavaScript apps with
  tests), or from `.claude/verify`; `/theseus init --write` writes it.
- `.claude/verify` is still read where no TOML file is, with a warning, for one release; it now says by its line each
  line that reads as nothing and each setting of a target it does not name, which it dropped silently before.

## 0.5.0

- `/theseus doctor` (#147) checks what Theseus needs on this machine and in this project, each only when the project
  needs it: git and the repository, the origin remote and the forge's CLI signed in to its host, `.claude/verify`,
  python3 for the proof's handlers, every program a target's commands start, Docker for a target with a database,
  kubectl and its context for a live stage, the recorder for a command-line target, and installed copies that lag.
  Each miss names the one step that fixes it; Theseus runs no installer. Claude reads it through the pane tool
  (`doctor`).
- `/theseus build` starts no run, errand or review while something it needs is missing, and names what.

## 0.4.0

- One command, `/theseus <verb>` (#151): `plan`, `build`, `tests`, `verify`, `follow-up`, `cleanup`, `issues`,
  `troubles` and `help`. Alone it says what is under way and what failed; a verb it does not know is answered with
  the help. Every message that names a command names its `/theseus` spelling.
- The panes are read by the same names (`plan` was `planner`, `tests` was `tests-first`); the old names are still
  read by `mcp__theseus__pane`.
- `/issues`, `/planner`, `/build`, `/tests`, `/checks`, `/follow-up` and `/cleanup` still work, each saying its new
  spelling first. They go in the next release.

## 0.3.0

- The plugin is Theseus (`theseus@theseus`), formerly `pipeline` (ADR 0008). Its tools are `mcp__theseus__*`, its
  agent types `theseus:*`, its project folder `.theseus/`, and its toasts say "Theseus:".
- On its first start it carries the plans and runs the `pipeline` plugin kept, and moves `.pipeline/` to `.theseus/`,
  repairing the worktrees in it. A store that does not read is said, not taken for an empty one. The carries from
  the older stores (`elrond`, `fellowship`, `middle-earth`) are gone: the pipeline carried them long ago.

## 0.2.2

- No failure is dropped any more (#145). A part's work on a clock, its store writes, its prompts to Claude and its
  agent types say their failure in a toast and keep it: `mcp__theseus__pane` with `troubles` lists what each part
  failed at, how often and when. A part failing alike is said once, then counted.
- What a run decides from no longer defaults when it cannot be read: the project's targets (once taken as none, which
  proved a change by its plan's commands alone), the quota (once taken as no limit), the tests written first (once
  taken as none, which skipped the check of what a builder changed of them), the ignore file of `.theseus/`.
- Toasts say "failed" where they said "stumbled".

## 0.2.1

- CI validates and tests every mod, checks the kit copies and refuses a changed plugin whose version was not
  bumped (#146). `handlers/service.py` passes ruff.

## 0.2.0

- The lag check compares everything the plugin ships, not `hooks/` alone, and says when a copy differs under the same
  version, which `claude plugin update` will not replace (#144).
- First versioned release: everything merged up to #143 (the planner, the build, the test writer, verify, the review
  follow-up, the cleanup and the issues pane).

## 0.1.0

- The plugin as first installed, before versions were kept.
