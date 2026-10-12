# claude-code-shenanigans

Personal Claude Code mods and experiments.

## Mods

Claude sees nothing of a pane by itself, so every mod that opens one also serves it as a tool, `mcp__<mod>__pane`
(`mcp__ship-flow__pane`, `mcp__termaid-view__pane`, `mcp__timeline-view__pane`, `mcp__http-log__pane`, `mcp__renovate-desk__pane`). It answers
whether the pane is open, then its latest drawing as text: the tree you see, so your selection, page and filter are
in it. Ask Claude about "the pane" and it can read it.

### `ship-flow`

Takes one feature from an idea or a GitHub issue to a pull request. It lives in
[`.claude/mods/ship-flow`](.claude/mods/ship-flow). It automates the flow of the `mattpocock-skills` plugin, with
the spec and the tickets written as local files under `.scratch/<feature>/`, and the tickets never published.

- `/ship <idea>` or `/ship #<issue>` starts a run: you are grilled about the feature, then a spec and a set of
  tickets are written locally. Nothing is published.
- You read them, change what you like, and approve with `/ship resume`. That is the one checkpoint. A run from an
  idea opens its single GitHub issue then, with the spec as its text.
- From there the run is unattended, on a branch `ship/<feature>`: each ticket is built by a fresh subagent in a git
  worktree of its own (`.scratch/<feature>/trees/<NN>`), the run executes the spec's verification commands there
  itself, commits, and puts the commit on the run's branch. Work that does not pass is kept for the ticket's one
  retry to put right; a ticket that fails twice is marked `blocked` while the rest go on.
- Tickets whose blockers are done and whose `**Touches:**` do not overlap are built side by side, three at once
  unless the setting says otherwise. A commit that finds the branch moved by a ticket built beside it is rebased
  onto it and verified again before it lands; one that conflicts is built anew, at no cost to its attempts.
- At the end the branch is reviewed once and fixed once, in a worktree too, pushed, and a pull request is opened
  whose body says what was built and how that compares with each ticket's estimate, what was not built and why, what
  the review found, and what the run spent of your quota. It is a draft when any ticket is unfinished. Nothing of a
  run is built or reset in your own working tree.
- `/ship resume` on a run whose pull request is open follows up its failing checks and new comments.
- The run keeps its own budget: no ticket starts when the 5-hour quota window is nearly spent (it pauses and goes
  on by itself after the reset, in a later session too), and an implementer that fills too much of its context is
  stopped and its ticket marked `too-large`.
- `/ship status` shows every run of the repo, ticket by ticket, and `/ship pane` shows the same live in a pane,
  with buttons to take a run up or stop it. `/ship stop` stops a run; `/ship clean <feature>` removes its folder,
  worktrees and ticket branches.
- Tickets declare what they expect to touch (`**Touches:**`) and what they do that reaches outside the working tree
  or is hard to reverse (`**Outward actions:**`). The pane, `/ship status` and the checkpoint show the run's blast
  radius, an estimate: its reach (files, their dependents, tests) and its outward actions, kept apart. It informs
  and holds nothing back.

It needs `gh` signed in, and the `mattpocock-skills` plugin for the grilling. The models and the thresholds are
settings of the mod. Its own [README](.claude/mods/ship-flow/README.md) has the commands, the ticket format and the
settings in full. The decisions behind it are in [`docs/adr`](docs/adr) (0002, 0003, 0004) and what was learnt about
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
- A "Theme" picker paints the drawings in one of termaid's color themes (`default`, `terra`, `neon`, `mono`, `amber`,
  `phosphor`, `gruvbox`, `monokai`, `dracula`, `nord`, `solarized`), or `none` for the plain drawing. The colors are
  termaid's own, handed to the pane as data: termaid's command line drops them when piped, so a themed drawing comes
  from its Python API through the script in `hooks/themed.ts`. The theme stays while paging, for the session.
- In the terminal a reply's diagrams are drawn in the transcript too: each Mermaid block termaid has drawn is
  replaced by its drawing, in the pane's theme, under the text the reply opens with. A block not drawn yet, or that
  cannot be drawn, stays as the reply wrote it. "Hide in chat" in the pane turns this off for the session.
- On the desktop app, VS Code and mobile a diagram is a picture: Mermaid's own drawing, as an SVG, in the pane and in
  the transcript in place of its block. The [Mermaid CLI](https://github.com/mermaid-js/mermaid-cli) draws it on this
  machine, in an Edge, Chrome or Chromium already installed (headless: no window opens, and no browser is
  downloaded). The diagram is written to a temporary folder removed after the run; nothing of it leaves the machine.
  - The "Theme" picker there holds Mermaid's themes (`default`, `neutral`, `forest`, `dark`); paging, "Show source",
    the direction of a flowchart and "Hide in chat" work as in the terminal. Mobile draws no picker.
  - A picture is an image, which takes no press: its linked nodes cannot be pressed where they are drawn. They are
    buttons under the picture instead, each called by its node's label with where it leads (`parse.ts:50`,
    `changes of draw.ts`); pressing one opens its code or its changes in the pane, as in the terminal.
  - A picture over the app's limit for an SVG (131,072 characters) is shown as its source, with a line saying so; so
    is a diagram Mermaid cannot draw, with its message.
  - The pictures are drawn one at a time, a few seconds each. The first one downloads the Mermaid CLI, which takes
    about a minute.
  - Tried in the desktop app; VS Code and mobile take the same path and are not yet tried.

