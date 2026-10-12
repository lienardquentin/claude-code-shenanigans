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
