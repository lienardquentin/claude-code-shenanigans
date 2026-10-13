# Renders, the page and what is done on it, read from the browser

Why a frontend's components render, and how its page stands, are in no log. palantir asks the browser itself, over
the DevTools protocol of a Chrome started with a debug port, and the app holds nothing for it: no plugin, no
endpoint, no line in its log.

```
 palantir --> node browser/ask.mjs --> Chrome's debug port, 127.0.0.1:9222 --> each tab --> browser/page.js
```

At each read (the pane's timer, Refresh, the Renders view, a tool that asks of the page), [`ask.mjs`](ask.mjs)
lists the tabs and runs [`page.js`](page.js) in each one that shows a page over http, then asks the tab what its
console holds. What comes back is read as what a log says:

| What | Tool | In the pane's Renders view |
| --- | --- | --- |
| Why components rendered, and which renders came with nothing changed | `mcp__palantir__renders` | Tree (`t`) |
| What the last edit did to the renders | `mcp__palantir__renders_since_edit` | |
| The page's elements, and what a reader who does not see it cannot use | `mcp__palantir__dom` | DOM (`d`) |
| What was done on the page and what followed, across every watched app | `mcp__palantir__interactions` | Actions (`a`) |
| What the page asked for and how it loaded | `mcp__palantir__network` | Network (`n`) |
| The errors and warnings of the page's console | `mcp__palantir__logs`, `mcp__palantir__errors_since_edit` | the timeline, led by `in the page:` |

## End-to-end scenarios

The pane's Tests view (`x`) has two tabs: E2E (`1`), a checklist of what a person does on the frontend, run on the
page, and Unit tests (`2`), below.

| What | Tool | In the E2E tab |
| --- | --- | --- |
| Claude writes the checklist: each scenario's steps and what must be seen at the end | `mcp__palantir__e2e_plan` | Plan (`p`) asks Claude for it |
| Scenarios are run, all or the ones named | `mcp__palantir__e2e_run` | Run all (`g`), Run the ones not passed (`f`) |
| What came of each, with what its subagent reported | `mcp__palantir__e2e` | a row per scenario, why it failed under it; a row opens on its steps and the report |
| The run is stopped | `mcp__palantir__e2e_stop` | Stop (`s`) |
| Claude is asked to fix what failed, then to run it again | | Fix with Claude under a failed scenario, Fix all with Claude (`a`) when several failed |

Each scenario is run by a subagent of its own, of the type `palantir:e2e`: on Haiku, with the session's tools less
those that change the project (`Edit`, `Write`, `NotebookEdit`, `Bash`, `Agent`), so it drives the page with
whatever browser tools the session has (a Chrome DevTools MCP server on the same debug port) and reads what
followed with palantir's own. It sees nothing of the conversation: only the scenario and the address of the app's
tab. They run one after another, as they share the page. The browser is asked before a run starts: where no Chrome
answers on the debug port, the scenarios are said blocked on that and no subagent is started. A subagent ends on `VERDICT: pass`, `fail: <why>` or
`blocked: <why>`; one that gives none, is interrupted or does not start leaves its scenario blocked. Stop empties
the queue and gives up on the scenario that runs; its subagent is not ended, and what it answers later is dropped.
The type is not offered to the model: a scenario is started through the checklist alone. The checklist is the
session's, and is gone with it.

## Unit tests

The Unit tests tab of the Tests view holds the project's unit test suites, each a command read by how it exits.

| What | Tool | In the Unit tests tab |
| --- | --- | --- |
| Claude names the suites: a command each, as a list of arguments, and the folder it runs in | `mcp__palantir__unit_plan` | Plan (`p`) asks Claude for it |
| Suites are run, one after another | none: the person runs them | Run all (`g`), Run the ones not passed (`f`) |
| How each stands, and the end of what a failing one printed | `mcp__palantir__unit` | a row per suite; a row opens on its command and its output |
| Claude is asked to fix what failed | | Fix with Claude under a failed suite, Fix all with Claude (`a`) |

A suite passes on exit 0, fails on any other, and is blocked when its command does not start or runs past ten
minutes. A command is a list of arguments that must end by itself: no pipe, no `&&`, no watch mode. A suite runs
only when the person presses Run, having seen its command on its row; palantir gives Claude no tool that runs one.

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
- **Which renders came with nothing changed.** A chain whose values say what they were before (`6 (was 6)`) and
  say the same on both sides, or whose values are those of the asking before, rendered with nothing new to show:
  a list fetched again and found the same, a prop handed a new object that holds what the old one held. Those are
  counted beside the chain (`x224 (200 with nothing changed)`, `200 unchanged` in the pane, in the warning tone
  where they are half its renders or more). It is told from one asking to the next, so two changes that cancel
  out between two askings are taken for none.
- **Where each component is written**: the source file Vue names for it in development, said under the renders
  and with the page's elements.
- **What an edit did.** When an edit is routed to the app, what each chain, each address and the page's figures
  came to is kept. After it, a chain is `new` (first seen since), `gone` (rendered before, not since), or said
  with how often it renders now against before (`more`, `less`, `same`, a quarter either way), once ten seconds
  have passed on each side.
- **What was done on the page**, for any page: a click, a form sent, a field changed, a move to another address,
  each with what it was done to (`button "Light Halifirien"`, never what a field holds) and the component it
  was done in. A field is said by its label, a form by its name or its first label or heading. A click on what is
  not made to be clicked and shows no hand is none; the click that sends a form is said as the sending (`submit
  form "Spears" with button "Send"`). What follows within a second and a half, or until the next thing done, is
  its doing: the components that rendered and how often (what a library's component is made of left out), what
  the page asked for. It is handed over once that time has passed, and palantir adds what the watched apps wrote
  in the two seconds after, so one click reads from the page to the backend. Where lines name a path the action
  asked for (as the page knows it, or without its first parts: `/api/realm/beacons` is `/beacons` to the server
  behind), those lines are said, with the ones that share their request id (`rid=`, `request_id=`, `trace_id=`)
  and what the page's console said; what other requests wrote in that time is counted, not said.
- **What it asked for**, for any page: each `fetch` and XHR the browser timed, as its path and the names of what
  it was asked with (never their values), its status and how long it took. The browser keeps the last ones it
  timed before the first asking, and those are read too. What the development server's own tools ask for
  (`/_nuxt/`, `/@vite/`, Nuxt's icons) is left out. Another site's status is told to a page only where that site allows it:
  `not told` otherwise.
- **How it loaded**, for any page: the first byte, the largest paint, the load, how much the layout moved by
  itself, the slowest answer to a click or a key, and the tasks that held the page for over 50 ms. They are one
  load's figures: to measure an edit, load the page again after it.
- **What its console holds**, for any page: errors, failed assertions and warnings (a Vue warning and a hydration
  mismatch are among them), uncaught errors and rejections, and what the browser itself logs of a file that did
  not load. `ask.mjs` asks the tab for them over the protocol (`Runtime.enable`, `Log.enable`), which hands over
  what the console already holds, so what went wrong while the page loaded is read though nobody was asking
  then. Nothing of the console is wrapped. Each is a line of the app's own timeline, an error counted as its
  errors are: `mcp__palantir__errors_since_edit` says the ones an edit brought.
- **What a reader who does not see the page cannot use**: a button or a link with no name, an image with no
  `alt`, a field with no label, an id used twice, a page that names no language or has no `h1`. Thirty at most.
- **Its elements**, for any page: 300 at most, no script or style, a drawing as one element, the component each is
  the outermost element of, and never what a field holds.

What changed is said by its name: a binding of the component's setup or of one above (`beacons (ref)`), a field
of what a composable handed back there (`cart.items`), what a component above provided (`provided theme`), what
Nuxt fetched or shares (`useFetch data`, `useAsyncData "user" data`, `useState "cart"`), a component's own `attrs`
and `slots`. Only what none of these holds is left as `a ref` or `a reactive object`.

A chain ends on a component the app's source writes: one of its own, or a library's that stands in one of its
templates (`UButton`, in a card's slot too). What a library's component is made of is never a chain of its own:
its renders are counted on the chain of the written component that holds it, as `inside` (`x2 (+15 inside)`, `×2
+15 inside` in the pane). One that renders for a reason no state of the app's is behind (a toast's bar that
ticks, what the library hands its own parts) is counted inside the written component alone (`x0 (+594 inside)
UApp`): a chain of a library's part is said only where a binding of the app's own, something Nuxt fetched or
shares, or a prop a written component handed is what changed. A card that draws the slot it was given, where the state is read, ends the chain on the
card. Every chain is counted against the component of the app's own source it happens in.

Vue names one trigger per component and round of rendering: of two states set together, the first is the one said.

Two tabs that show one app are both counted, and the page kept is the one in view.

A chain last seen before the page was loaded is of a page that is gone: it is left out of the renders and counted
in a line under them (`renders_since_edit` still measures across a reload). When the page was read from the
browser and no tab shows it now, each tool says so under the app's name: what follows is what was last read.

## Apps, brokers and databases

What is watched is one of three kinds, told by the image it runs, off what its status command already prints:
nothing is set for it. A broker is a Redpanda or a Kafka image, a database a PostgreSQL one (`postgres`,
`postgresql`, `postgis`, `timescaledb`, `pgvector`), an app anything else. A log file names no image and is an app.

Where they are not all apps, the pane draws each kind in a table of its own, under its name (Apps, Brokers,
Databases), the last two with what they run; a broker's row says how many topics it holds and how far behind its
groups are in all. The summary counts each kind, the filter row lists them in that order, and
`mcp__palantir__status` answers under the same three names. A database is told apart and watched as an app is (its
log, its state, what it consumes, its environment); nothing is asked of it yet.

## A broker

A broker has what it holds read too, through its own command line, run inside it (`docker exec`, `docker compose
exec`, `kubectl exec`): the one thing palantir runs inside what it watches, and only commands that read.

| What | Tool | In the pane's Broker view (`b`) |
| --- | --- | --- |
| The topics, with how many records each holds | `mcp__palantir__broker` | a row per topic |
| The last messages of a topic: key, headers, value, secrets taken out | `mcp__palantir__broker` with `topic`, and `grep` to search them | a topic's row, pressed, opens on its last ten of each partition; pressed again, closes. Read again with the broker while the view is on it |
| The consumer groups: state, members, lag, and partition by partition where records wait | `mcp__palantir__broker` | a row per group |
| A broker with a group behind | `mcp__palantir__status` | the Lag of its row |

- **Only Redpanda is read**, through `rpk` (`rpk topic describe`, `rpk group describe`, `rpk topic consume`). A
  Kafka image (`apache/kafka`, `cp-kafka`) is known for a broker and said not read; its log is read as any other.
- **Lag** is how many records wait to be read. A group with records waiting that has marked none as read for
  thirty seconds is said to have taken nothing for that long: stuck on a record, or gone. One that still takes
  some is only slow. It is told from one read to the next, and the broker is asked every fifteen seconds.
- **A group whose last member left** is told in a toast, once. The broker itself says so only once the member's
  session has run out, 45 seconds by default.
- **What an edit did.** A broker is nobody's source, so an edit routed to any watched app keeps each group's lag
  as it stood, and the lag is then said against it: what one app sends is what another reads.
- **The last records** are read as no group, so nothing is marked as read and no group is moved. `rpk` is told to
  wait for as many records as the topic's partitions hold of the last ones, so that it ends by itself.
- palantir writes no record and moves no group: a poison record is produced, and a group moved past it, by hand.

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
how many renders of the last component's own parts came with those; `file`, which may be left out, is where the
component is written; a `time` in milliseconds is used when there is one. An app that writes them while its page is also read from the browser is counted twice.

The page is one JSON line, written again when the page has changed:

```
{"palantir":"dom","url":"/cart","title":"Cart","elements":[[0,"body","","",""],[1,"main#app","role=\"main\"","","App"],[2,"h1","","Your cart",""]],"left":0}
```

An element is `[depth, tag, attributes, text, component]`: how deep it is nested (each comes after the one that
holds it), what it is (`main#app.grid`), what it is to a reader (`role="button" aria-pressed="true" disabled`),
the text it holds itself, and the component of the app's own it is the outermost element of, or `""`. `left` is
how many elements were left out. `issues`, which may be left out, is what a reader who does not see the page cannot
use, each `[what is wrong, tag, component]`, and `files` where each component is written, by its name.

The rest is a JSON line each too:

```
{"palantir":"action","at":1791892034014,"kind":"click","what":"button \"Add\"","component":"Cart","renders":{"Cart":3},"requests":["200 /api/cart 41ms"]}
{"palantir":"request","url":"/api/cart","status":200,"ms":41,"at":1791892034020}
{"palantir":"vitals","loadedAt":1791892029005,"ttfb":40,"lcp":310,"load":420,"cls":0.021,"inp":80,"longTasks":1,"longMs":120}
```

None of these lines is kept in the timeline. An error of the page is an ordinary line of the log.