In the terminal it needs [`uv`](https://docs.astral.sh/uv/). The mod runs `uvx termaid==<version>` (the version is fixed in
`hooks/register.tsx`), so **termaid is downloaded from PyPI the first time it is used** and cached by uv after. This
is one of the two places a mod of this repo fetches code from an external site at run time. A theme runs
`uvx --from termaid[rich]==<version> python`, which also downloads [rich](https://github.com/Textualize/rich) and its
dependencies the first time.

Off the terminal it needs [Node.js](https://nodejs.org/) and one of those browsers. The mod runs
`npx -y @mermaid-js/mermaid-cli@<version>` (the version is fixed in `hooks/pictured.ts`), so **the Mermaid CLI is
downloaded from npm the first time it is used** and cached by npm after: the second place this mod fetches code at
run time. Only the CLI's own version is fixed; the versions of what it depends on (Mermaid, Puppeteer) are npm's
pick within the ranges the CLI names. Puppeteer's own browser download is turned off.

Install it from a clone:

```
claude plugin marketplace add <path to this clone>/.claude/mods/termaid-view
claude plugin install termaid-view@termaid-view-mods
```

### `status-line`

One plain-text line under the prompt, with the four things worth knowing and nothing else. It lives in
[`.claude/mods/status-line`](.claude/mods/status-line).

```
claude · main* · Opus 5.5 · 42%
```

- The folder: the last component of the session's working directory.
- The git branch, with a `*` when the tree is dirty (untracked files included); a short commit hash on a detached
  HEAD; a name over 32 characters cut in the middle. Gone outside a git repo.
- The model, as `/model` shows it.
- The context fill, a bare percentage, marked `!` from 60% and `!!` from 85%. Left out until there is a figure.
- A segment with nothing to say is left out with its separator. In a narrow terminal the model goes first, then the
  branch, then the folder; the context fill stays.
- Redrawn at session start, after every tool call, when a turn completes, and every 10 seconds.
- No command and no option: disabling the plugin is the off switch.

Install it from a clone:

```
claude plugin marketplace add <path to this clone>/.claude/mods/status-line
claude plugin install status-line@status-line-mods
```

### `timeline-view`

A pane that draws what a session did over time. It lives in [`.claude/mods/timeline-view`](.claude/mods/timeline-view).

- `/timeline` opens the pane. Each lane is one row of cells over the period shown: the main conversation first, then
  one lane per subagent, from its spawn to the end of its run. A ship-flow run's implementers are subagents, so each
  ticket being built has a lane of its own.
- A cell a tool call ran in is filled, in the color of its kind of work (reads, edits, shell, agents, other), and a
  failed call is red and never painted over. A cell where the lane was at work with no tool running (the model
  thinking or writing) is shaded; an idle cell is a dot.
- Pressing a lane's name lists its calls under the drawing, the latest first: when each started, the tool, what it
  worked on (its command, file or pattern) and how long it took. A turn is listed with its prompt.
- "Show" limits the drawing to the whole session, the latest turn, or the last 5, 15 or 60 minutes. What still runs
  grows every second; a quiet session redraws nothing. "Clear" empties what has ended.
- It records the last 1,500 turns and calls of the session, in the session's memory only: nothing is written to disk
  and nothing leaves the machine. A `/clear` empties it.

Install it from a clone:

```
claude plugin marketplace add <path to this clone>/.claude/mods/timeline-view
claude plugin install timeline-view@timeline-view-mods
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

### `renovate-desk`

A pane that looks after your open Renovate pull requests. It lives in
[`.claude/mods/renovate-desk`](.claude/mods/renovate-desk).

- Sorts them into safe (minor, patch, digest, pin or lockfile update, checks green, mergeable), waiting (checks
  running, or conflicts Renovate rebases itself) and to look at (major, failing or missing checks, a review needed).
- `m` merges every safe one, each with its repo's default merge method and pinned to the commit that was judged. A
  pull request to look at that GitHub would take has a `merge` button of its own.
- Quiet on GitHub: one search request per refresh, only on `/renovate` or `r`, never on a timer; the only write is
  the merge. No comment, no approval, no rebase request.
- Looks at `author:app/renovate user:@me` by default; the `query` option takes other search qualifiers.

It needs the `gh` CLI, signed in. Install it from a clone:

```
claude plugin marketplace add <path to this clone>/.claude/mods/renovate-desk
claude plugin install renovate-desk@renovate-desk-mods
```

Then open the pane with `/renovate`.
