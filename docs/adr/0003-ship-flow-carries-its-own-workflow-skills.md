# ship-flow carries its own copies of to-spec, to-tickets and implement

`ship-flow` automates the flow of the `mattpocock-skills` plugin but holds its own adapted text for `to-spec`,
`to-tickets` and `implement` instead of calling the plugin's. Those three are marked `disable-model-invocation`, so
neither the model nor a subagent can invoke them; reading their files from the plugin cache would tie the mod to a
versioned path that changes on every plugin update. They also need changing: a run keeps its spec and tickets as
local files under `.scratch/<feature>/` and never publishes them as issues, the spec carries a Verification section
with the test and typecheck commands, and tickets carry more states than `ready-for-agent`. The skills that can be
invoked and need no change (`grilling`, `domain-modeling`, `tdd`, `code-review`) are still called from the plugin.

## Consequences

- Improvements to the plugin's three skills do not reach the mod; they are ported by hand when wanted.
- The mod still depends on the plugin being installed, for the four skills it calls.
