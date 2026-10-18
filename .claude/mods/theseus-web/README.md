# Theseus web view

The source of `/theseus ui`'s page: a run live as its graph, played again from its views, and the history of every run.
It is built into one self-contained page, `../theseus/ui/dist/index.html`, which the plugin ships beside its server
(`../theseus/ui/server.mjs`); this folder is not part of the plugin, so an install copies none of its dependencies.

React, React Flow (`@xyflow/react`) for the graph, elkjs for its layout, Framer Motion for what moves. The page
reads the view model the plugin writes (`../theseus/core/view.ts`, imported as it is), so it draws what the terminal
draws and derives nothing of its own.

```sh
npm install
npm run build        # writes ../theseus/ui/dist/index.html; commit it with the source that made it
npm run typecheck
npm test             # the server's tests, then the page in Chromium (npx playwright install chromium once)
node tests/shot.mjs <folder>   # screenshots, light and dark, of the page on a fixture run
```

The page fetches nothing from outside the machine: its scripts and styles are inline, its Content-Security-Policy
allows its own server alone, and a test fails on any request that leaves 127.0.0.1.
