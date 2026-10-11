# The mermaid-view mod parses and lays out flowcharts itself

`mermaid-view` reads Mermaid flowcharts and lays them out with its own code instead of using the official Mermaid
renderer. The official one needs Node and a headless browser (neither is available to a mod, which runs without a
DOM or Node), and it returns a finished picture with no node positions; clicking a node, highlighting its edges and
walking the diagram by keyboard all need those positions. Owning the geometry makes them the same code on every
surface. The cost is fidelity: only a documented subset of the syntax is drawn, and anything else is shown as source
with a message rather than drawn wrongly.

## Considered options

- **Official `mermaid` / `mmdc`**: full fidelity, but requires Node and Chromium and gives bitmaps or SVG without
  positions we control.
- **A Mermaid-compatible layout package, vendored**: less code to write, but a mod's module may import only from its
  own folder, so it would be copied in and would have to be free of DOM use.
