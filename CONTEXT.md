# Claude Code Shenanigans

Personal Claude Code mods. The workflow mod takes one feature from an idea or an issue to a pull request.

## Language

**Mod**:
A plugin that changes Claude Code's own interface or behaviour, here mostly a pane opened by a slash command.
_Avoid_: Extension, add-on

**Surface**:
Where a session is drawn: the terminal, the desktop app, VS Code or mobile. Each draws a different set of elements.
_Avoid_: Client, platform, frontend

**Diagram**:
One Mermaid source found in a reply, shown in the pane as text drawn by termaid in the terminal, and as a picture drawn by Mermaid itself on the other surfaces.
_Avoid_: Chart, graph, figure

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
