# The Beacons of Gondor

Two small FastAPI services, a Nuxt frontend and the riders between them: something that runs, logs and breaks, for the `palantir`
mod to watch. Nothing here is meant to be useful; every part of it is there to show one thing the mod does.

| Part | What it is | Port | Its log |
| --- | --- | --- | --- |
| `gondor` | Lights the beacons, gazes into the seeing-stones, sends the Red Arrow to Rohan | 8101 | JSON lines, with plain tracebacks |
| `rohan` | Answers the Red Arrow and musters what spears it has | 8102 | logfmt |
| `anor` | The Steward's stone: a Nuxt page, drawn with Nuxt UI, that lights beacons, gazes and sends the Red Arrow through its own server | 8100 | JSON lines as pino writes them, among Nuxt's own |
| `riders` | Ride to Gondor's door about once a second, one in four by way of Anor, so there is always something being logged | none | plain lines |

## Run it

From the repo's root, with [uv](https://docs.astral.sh/uv/):

```
npm install --prefix beacons/anor
uv run --project beacons python beacons/muster.py
```

The first line is needed once, for Anor; without it the other three start and Anor is left out. The second starts
them all, each writing everything it says to `beacons/logs/<name>.log`, and starts a realm again when
its code changes. Ctrl+C stops them. The page is at <http://127.0.0.1:8100>; its first start takes half a minute. Then `/palantir`
opens the pane: the four are named in
[`.claude/palantir`](../.claude/palantir), each with the folder whose edits count against it.

## Gondor's endpoints

| Endpoint | What it does |
| --- | --- |
| `GET /beacons` | The seven beacons, Amon Dîn to Halifirien, and which are lit |
| `POST /beacons/{name}/light` | Lights one, and says which beacon its watchers look to next |
| `POST /beacons/quench` | Puts them all out |
| `GET /palantiri` | The seeing-stones Gondor knows of |
| `GET /palantiri/{stone}/gaze` | What the stone shows |
| `POST /muster?spears=2000` | Sends the Red Arrow: asks Rohan (`POST /riders/muster`) for that many spears |
| `GET /health` | Whether the realm stands |

Rohan also has `GET /riders`, its éoreds and their spears.

Anor reaches every one of Gondor's endpoints under `/api/realm/…`, each request under an id it hands to Gondor,
which hands it to Rohan. `POST /api/complaints` is where the page reports its own errors, so that what goes wrong
in a browser is in a log. Anor fetches nothing from outside: no web fonts, no telemetry, and its icons come from
the set installed beside it.

## What is wrong with it, on purpose

- **Halifirien cannot be lit.** It is the last beacon, so `gondor/realm.py` has no next one for it: a `KeyError`
  and a 500. This is the bug to have Claude fix.
- **The Ithil-stone is held by the Enemy.** Gazing into it raises `StoneIsWatched`: an error that is meant to stay,
  to stand for what was already wrong before an edit.
- **The Osgiliath-stone is lost** (a 404), and **Rohan has 6000 spears**: asking for more is refused (a 409, which
  Rohan logs as an error and Gondor as a warning).
- **Théoden hesitates** on one errand in five: a slow answer and a warning.
- **The page cannot read a refusal.** Ask for 9,000 spears in Anor: Rohan refuses, and the form reads the refusal
  as if Rohan rode. A `TypeError` in the browser, which the page reports and Anor logs with its stack.
- **Both realms log the Red Arrow**, a bearer token, in clear. It is a stand-in, logged so that a watcher of the
  logs has something to hide.

## What to try with palantir

1. **One timeline.** `/palantir`, then watch the three logs come in as one, each in its own format. Filter to one
   app, or to the errors alone.
2. **One errand across three logs.** Ask Claude: "follow a muster that Rohan refused". Every request carries an
   id (`rid`) from Anor to Gondor to Rohan, so `mcp__palantir__logs` with that id as `grep` is the errand in all
   of them.
3. **Secrets.** Ask Claude what token Gondor sends Rohan. It can only see `***`: the token is taken out before a
   line is kept, drawn or handed to the model.
4. **What an edit broke.** Ask Claude to fix the Halifirien bug. Its edit to `gondor/realm.py` is counted against
   `gondor` alone; `mcp__palantir__errors_since_edit` then tells the errors that came with the edit from the
   Ithil-stone's, which was there before. Break something on purpose (a wrong name in `realm.light`) and a toast
   says so within seconds.
5. **A crash at import.** Put a syntax error in `gondor/app.py`: Gondor does not come back, its log has the
   traceback, and the riders' log fills with riders who found the gate shut.
6. **An error in the browser.** Send for 9,000 spears from the page, then ask Claude why the form did nothing.
7. **What each realm consumes.** The pane's table has a CPU and a Memory column: each realm is found by the port
   named after `#` in `.claude/palantir`, and added up with the processes it started. Ask Claude "which realm is
   the heaviest" (`mcp__palantir__resources`). The riders listen on no port, and the pane says so.
8. **What a realm is configured with.** `v` in the pane, or ask Claude "which Gondor does Anor call"
   (`mcp__palantir__env`). For a local app the answer is read from the env files of its source, here
   `anor/.env`: what a process was started with cannot be read from outside it. That file is not in the repo:
   copy [`anor/.env.example`](anor/.env.example) to it. The Steward's seal in it is a stand-in secret, and shows
   as `***`.
9. **Why a component rendered.** Open the page in a Chrome that listens on a debug port
   ([`docs/remote-browser.md`](../docs/remote-browser.md) opens one), then `c` in the pane, or ask Claude "why
   does the beacon chain keep rendering" (`mcp__palantir__renders`). palantir asks the tab itself, and Anor holds
   nothing for it ([how](../.claude/mods/palantir/browser/README.md)). The beacons are fetched again every three
   seconds, and every lamp renders each time, lit or not. The view is a tree under each component, with the value
   each state and prop held (`t`), or the page's own elements as they stand (`d`).
10. **A realm that falls silent.** Stop the launcher: within two minutes the pane says each log is quiet.
