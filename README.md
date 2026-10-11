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

- `/mermaid-view <diagram text>` opens the pane and draws a top-down flowchart in the terminal: `graph TD; A[Start]
  --> B[Process]; B --> C[End]`. Statements are separated by `;` or a new line.
- Directions: `TD` and `TB` (the default), `BT`, `LR` and `RL`.
- Nodes are `A`, or with a label (quoted or not) in the shape of the brackets: `A[Label]` rectangle, `A(Label)`
  rounded, `A([Label])` stadium, `A{Label}` diamond, `A((Label))` circle. A label may hold `;`, `&` or `-->`.
- Edges: `-->` arrow, `---` open line, `-.->` dotted arrow, `==>` thick arrow, each with an optional `|label|` after
  it. Edges chain (`A --> B --> C`) and `&` fans out (`A & B --> C & D`). `%%` starts a comment line.
- Edges that skip a layer or go back up run down a lane to the right of the nodes, so they never cross a node.
- Source it cannot read (an unknown direction, `~~~`, other syntax) is shown with the statement it stopped at,
  instead of a wrong picture.
- Press a node (click, or Tab to it and Enter) to select it: it and the edges that touch it are drawn in the accent
  color, and the lines under the drawing list what it leads to and where it is reached from. Press it again, or
  `Clear`, to clear the selection.

In the terminal each row of a node's box is a plain `Button`, so a press needs no pointer handling of its own.

On the desktop app, VS Code and mobile it shows the fallback view: the diagram as a still picture (SVG, the rows of
the drawing set in a monospace font; the selection is bold) with one button per node under it, and the pane says so.
It is used on the desktop too, because there a plain `Button` is a native button and the box could not be known to
keep its shape; whether the drawn boxes would work there is a manual check not yet made.

Not yet: subgraphs, `classDef`/`style`, click directives, a terminal guide.

Known limits of the drawing: a diagram wider than the pane is not scrolled or fitted; when a node's outgoing line
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
