# ship-flow carries its own copies of to-spec, to-tickets and implement

`ship-flow` automates the flow of the `mattpocock-skills` plugin but holds its own adapted text for `to-spec`,
`to-tickets` and `implement` instead of calling the plugin's. Those three are marked `disable-model-invocation`, so
neither the model nor a subagent can invoke them; reading their files from the plugin cache would tie the mod to a
versioned path that changes on every plugin update. They also need changing: a run keeps its spec and tickets as
local files under `.scratch/<feature>/` and publishes one issue at most (the spec, for a run that started from an
idea; never the tickets), the spec carries a Verification section
with the test and typecheck commands, and tickets carry more states than `ready-for-agent`. The skills that can be
invoked and need no change (`grilling`, `domain-modeling`) are still called from the plugin.

The unattended phase calls no skill of the plugin at all. Its implementer and its reviewer are agent types the mod
registers, each with its own prompt: the implementer's says to work test-first, and the reviewer's carries the two
axes of the plugin's `code-review` (Spec and Standards) in one agent. The plugin's `code-review` runs its two axes
in sub-agents of its own, whose tool calls the run could not decide for; an unattended run would then stop on a
permission prompt with nobody there to answer it.

## Consequences

- Improvements to the plugin's skills do not reach the mod's carried text; they are ported by hand when wanted.
- The mod depends on the plugin being installed only for the attended phase, for the two skills it calls there.
- The review is one agent reading both axes, not two reading one each.
