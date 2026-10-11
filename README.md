# claude-code-shenanigans

Personal Claude Code mods and experiments.

## Mods

### `ship-flow`

Takes one feature from an idea or a GitHub issue to a pull request. It lives in
[`.claude/mods/ship-flow`](.claude/mods/ship-flow). It automates the flow of the `mattpocock-skills` plugin, with
the spec and the tickets kept as local files under `.scratch/<feature>/` instead of issues.

- `/ship <idea>` or `/ship #<issue>` starts a run: you are grilled about the feature, then a spec and a set of
  tickets are written locally. Nothing is published.
- You read them, change what you like, and approve with `/ship resume`. That is the one checkpoint. A run from an
  idea opens its single GitHub issue then.
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

It needs `gh` signed in, and the `mattpocock-skills` plugin for the grilling. The models and the thresholds are
settings of the mod. The decisions behind it are in [`docs/adr`](docs/adr) (0002, 0003) and what was learnt about
the mod API in [`docs/research/ship-flow-mod-api.md`](docs/research/ship-flow-mod-api.md).

Install it from a clone:

```
claude plugin marketplace add <path to this clone>/.claude/mods/ship-flow
claude plugin install ship-flow@ship-flow-mods
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

### `mermaid-view`

A pane that draws a Mermaid flowchart as boxes and arrows. It lives in
[`.claude/mods/mermaid-view`](.claude/mods/mermaid-view). It is being built in slices; see issue #1 for the whole
plan.

What it does so far:

- `/mermaid-view <diagram text>` opens the pane and draws a flowchart in the terminal: `graph TD; A[Start]
  --> B[Process]; B --> C[End]`. Statements are separated by `;` or a new line.
- `/mermaid-view <path>` shows the diagram in a file: a `.mmd` file whole, a markdown file by each of its
  ` ```mermaid ` blocks (the first is shown).
- A ` ```mermaid ` block in one of Claude's own replies is shown as soon as the reply ends (what a subagent hands back
  is not).
- Scrolling. A drawing taller than the pane is the pane's own to scroll: **the mouse wheel**, and the pane's scroll
  keys while it has the focus. A drawing wider than the pane is shown through a window across it: the wheel moves it
  across whenever the pane has nothing to scroll down, and `◀ Left` / `Right ▶` (keys `h` and `l`, also clickable)
  move it, with a line saying which columns show. Pressing or walking to a node cut by the edge brings its whole box
  into view, and the pane is scrolled to it. A new width redraws within it, and a different diagram starts at the
  top left.
- `Open in the browser (rendered by Mermaid)` writes a page (`mermaid-view.html` in the temporary folder, only when
  asked, with the Mermaid library beside it as `mermaid-view-library.js`) and shows its address as a link. The page is
  drawn by the real Mermaid library, so every diagram type and syntax Mermaid knows is drawn, not only what the pane
  draws, with the browser's own wheel, scroll bars and zoom. The library is the copy in `vendor/` (version 11.4.0,
  MIT, checked against the npm registry's integrity value; see `vendor/README.md`). **Nothing is sent to any site,
  and nothing is loaded from one**: the page names no address, and the mod has no network call. If the library
  cannot be run or the source does not parse, the page shows the mod's own drawing instead, where there is one. The
  button is offered for a diagram the pane cannot draw too. On the desktop app the address is shown as text to open,
  as that surface only draws `https` links. Over ssh the page is on the machine the session runs on: copy it
  (`mermaid-view.html` and `mermaid-view-library.js`) to the machine with the browser, or forward a port to a local
  `python -m http.server` in that folder; the diagram never goes through a third party.- `Fit width` (`f`) is on to begin with, and applies only to a drawing that is wider than the pane: the nodes are
  closed up, and then labels are wrapped to narrower and narrower boxes (at spaces, dashes and slashes, and inside a
  word only when nothing wider fits) until it fits. A node's label is wrapped onto more rows, and selecting it
  still names the whole label. What cannot be made narrow enough is shown through the window above.
- Layers are chosen so that a node that only leads somewhere (a source, or a chain that ends far below) stands just
  above what it leads to, not on the first row: a diagram with several entry points is far narrower for it.
- The diagrams of the session are listed under the drawing, newest last, each told apart by its first node labels;
  press one to show it. The list keeps the last twenty, and lives only as long as the session.
- Directions: `TD` and `TB` (the default), `BT`, `LR` and `RL`.
- Nodes are `A`, or with a label (quoted or not) in the shape of the brackets: `A[Label]` rectangle, `A(Label)`
  rounded, `A([Label])` stadium, `A{Label}` diamond, `A((Label))` circle. A label may hold `;`, `&` or `-->`.
- Edges: `-->` arrow, `---` open line, `-.->` dotted arrow, `==>` thick arrow, each with an optional `|label|` after
  it. Edges chain (`A --> B --> C`) and `&` fans out (`A & B --> C & D`). `%%` starts a comment line.
- Edges that skip a layer or go back up run down a lane to the right of the nodes, so they never cross a node.
- A diagram it cannot draw is never drawn wrongly: the pane says why and shows the source. Another kind of diagram
  (`sequenceDiagram`, `classDiagram`, ...) is named; flowchart syntax that is not drawn yet (`linkStyle`, `~~~`,
  two-way arrows, `-- text -->`) is named with its line; anything else says which line it could not read. A diagram
  of more than 200 nodes is shown as source with a note.
- Press a node (click, or Tab to it and Enter) to select it: it and the edges that touch it are drawn in the accent
  color, and the lines under the drawing list what it leads to and where it is reached from. Press it again, or
  `Clear`, to clear the selection.

In the terminal each row of a node's box is a plain `Button`, so a press needs no pointer handling of its own.

On the desktop app, VS Code and mobile it shows the fallback view: the diagram as a vector picture (SVG: a shape for
each node, lines with arrowheads for edges, dashed frames for subgraphs, in the same layout as the cells; light and
dark follow the scheme; the selection is thick and orange) with one button per node under it, and the pane says so.
It is used on the desktop too, because there a plain `Button` is a native button and the box could not be known to
keep its shape; whether the drawn boxes would work there is a manual check not yet made.

- Subgraphs: `subgraph id [Title]` (or `subgraph Title`) ... `end`, nested to any depth, drawn as a titled double-line
  box around their nodes; the nodes of a subgraph stand together in their layer.
- Marking nodes out: `class A,B name`, `A:::name` and `style A ...` draw a node in a theme color. A class named
  `success`, `warning`, `danger`/`error`, `info`, `neutral` or `accent` uses that tone; any other class, and `style`,
  uses the accent color. The colors a source gives (`fill:#f96`) are never read, so no color of the source reaches the
  drawing.

