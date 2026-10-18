# Ship-flow is retired

Two workflow mods took an issue to a pull request: `ship-flow`, easy to adopt and safe to leave unattended, and the
pipeline (once `middle-earth`), which checks each change more strictly: a changed run must be pinned by a test, tests
are written first and locked, and both reviewers judge each task against `standards.md`. Two pipelines split the
effort between them, and neither had what the other did well (#96).

So the pipeline took what ship-flow did better, and ship-flow is removed:

- **Its budget** (#100): no task starts while the 5-hour quota window is past its threshold; the run waits and goes
  on by itself after the reset, in a later session too, and stops past the weekly one. A builder that fills too much
  of its context is stopped and its task said to be too large. Ported from `budget.ts` as `core/budget.ts`.
- **A proof without project setup** (#101): a project with no `.claude/verify` is proved by the verification
  commands its plan or its issue states (`## Verification`, `## Setup`), as ship-flow's spec was. The radius and
  pinning are the upgrade a project opts into.
- **Starting from an idea** (#102): `/planner <idea>` grills the person, opens the issue and plans it; an auto run
  lists what it decided without the person, in the plan and the pull request.
- **Its pull request** (#103): each task's commit, how long it took, what it changed beyond its files and left
  unticked, then what was not built, the minor findings and what the run spent. Failing checks are followed up beside
  the review comments.
- **GitLab** (#98): one `Forge` over `gh` and `glab`, as ship-flow's `forge.ts` was.

## What was dropped

- **The spec and the tickets as local files** (`.scratch/<feature>/`), read and edited before one checkpoint. The
  pipeline's plan is the planner's, kept by the mod and shown in its pane, where its questions and risks are settled
  before a run starts.
- **The blast radius estimate** from a ticket's `**Touches:**` and `**Outward actions:**`. Verify measures what a
  change reached instead, by playing the runs and requests a project keeps.
- **Sizing from history** (each ticket's estimate against what earlier runs took), the quota's room for tickets built
  side by side (`roomFor`), and a draft pull request for a run left unfinished. A run with an unfinished task does not
  open its pull request at all.
- **The branch reviewed and fixed once at the end.** The pipeline's reviewers judge every task, then the whole branch;
  what they find blocking stops the run for the person.
- **Settings for the models** of each kind of work. The pipeline sends a builder by the task's weight and kind, a rung
  up after each failed try.

## Consequences

- `.claude/mods/ship-flow`, its marketplace (`ship-flow-mods`) and its mentions are removed; ADRs 0002 to 0004 and
  `docs/research/ship-flow-mod-api.md` stay as the record of why it was built as it was.
- A ship-flow run in progress cannot be taken up: finish it, or start it again as a pipeline run.
- "Run" means a pipeline run alone.
