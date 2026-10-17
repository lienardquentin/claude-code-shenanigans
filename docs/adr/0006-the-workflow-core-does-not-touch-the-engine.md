# The workflow's core does not touch the engine

The parts of `middle-earth` hold the workflow and the engine's rules side by side: a quest's decisions sit in the same
`register.tsx` files as the hooks, panes and `$` calls that carry them out, and every helper that runs a command takes
`$`. The engine's rules (an agent is held only when spawned inside a hook, `spawn` drops its `cwd`, a command hook
cannot call into the plugin) have shaped the workflow and cost a run of pull requests to work around. They also tie the
workflow to a Claude Code session: none of it can run headless.

So the workflow moves, piece by piece, into a core (`.claude/mods/middle-earth/core/`) that never takes `$`. It is
handed small interfaces instead, starting with `Shell`, which runs a command in the folder it was made for. The mod
implements each with `$` (`shellIn` and `forgeIn` in `hooks/flow.ts`), and a runner outside Claude Code could implement
them with `child_process` and the Agent SDK (#97, #107).

The forge is first (#98): every `gh` and `glab` call, and the reading of what each prints, is one `Forge` with a GitHub
and a GitLab implementation. The rest of the loop follows behind `Git`, `Agents`, `Store` and `Clock` interfaces (#99).

## Consequences

- The core is written in plain names (`Forge`, `readReview`, `refOf`), not the parts' Tolkien ones; the parts are
  renamed as their code moves in (#96).
- What the core does is tested with a faked `Shell` and plain fakes of its other interfaces, not the engine's test kit.
  What the parts read of its answers is still tested through their tools and panes.
- A closure over `$` inside a function declaration is traced by `claude plugin validate` (it reports the call `via` that
  function), so the adapters may hand the core an object whose methods call `$`.
- The engine's rules live in the mod's adapters alone once the loop has moved.
