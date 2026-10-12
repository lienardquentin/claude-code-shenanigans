# claude-code-shenanigans

Personal Claude Code mods and experiments.

## Mods

### `ship-flow`

Takes one feature from an idea or a GitHub issue to a pull request. It lives in
[`.claude/mods/ship-flow`](.claude/mods/ship-flow). It automates the flow of the `mattpocock-skills` plugin, with
the spec and the tickets written as local files under `.scratch/<feature>/`, and the tickets never published.

- `/ship <idea>` or `/ship #<issue>` starts a run: you are grilled about the feature, then a spec and a set of
  tickets are written locally. Nothing is published.
- You read them, change what you like, and approve with `/ship resume`. That is the one checkpoint. A run from an
  idea opens its single GitHub issue then, with the spec as its text.
- From there the run is unattended, on a branch `ship/<feature>`: each ticket is built by a fresh subagent, the run
  executes the spec's verification commands itself and commits, and a ticket that fails twice is marked `blocked`
  while the rest go on.
- At the end the branch is reviewed once, fixed once, pushed, and a pull request is opened whose body says what was
  built, what was not and why, what the review found, and what the run spent of your quota. It is a draft when any
  ticket is unfinished.
- The run keeps its own budget: no ticket starts when the 5-hour quota window is nearly spent (it pauses and goes
  on by itself after the reset), and an implementer that fills too much of its context is stopped and its ticket
  marked `too-large`.
- `/ship status` shows every run of the repo, ticket by ticket, and `/ship pane` shows the same live in a pane,
  with a button to take a run up.
- Tickets declare what they expect to touch (`**Touches:**`) and what they do that reaches outside the working tree
  or is hard to reverse (`**Outward actions:**`). The pane, `/ship status` and the checkpoint show the run's blast
  radius, an estimate: its reach (files, their dependents, tests) and its outward actions, kept apart. It informs
  and holds nothing back.

It needs `gh` signed in, and the `mattpocock-skills` plugin for the grilling. The models and the thresholds are
settings of the mod. The decisions behind it are in [`docs/adr`](docs/adr) (0002, 0003) and what was learnt about
the mod API in [`docs/research/ship-flow-mod-api.md`](docs/research/ship-flow-mod-api.md).

Install it from a clone:

```
claude plugin marketplace add <path to this clone>/.claude/mods/ship-flow
claude plugin install ship-flow@ship-flow-mods
```

### `termaid-view`

A pane that draws the Mermaid diagrams of a session. It lives in [`.claude/mods/termaid-view`](.claude/mods/termaid-view).

- `/termaid` opens the pane on the most recent Mermaid fenced block of Claude's replies in the main conversation.
- In the terminal each diagram is drawn as box-drawing text by [termaid](https://github.com/fasouto/termaid), a
  Python Mermaid renderer, fitted to the pane's width. A drawing still wider than the pane is clipped, with a notice.
  Nothing runs until the pane is open, and a diagram is rendered once per width.
- A diagram that cannot be drawn is shown as its Mermaid source with one line saying why: termaid's own message, a
  timeout (60 seconds), or a failed download of termaid. When `uv` is not installed the line says so and gives the
  command that installs it (the mod never runs it). A failure is kept until the pane is reopened.
- Two actions: the previous and next buttons walk through the session's diagrams, oldest to most recent ("2 of 3"),
  and "Show source" switches the diagram between termaid's drawing and its Mermaid source (the button then reads
  "Show drawing"). The toggle runs no process and keeps its standing while paging. A diagram arriving at the end of a
  turn moves the pane to it.
- On the desktop app, VS Code and mobile the pane shows the Mermaid source, and says that drawing needs the terminal;
  paging works there and the toggle is not shown.

It needs [`uv`](https://docs.astral.sh/uv/). The mod runs `uvx termaid==<version>` (the version is fixed in
`hooks/register.tsx`), so **termaid is downloaded from PyPI the first time it is used** and cached by uv after. This
is the one place a mod of this repo fetches code from an external site at run time.

Install it from a clone:

```
claude plugin marketplace add <path to this clone>/.claude/mods/termaid-view
claude plugin install termaid-view@termaid-view-mods
```

### `http-log`

A pane that logs the HTTP calls a Claude Code session makes. It lives in
[`.claude/mods/http-log`](.claude/mods/http-log).

- A table of every request: time, method, URL, agent, status, duration, and a rate-limit action per row.
- Rate limits by URL regex (calls per minute); a rule that refuses a call denies it with a reason.
- Search, and time-range filters (`10m`, `30m`, `1h` by default; set with the `timeRanges` option).
- Details for the selected call: query parameters, request body, response, the command that made it, each with a
  Copy button; JSON is formatted.
- Sees `WebFetch`, and `curl` / `Invoke-RestMethod` / `Invoke-WebRequest` run from `PowerShell` or `Bash`, including
  requests a script builds itself: a PowerShell wrapper logs the cmdlets in full, and a local logging proxy
  (Python 3, standard library only) sees what other programs send. HTTPS made by those programs is visible as
  host, bytes and duration only.
- Calls older than the `retention` option (an hour by default) are cleaned.

Install it from a clone:

```
claude plugin marketplace add <path to this clone>/.claude/mods/http-log
claude plugin install http-log@http-log-mods
```

Then open the pane with `/http-log`.

#### How it touches your commands

For a shell command that may reach the network, the mod puts one line before it (it loads the wrapper and points
proxy-aware programs at the local proxy). That rewritten command is what Claude Code's permission prompt shows and
what your allow and deny rules are matched against. Commands that cannot reach the network run untouched. Request
and response bodies are written to your temp folder (in a folder private to your user) and to the plugin's store.

#### Development

```
claude plugin validate .claude/mods/http-log
claude plugin test .claude/mods/http-log
```

The proxy and the wrapper are in `tap/`; `hooks/tap.ts` builds the line put before a command and merges what the
taps saw into the call list.
