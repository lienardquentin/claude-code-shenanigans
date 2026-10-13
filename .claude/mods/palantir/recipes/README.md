# Reporting renders to palantir

palantir reads logs. A frontend's renders are in no log until the frontend writes them there, as one JSON line per
chain:

```
{"palantir":"render","component":"Cart","chain":["items (ref) set","total (computed)","Cart"],"values":["[3] (was [2])","42",null],"count":3}
```

`chain` is what changed, through what, down to the component that rendered; `values`, which may be left out, is
what each step held the last time, as short text, one for one with the chain and `null` where it is not known;
`whole`, which may be left out too, is the same value as JSON text of 2000 characters at most, where the short one
leaves some of it out (the row then opens on it, as formatted JSON); `component` is the component of the app's own source the render belongs to; `count` is how many times since the
last line; a `time` in milliseconds is used when there is one. Such a line is counted (`mcp__palantir__renders`,
the pane's Renders view) and kept out of the timeline. Any framework that can say why it rendered can write it.

## Reporting the page

The page itself is in no log either. A frontend reports it as one JSON line, written again when the page has
changed:

```
{"palantir":"dom","url":"/cart","title":"Cart","elements":[[0,"body","","",""],[1,"main#app","role=\"main\"","","App"],[2,"h1","","Your cart",""]],"left":0}
```

An element is `[depth, tag, attributes, text, component]`: how deep it is nested (each comes after the one that
holds it), what it is (`main#app.grid`), what it is to a reader (`role="button" aria-pressed="true" disabled`),
the text it holds itself, and the component of the app's own it is the outermost element of, or `""`. `left` is
how many elements were left out. palantir keeps the last such line of each app and shows it in the pane's Renders
view, under DOM, as a tree; the line is kept out of the timeline.

## Nuxt (Vue 3.5)

Copy the files of `nuxt/` into the app, at the same paths:

| File | What it does |
| --- | --- |
| `app/utils/renders.ts` | Listens for every component's render trigger and builds the chains, with the value each state and prop held: said to two levels and cut short, and `***` for one that goes by a secret's name. Development only: Vue names no trigger in a production build. |
| `app/plugins/renders.client.ts` | Starts it in the browser and posts the chains to the app's own server every two seconds. |
| `server/api/renders.post.ts` | Writes them to the server's log, which is the file palantir watches. |
| `app/utils/dom.ts` | Reads the page's elements when something on it changed, three seconds apart at most: 300 at most, no script or style, a drawing as one element, and never what a field holds. |
| `app/plugins/dom.client.ts` | Starts it once the page is drawn, in development, and posts the page to the app's own server. |
| `server/api/dom.post.ts` | Writes it to the server's log. |

What changed is said by its name: a binding of the component's setup or of one above (`beacons (ref)`), a field
of what a composable handed back there (`cart.items`), what a component above provided (`provided theme`), what
Nuxt fetched or shares (`useFetch data`, `useAsyncData "user" data`, `useState "cart"`), a component's own `attrs`
and `slots`. Only what none of these holds is left as `a ref` or `a reactive object`.

A render that happens inside a library's component (a card drawing the slot it was given) is counted against the
component of the app's own source that holds it, and the chain ends on the library's component.

For a plain Vue app, `reportRenders(app, send)` from `renders.ts` is all there is to call, with a `send` that
gets the chains to wherever the log is written.
