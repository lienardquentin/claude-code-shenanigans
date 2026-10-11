# claude-code-shenanigans

Personal Claude Code mods and experiments.

## Mods

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
- A drawing taller than the pane scrolls with the pane's own keys (while it is focused). One wider than the pane is
  shown through a window: `◀ Left` and `Right ▶` move it, `Fit width` closes the nodes up first (it only helps a
  top-down or bottom-up flow), and pressing a node cut by the edge brings its whole box into view. A new width
  redraws within it, and a different diagram starts from the left.
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

On the desktop app, VS Code and mobile it shows the fallback view: the diagram as a still picture (SVG, the rows of
the drawing set in a monospace font; the selection is bold) with one button per node under it, and the pane says so.
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
  a hotkey (digits `1`-`9` forward, letters `a`-`i` back, in the order the edges are written), so a flow can be walked
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

Not yet: pixel images for the drawing (#15, optional).

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
