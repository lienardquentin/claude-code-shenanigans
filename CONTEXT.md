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

**Terminal guide**:
The pane section that names the recommended terminals per operating system and says what the current terminal can do.
_Avoid_: Compatibility list