- `click A "https://..."` (also `click A href "..." "tooltip" _blank`) marks a node with `↗`; pressing it shows the
  address as a link, which the surface opens like any link. `click A "src/file.ts"` marks it with `▤` and shows the
  first 40 lines of that file. Only `http`/`https` addresses and relative paths that stay inside the project are
  followed; any other address, an absolute path or a `..` is marked `⊘` and said not to be followed. Nothing is run
  or opened by the mod itself, so a diagram that names an address cannot start anything. `click A call fn()` is
  named as not drawn.
- With a node selected, `Go to` lists the nodes it points to and `Back to` those that point to it, each a button with
  a hotkey (digits `1`-`9` forward, letters `a`-`e` back, in the order the edges are written), so a flow can be walked
  from the keyboard while the pane has focus. Walking keeps the selection and brings the new node into view.
- With a node selected: `Send to Claude` puts a line about it (what it leads to, where it is reached from) in the
  prompt box, ready to finish, and `Copy label` copies its label.

- The `Terminals` button swaps the diagram for a guide: the terminal and system it recognised from the environment,
  what the research file says that terminal can do (pixel images, mouse reporting, clickable links), what it lacks and
  which terminals on this system have it, the terminals recommended on each system (those the file marks `yes` for
  at least two of the three), the file's table for each, and the multiplexer (tmux, screen) it runs inside. A
  terminal the file has no verified identifier for (Apple's Terminal, foot, conhost) is reported as not recognised,
  and nothing is claimed about it.

The guide's data is `hooks/terminals.ts`, generated from [`docs/research/terminal-capabilities.md`](docs/research/terminal-capabilities.md)
and nothing else (`tools/build-terminals.ps1`; run it again when that file changes). A test holds every identifier the
recognition uses to what the file cites for that terminal.

- In kitty and Ghostty (not inside tmux or screen) the diagram is drawn as a picture: the same layout set in a bitmap
  font and drawn lines, as raw pixels in the terminal's `Image`, in the kit palette's gray with the selection in its
  orange. A picture has no press of its own, so a button per node stands beside it; `Picture: on`/`off` turns it
  off for the cells and back. Other terminals keep the cells, but offer `Picture: try`, which draws the picture
  anyway: the platform's `Image` documents kitty-protocol pixels only, so in another terminal (Windows Terminal,
  say, which has sixel) it may show only the drawing's text as its alt. Other surfaces and drawings an `Image`
  cannot take (over 255 cells across or down, 2 MiB of pixels) keep the cells. Characters the 5x7 font does not
  have are drawn as a small box. This has been checked on mounted trees only: how it looks in a real terminal is a
  manual check.

Known limits of the drawing: when a node's outgoing line
and an arriving line fall in the same column, the picture can show a connection that is not there; node order is
by a single downward pass, so crossings are not minimised.

Install it from a clone:

```
claude plugin marketplace add <path to this clone>/.claude/mods/mermaid-view
claude plugin install mermaid-view@mermaid-view-mods
```

Then open the pane with `/mermaid-view <diagram text>`.

#### Why it draws flowcharts itself

It parses and lays out flowcharts with its own code instead of the official Mermaid renderer, so it knows where every
node is (needed for clicking). See [the decision](docs/adr/0001-own-flowchart-layout-engine.md).

#### Development

```
claude plugin validate .claude/mods/mermaid-view
claude plugin test .claude/mods/mermaid-view
```

The reader is `hooks/diagram.ts` and the layout and drawing `hooks/draw.ts`; the tests drive the mounted pane.
