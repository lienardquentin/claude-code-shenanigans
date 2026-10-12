# Claude Code Shenanigans

Personal Claude Code mods. The mermaid mod shows diagrams in a pane and lets the reader act on their nodes.

## Language

**Mod**:
A plugin that changes Claude Code's own interface or behaviour, here mostly a pane opened by a slash command.
_Avoid_: Extension, add-on

**Surface**:
Where a session is drawn: the terminal, the desktop app, VS Code or mobile. Each draws a different set of elements.
_Avoid_: Client, platform, frontend

**Diagram**:
One Mermaid source shown in the pane as nodes and edges.
_Avoid_: Chart, graph, figure

**Node**:
A box in a diagram that stands for one thing and has a label.
_Avoid_: Vertex, box, item

**Click directive**:
A Mermaid `click` line in the diagram's own source that attaches a link or a file to a node.
_Avoid_: Link, hyperlink

**Selected node**:
The node the reader last clicked: highlighted, with its connections listed in the details area.
_Avoid_: Active node, focused node

**Fallback view**:
How a diagram is shown on a surface that cannot draw clickable nodes itself: a still picture plus a button per node.
_Avoid_: Degraded mode

**Run**:
One feature taken from an idea or an existing issue to a pull request by the workflow mod.
_Avoid_: Job, pipeline, session

**Feature issue**:
The single GitHub issue a run starts from, or opens from its spec at the checkpoint, closed by the run's pull request.
_Avoid_: Parent issue, epic

**Spec**:
The document that states what a run builds, written locally; a run that started from an idea publishes it as its feature issue.
_Avoid_: PRD, plan

**Ticket**:
One local file describing a vertical slice of a spec, with the tickets that block it.
_Avoid_: Task, sub-issue, step

**Run card**:
A run's card in the workflow pane: its standing, quota and actions, with a ticket card for each of its tickets nested inside.
_Avoid_: Issue card, run row

**Ticket card**:
One ticket drawn inside its run card: number, title, state, what blocks it, how far it got, and its reach and outward actions.
_Avoid_: Ticket row, ticket line

**Checkpoint**:
A point in a run where it stops for the user's decision.
_Avoid_: Gate, approval step

**Blast radius**:
What building a ticket is estimated to touch, in two parts never folded into one figure: its reach and its outward actions. A run's blast radius is the union of its tickets'.
_Avoid_: Impact, risk score, scope

**Reach**:
The files a ticket expects to change, and the files that depend on them.
_Avoid_: Footprint, surface area

**Outward action**:
Something a ticket expects to do that reaches outside the working tree or is hard to reverse.
_Avoid_: Side effect, dangerous command

**Context budget**:
How much of one context window a phase of a run may fill before its work must move to a fresh window.
_Avoid_: Session usage, token limit

**Quota**:
The plan's usage allowance that a run spends, by time window.
_Avoid_: Session usage, rate limit, credits

**Terminal guide**:
The pane section that names the recommended terminals per operating system and says what the current terminal can do.
_Avoid_: Compatibility list
