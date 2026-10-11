# What the mod API lets ship-flow do

Findings from building ticket 02 of `ship-flow` on Claude Code 2.1.296. Each is marked by how it is known:
**declared** (read in the engine's type declarations), **tested** (seen through `claude plugin test`), or **live**
(seen in a real session). Nothing here is marked live yet: see "Still to prove".

## The engine's `$` stays in the hooks module (tested)

`claude plugin validate` refuses a hooks module that passes `$` to a function imported from another file: `$` is
followed only into functions declared in the file that receives it. `ship-flow` therefore builds a plain `Host`
object of closures over `$` in `register.ts` and writes every other module against that.

## Files

- A path the mod gives relative to the working directory reaches the bottom of the chain absolute, in the
  machine's own spelling (`C:\...\.scratch`). (tested)

## Commands on the host

- `$.process.run(argv, { timeoutMs })` starts a process with no shell. The timeout is 30 seconds unless given and
  ten minutes at most; past it the call rejects. (declared)
- A verification command is a shell line, so the run hands it to `cmd /d /s /c` on Windows and `sh -c` elsewhere,
  telling the two apart by how the working directory is spelled. (tested as far as the arguments; not live)
- Git started this way runs with the repo's own hooks off. (declared)
- A hook has ten seconds of its own time per dispatch, and time spent waiting on a `$` call does not count. Waiting
  minutes on a verification command inside a `turn.complete` hook is therefore within budget. (declared)

## Subagents

- `$.agent.register({ name, prompt, tools, model })` declares the type `<plugin>:<name>`. A call to a tool outside
  `tools` is refused by the engine. (declared)
- `$.agent.spawn({ subagentType, description, model, prompt })` resolves once the subagent has started, with its
  `agentId`. The subagent's end is a `turn.complete` event carrying that `agentId`, its `reason` (`answer`,
  `aborted`, `refusal`, `error`), its `answer` and its `usage`. (declared)
- In `claude plugin test` the spawn's answer carries no `agentId`, whatever the test's hook returns, and the test's
  hook receives the spawn spelled as the Agent tool's call (`subagent_type`, `run_in_background`). The run
  therefore also finds its implementer through `$.agent.list()`, by type and running status. (tested)
- An `agent.offer` hook answering `{ isOffered: false }` keeps the type from the model while the mod's own spawn
  still runs it. (declared)

## Permissions

- `tool.check` is the permission decision for one tool call and carries the `agentId` of the loop that made it. A
  hook may answer `allow`, `ask` or `deny`. `ship-flow` answers for its implementer's calls alone and passes every
  other call on, so an implementer is never asked anything and never runs a command outside its list. (tested)

## Usage

- `$.session.usage()` answers the main window's `context.percent` and each quota window as
  `{ kind, percentUsed, resetsAt }` (`five_hour`, `seven_day`). `rateLimits` is empty off a subscription.
  (declared)

## For ticket 05: measuring and stopping a running subagent (declared, not exercised)

- A `turn.step` event carries the subagent's `agentId` and `turnId`, and its stream ends with a `stop` chunk whose
  `usage` holds the step's token counts. A subagent's context fill can therefore be read as it works.
- `$.turn.abort({ turnId })` exists, so a subagent's turn can be stopped; its `turn.complete` then has the reason
  `aborted`, which the run already treats as a failed attempt.
- A caution from the declarations: a subagent a hook spawned "steps past that hook, as its tool calls do". The
  hook that calls `$.agent.spawn` may not see that subagent's steps. Ticket 02 spawns from the `command.run` hook
  and watches from the `tool.check` and `turn.complete` hooks, which are different hooks. Ticket 03 will spawn the
  next ticket from inside `turn.complete` and must check that the next subagent's end is still seen.

## Still to prove

A live run of `/ship resume` on one ticket, to confirm in a real session: the registered type spawns on the asked
model, `tool.check` decides the implementer's calls with no prompt, the verification command runs through the
shell, the commit is made, and the usage reading is non-empty.
