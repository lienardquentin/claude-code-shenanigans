# The product is Theseus

The workflow plugin was `pipeline`: a plain name, chosen in #96 to replace the Tolkien ones, which every reader had
to learn before the code made sense. It is now meant to be installed by others (#159), and `pipeline` names a kind
of thing rather than this one: it collides with CI pipelines in the forge's own vocabulary (GitLab's pipeline jobs are
read by the review follow-up), and with any other plugin's `/pipeline`.

So the product is **Theseus**, after the maze-solving mouse Claude Shannon built in 1950: one of the first machines to
learn, finding its way through a labyrinth it did not know. The plugin, the marketplace, the tools
(`mcp__theseus__*`), the agent types (`theseus:*`), the state and the project's folder (`.theseus/`) take the name.

The parts keep their plain names: the planner, the build, the test writer, verify, the review follow-up, the cleanup.
The name is the product's alone, so the theme costs nothing to read.

## Consequences

- On its first start Theseus carries the plans and runs of the `pipeline` stores into its own, and moves a project's
  `.pipeline/` folder to `.theseus/`, repairing the worktrees git knows there (`hooks/stores.ts`).
- A commit still leaves `.pipeline/` out, as it leaves the older folders out, until the old names are dropped (#150).
- The marketplace is `theseus`: an install from the `pipeline` marketplace is removed and made afresh.
