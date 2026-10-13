# Renders and the page, read from the browser

Why a frontend's components render, and how its page stands, are in no log. palantir asks the browser itself, over
the DevTools protocol of a Chrome started with a debug port, and the app holds nothing for it: no plugin, no
endpoint, no line in its log.

```
 palantir --> node browser/ask.mjs --> Chrome's debug port, 127.0.0.1:9222 --> each tab --> browser/page.js
```

At each read (the pane's timer, Refresh, the Renders view, `mcp__palantir__renders`), [`ask.mjs`](ask.mjs) lists
the tabs and runs [`page.js`](page.js) in each one that shows a page over http. What the page answers is counted as
renders (`mcp__palantir__renders`, the pane's Renders view) and kept as the page (the view's DOM).

## What it needs

- A Chrome that listens on a debug port, on the loopback of the machine Claude Code runs on, with the app open in a
  tab. Chrome refuses the port on its default profile: `chrome --remote-debugging-port=9222 --user-data-dir=<a
  folder of its own>`. Where Claude Code runs on a remote machine,
  [`docs/remote-browser.md`](../../../../docs/remote-browser.md) brings the port of your own Chrome there.
- Node 20.10 or later on that machine, for `ask.mjs`.
- The option `browserPort` when the port is not 9222; `0` asks no browser.

The debug port is full control of that Chrome profile: keep personal accounts out of it.

## Which tab is which app

A tab is an attachment's page when its components' source files are under one of the attachment's roots (the
folders after `@` in `.claude/palantir`), which holds whatever port the page is reached on, through a tunnel too.
Failing that, when the page's port is the attachment's (`#port`). A tab that is none of the watched apps is left
alone: nothing is read of it and nothing left in it.

## What a page says

- **Its renders**, for a Vue 3.5 app in development (Nuxt included; Vue names no trigger in a production build).
  The first asking hangs a listener on every component's render effect, kept under `window.__palantir__`, and each
  asking takes the chains counted since the last one. A chain is what changed, through what, down to the component
  that rendered, with the value each state and prop held: said to two levels and cut short, whole beside it where
  that leaves some out, and `***` for one that goes by a secret's name. A page that is reloaded is listened to
  again from the next asking on.
- **Its elements**, for any page: 300 at most, no script or style, a drawing as one element, the component each is
  the outermost element of, and never what a field holds.

What changed is said by its name: a binding of the component's setup or of one above (`beacons (ref)`), a field
of what a composable handed back there (`cart.items`), what a component above provided (`provided theme`), what
Nuxt fetched or shares (`useFetch data`, `useAsyncData "user" data`, `useState "cart"`), a component's own `attrs`
and `slots`. Only what none of these holds is left as `a ref` or `a reactive object`.

A chain ends on a component the app's source writes: one of its own, or a library's that stands in one of its
templates (`UButton`, in a card's slot too). What a library's component is made of is never a chain of its own:
its renders are counted on the chain of the written component that holds it, as `inside` (`x2 (+15 inside)`, `×2
+15 inside` in the pane). A card that draws the slot it was given, where the state is read, ends the chain on the
card. Every chain is counted against the component of the app's own source it happens in.

Vue names one trigger per component and round of rendering: of two states set together, the first is the one said.

Two tabs that show one app are both counted, and the page kept is the one in view.

## From a log instead

A frontend that is not in that Chrome, or of another framework, may write the same to its log, which palantir
reads as it reads what the browser says. A render is one JSON line per chain:

```
{"palantir":"render","component":"Cart","chain":["items (ref) set","total (computed)","Cart"],"values":["[3] (was [2])","42",null],"count":3}
```

`chain` is what changed, through what, down to the component that rendered; `values`, which may be left out, is
what each step held the last time, as short text, one for one with the chain and `null` where it is not known;
`whole`, which may be left out too, is the same value as JSON text of 2000 characters at most, where the short one
leaves some of it out (the row then opens on it, as formatted JSON); `component` is the component of the app's own
source the render belongs to; `count` is how many times since the last line; `inside`, which may be left out, is
how many renders of the last component's own parts came with those; a `time` in milliseconds is used when
there is one. An app that writes them while its page is also read from the browser is counted twice.

The page is one JSON line, written again when the page has changed:

```
{"palantir":"dom","url":"/cart","title":"Cart","elements":[[0,"body","","",""],[1,"main#app","role=\"main\"","","App"],[2,"h1","","Your cart",""]],"left":0}
```

An element is `[depth, tag, attributes, text, component]`: how deep it is nested (each comes after the one that
holds it), what it is (`main#app.grid`), what it is to a reader (`role="button" aria-pressed="true" disabled`),
the text it holds itself, and the component of the app's own it is the outermost element of, or `""`. `left` is
how many elements were left out. Both kinds of line are kept out of the timeline.
