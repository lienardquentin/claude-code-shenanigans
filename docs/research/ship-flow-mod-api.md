# What the mod API lets ship-flow do

Findings from building ticket 02 of `ship-flow` on Claude Code 2.1.296. Each is marked by how it is known:
**declared** (read in the engine's type declarations), **tested** (seen through `claude plugin test`), or **live**
(seen in a real session; see "The live run" at the end).

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

## Prompts and compaction

- `$.prompt.submit({ text })` hands the model a prompt as a turn of its own, and `$.session.compact({ instructions })`
  compacts the main conversation. Both wait on the session being idle. (declared)
- Called from inside a `command.run` hook, `$.prompt.submit` is refused: "it would wait on the turn this hook is
  holding; submit from a later event". The mod therefore makes both calls from a `$.clock.after(0, ...)` timer,
  once the command's hook has returned. (tested)
- Live, on 2026-10-11: a prompt submitted that way from `/ship <idea>` reached the model as a turn of its own,
  framed by the engine as a message the plugin sent. The compaction has not been seen live.
- A `tool.call` hook narrowed to `Read` sees the main conversation's file reads with their `file_path`; the mod
  uses the model reading one of its own step texts as the sign that the attended phase passed a step. (tested)

## Permissions

- `tool.check` is the permission decision for one tool call and carries the `agentId` of the loop that made it. A
  hook may answer `allow`, `ask` or `deny`. `ship-flow` answers for its implementer's calls alone and passes every
  other call on, so an implementer is never asked anything and never runs a command outside its list. (tested)

## Usage

- `$.session.usage()` answers the main window's `context.percent` and each quota window as
  `{ kind, percentUsed, resetsAt }` (`five_hour`, `seven_day`). `rateLimits` is empty off a subscription.
  (declared)

## Measuring and stopping a running subagent (live)

Two live runs on 2026-10-11, with the context budget set to 1% so that any implementer passes it at once:

- A `turn.step` hook of the mod does see the responses of an implementer the mod itself spawned, each with its
  `usage`. The mod asked for a stop on the first one.
- `$.turn.abort({ turnId })` with the `turnId` those steps carry does not stop a subagent's turn: the implementer
  went on, built its ticket and ended with the reason `answer`.

So the run stops an implementer the one way it controls: once it is past its budget, the mod's `tool.check` hook
refuses every tool it calls, and with nothing left to do it ends its turn. A third live run showed that working:
the implementer's first response carried 11,432 tokens, its tools were refused, it ended its turn, nothing was
committed and its ticket was marked `too-large`. What the declarations said beforehand:

- A `turn.step` event carries the subagent's `agentId` and `turnId`, and its stream ends with a `stop` chunk whose
  `usage` holds the step's token counts. A subagent's context fill can therefore be read as it works.
- `$.turn.abort({ turnId })` exists, so a subagent's turn can be stopped; its `turn.complete` then has the reason
  `aborted`, which the run already treats as a failed attempt.
- A caution from the declarations: a subagent a hook spawned "steps past that hook, as its tool calls do". The
  hook that calls `$.agent.spawn` may not see that subagent's steps. Ticket 02 spawns from the `command.run` hook
  and watches from the `tool.check` and `turn.complete` hooks, which are different hooks. Ticket 03 spawns the
  next ticket from inside `turn.complete`; the live run below shows its end is still seen there. Whether that
  hook would see the subagent's steps is still unknown, and ticket 05 needs them.

## The live run

On 2026-10-11, `/ship resume trial` built a one-ticket run in a real terminal session on Windows (commit
`f977232`, "trial: The trial file exists"). It showed, live:

- The registered type `ship-flow:implementer` spawns from a `command.run` hook, on the asked model: the answer
  named `claude-sonnet-5-5`, the alias `sonnet` resolved.
- The implementer's end reaches the mod's `turn.complete` hook with its `agentId`, and the run found its record by
  that id.
- A verification command handed to `cmd /d /s /c` runs and its exit code is read.
- Git started through `$.process.run` commits under the repo's configured author.
- `$.session.usage()` answers the main window's fill and both quota windows, `five_hour` and `seven_day`, each
  with its reset time.
- A `/ship` answer is shown under the mod's name, so its text reads `ship-flow: <feature>: ...`.

A second live run the same day walked two tickets with no input between them (commits `467f78a` and `6547cf7`).
It settled the caution above: a subagent spawned from inside the `turn.complete` hook has its own end seen by
that same hook, so the run can start each ticket from the end of the one before. Each ticket was built on its
first attempt, so a retry has not been seen live.

A third check the same day set the mod's 5-hour threshold to 20 through its settings and ran `/ship resume trial`
with the window at 29%. It showed, live: a `userConfig` field declared in `plugin.json` (`type`, `title`,
`description`, `default`) can be set by the person and reaches `register(on, options)`; and the run pauses with the
window's reset time read from `$.session.usage()` (`22:11 UTC`, a minute after a `22:10` reset). The timer that
ends the pause, `$.clock.after`, was not waited for: it is tested against the mocked clock only.

Not shown by any of these: whether the implementer's id came from the spawn's answer or from the agent list (the run
accepts either), and a refused command, since the implementer tried none.
