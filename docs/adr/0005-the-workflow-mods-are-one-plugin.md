# The workflow mods are one plugin

Elrond, the Fellowship, Lothlórien, the Argonath, the Black Gate and Mount Doom were six plugins, each installed alone
and each with a copy of what they shared. They are now the parts of one plugin, `middle-earth`
(`.claude/mods/middle-earth`), each a folder under `hooks/`. Andúril and the palantír stay plugins of their own: each is
useful without the workflow.

Six plugins cost more than they gave. The parts never ran alone (the Fellowship builds Elrond's plan, proves through
the Argonath, has Lothlórien write tests first; the Black Gate hands its review to the Fellowship; Mount Doom asks
them all what they keep), so their separateness bought nothing and charged for it:

- **Copied code.** The kit's `flow.ts` was copied into five plugins, `trees.ts` into four; `isChanging` was written
  three times and the path resolver twice.
- **Calls between plugins went through `$.mcp.call`,** under the engine's re-entry rules: a command hook could not call
  another plugin, so every command deferred its work to a clock, and a guard asked beneath another plugin's pending
  call could make no `$` call at all. Each guard therefore kept a synchronous record of the agents it sent.
- **Four records of agents and their worktrees** (the Fellowship's fences, the Argonath's statues and trees,
  Lothlórien's gazers and trees, Andúril's trees), which could disagree.

In one plugin the parts call one another as functions: what was a JSON answer to a tool call is an object handed over.
One module, `hooks/agents.ts`, registers every agent type (none with a permission mode of its own), keeps one record of
every agent sent, by id, in memory and in the session's state so a reload recalls it, and holds one guard over all of
them. An agent the record lost is found by its type and by the part that sent it.

## Consequences

- Tool names are `mcp__middle-earth__<tool>` and agent types `middle-earth:<name>`. The six `pane` tools are one, which
  takes the pane's name. The tools other mods alone called (`forget`, `relics` of all but Mount Doom, `targets`, the
  `json`, `tree`, `mustPass` and `owe` options) are gone: the parts call the functions behind them.
- The engine allows one hook per event without a matcher in a plugin, so `session.start`, `turn.complete`,
  `prompt.compose`, `agent.spawn` and the catch-all `tool.call` are hooked once, in `hooks/register.tsx`, which hands
  each part its share in a fixed order. A part hooks only what is its own (its tools, its command, its pane).
- Past an import the engine follows `$` only into function declarations, so every helper a part exports, and every
  helper those reach, is a `function`, never an arrow bound to a `const`.
- The state contract is one, its keys prefixed by part (`elrondPlan`, `fellowshipQuests`, …).
- A plugin's `$.store` is a file keyed by its id. On its first start the plugin carries the `plan:` and `quest:` entries
  of the old `elrond` and `fellowship` stores into its own, overwriting nothing; the old files are left as they are.
- One crossing remains: the Argonath asks Andúril's diff of a command-line tool through `$.mcp.call`.
- The tests are one suite. A test's `$` is not a plugin's, so a test drives the parts through their tools, commands and
  the agents' turns, as the session would; what only a part reads of another is tested as pure functions.
- Andúril's PATH prelude, which breaks allow rules such as `Bash(narsil:*)`, is a separate decision.
