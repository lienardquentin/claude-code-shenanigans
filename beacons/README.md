# The Beacons of Gondor

Two small FastAPI services, a Nuxt frontend, the riders between them, a broker and a database: something that runs, logs and breaks, for the `runtime`
mod to watch. Nothing here is meant to be useful; every part of it is there to show one thing the mod does.

| Part | What it is | Port | Its log |
| --- | --- | --- | --- |
| `gondor` | Lights the beacons, gazes into the seeing-stones, sends the Red Arrow to Rohan | 8101 | JSON lines, with plain tracebacks |
| `rohan` | Answers the Red Arrow and musters what spears it has | 8102 | logfmt |
| `anor` | The Steward's stone: a Nuxt page, drawn with Nuxt UI, that lights beacons, gazes and sends the Red Arrow through its own server, over a map of Middle-earth | 8100 | JSON lines as pino writes them, among Nuxt's own |
| `riders` | Ride to Gondor's door about once a second, one in four by way of Anor, so there is always something being logged | none | plain lines |
| `postgres` | Gondor's archives, a PostgreSQL: which beacons burn (`burning`) and every lighting there was (`lightings`), each under the id of the request that lit it. In containers and in the cluster only | 5432, inside only | its own |
| `redpanda` | The broker, one node that speaks Kafka's protocol: Gondor writes a record to `beacons.lit` for each beacon lit, and Rohan's watchers read them as the group `rohan-watchers`. In containers and in the cluster only | 9092, inside only | its own |

## Run it

From the repo's root, with [uv](https://docs.astral.sh/uv/):

```
npm install --prefix beacons/anor
uv run --project beacons python beacons/muster.py
```

The first line is needed once, for Anor; without it the other three start and Anor is left out. The second starts
them all, each writing everything it says to `beacons/logs/<name>.log`, and starts a realm again when
its code changes. Ctrl+C stops them. The page is at <http://127.0.0.1:8100>; its first start takes half a minute. Then `/runtime`
opens the pane: the four are named in
[`.claude/runtime`](../.claude/runtime), each with the folder whose edits count against it.

### In containers

```
docker compose up --build
```

From the repo's root, where [`compose.yaml`](../compose.yaml) is. One image each for Gondor, Rohan, Anor (a production
Nuxt build) and the riders; they find each other by service name and start in that order, on health checks. The ports
are the same as above, published on the loopback only, so this and `muster.py` do not run together. Everything is said
on stdout: `docker compose logs -f`. `RED_ARROW`, `NUXT_STEWARD_SEAL_SECRET`, `NUXT_PUBLIC_MAPBOX_TOKEN`, `POSTGRES_PASSWORD`,
`RIDERS_PACE` and `WATCH_PACE` are read from the shell or a `.env` beside `compose.yaml`. The broker is a fifth
container, `redpanda`, which the realms reach by name; `muster.py` starts none, and the realms it starts send and
read no tidings unless `KAFKA_BROKERS` names one. The database is a sixth, `postgres`, which Gondor alone reaches
and which keeps nothing when its container goes; `muster.py` starts none either, and the Gondor it starts keeps what
burns in its own memory unless `DATABASE_URL` names one.

### In a cluster

```
devspace run cluster-up
devspace deploy
```

From the repo's root, where [`devspace.yaml`](../devspace.yaml) is, with [k3d](https://k3d.io), `kubectl`, `helm` and
[devspace](https://www.devspace.sh). The first line makes a one-node k3d cluster; the second builds the four images,
pushes them to a registry it keeps in the cluster, and installs the chart in [`charts/beacons`](../charts/beacons): a
Deployment each, a Service for all but the riders, the secrets in a Secret, and the broker and the database as a
Deployment each of their own, pulled as they are. The ports are the same as above,
published on the loopback only by the cluster's load balancer, with no port-forward to keep running; so
`ANOR_PORT=8110 GONDOR_PORT=8111 ROHAN_PORT=8112 devspace run cluster-up` makes the cluster with others when the
containers above are up. `kubectl logs -f deploy/gondor` is what a realm says, `devspace purge` takes
the release away, and `devspace run cluster-down` the cluster.

[`.claude/runtime`](../.claude/runtime) names these four services, the broker and the database; its lines for the logs of
`muster.py` are kept there as comments, for running the realms by hand.

## Gondor's endpoints

| Endpoint | What it does |
| --- | --- |
| `GET /beacons` | The seven beacons, Amon Dîn to Halifirien, and which are lit |
| `GET /beacons/{name}` | One beacon and whether it is lit |
| `POST /beacons/{name}/light` | Lights one, and says which beacon its watchers look to next |
| `POST /beacons/{name}/quench` | Puts one out, and says so; 409 if it does not burn |
| `POST /beacons/quench` | Puts all of them out |
| `GET /palantiri` | The seeing-stones Gondor knows of |
| `GET /palantiri/{stone}/gaze` | What the stone shows |
| `POST /muster?spears=2000` | Sends the Red Arrow: asks Rohan (`POST /riders/muster`) for that many spears |
| `GET /health` | Whether the realm stands |

Rohan also has `GET /riders`, its éoreds and their spears.

Anor reaches every one of Gondor's endpoints under `/api/realm/…`, each request under an id it hands to Gondor,
which hands it to Rohan. `POST /api/complaints` is where the page reports its own errors, so that what goes wrong
in a browser is in a log. Anor fetches nothing it draws with: no web fonts, no telemetry, and its icons come from
the set installed beside it.

## The map

The page has a map of Middle-earth, drawn with [Mapbox GL JS](https://docs.mapbox.com/mapbox-gl-js/). It needs a
Mapbox public token, `NUXT_PUBLIC_MAPBOX_TOKEN` in `anor/.env`; without one the card says so and the rest of the
page works as before. The token is the one thing Anor sends outside: Mapbox checks it and counts each load of a
map. No tile is fetched, since Mapbox has none of Middle-earth: the land, the rivers and the ranges are a sketch
Anor holds itself ([`anor/app/utils/geography.ts`](anor/app/utils/geography.ts)), in miles from Minas Tirith.

- A beacon-hill on the map lights like its lamp in the chain, and the fire's road is drawn between two that burn.
- A ringed stone is looked into from the map, and the map goes to the stone that is gazed into, wherever it was
  chosen.
- When Rohan answers the Red Arrow, its spears ride the Great West Road from Edoras to Minas Tirith.

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
- **Halifirien burns all the same.** Its fire is written to the archives before Gondor looks for the next beacon,
  so the lighting that failed is in `lightings` and the beacon shows lit.
- **Both realms log the Red Arrow**, a bearer token, in clear. It is a stand-in, logged so that a watcher of the
  logs has something to hide.

## What to try with the runtime mod

1. **One timeline.** `/runtime`, then watch the three logs come in as one, each in its own format. Filter to one
   app, or to the errors alone.
2. **One errand across three logs.** Ask Claude: "follow a muster that Rohan refused". Every request carries an
   id (`rid`) from Anor to Gondor to Rohan, so `mcp__runtime__logs` with that id as `grep` is the errand in all
   of them.
3. **Secrets.** Ask Claude what token Gondor sends Rohan. It can only see `***`: the token is taken out before a
   line is kept, drawn or handed to the model.
4. **What an edit broke.** Ask Claude to fix the Halifirien bug. Its edit to `gondor/realm.py` is counted against
   `gondor` alone; `mcp__runtime__errors_since_edit` then tells the errors that came with the edit from the
   Ithil-stone's, which was there before. Break something on purpose (a wrong name in `realm.light`) and a toast
   says so within seconds.
5. **A crash at import.** Put a syntax error in `gondor/app.py`: Gondor does not come back, its log has the
   traceback, and the riders' log fills with riders who found the gate shut.
6. **An error in the browser.** Send for 9,000 spears from the page, then ask Claude why the form did nothing.
7. **What each realm consumes.** The pane's table has a CPU and a Memory column: each realm is found by the port
   named after `#` in `.claude/runtime`, and added up with the processes it started. Ask Claude "which realm is
   the heaviest" (`mcp__runtime__resources`). The riders listen on no port, and the pane says so.
8. **What a realm is configured with.** `v` in the pane, or ask Claude "which Gondor does Anor call"
   (`mcp__runtime__env`). For a local app the answer is read from the env files of its source, here
   `anor/.env`: what a process was started with cannot be read from outside it. That file is not in the repo:
   copy [`anor/.env.example`](anor/.env.example) to it. The Steward's seal in it is a stand-in secret, and shows
   as `***`.
9. **Why a component rendered.** Open the page in a Chrome that listens on a debug port
   ([`docs/remote-browser.md`](../docs/remote-browser.md) opens one), then `c` in the pane, or ask Claude "why
   does the beacon chain keep rendering" (`mcp__runtime__renders`). The runtime mod asks the tab itself, and Anor holds
   nothing for it ([how](../.claude/mods/runtime/browser/README.md)). The beacons are fetched again every three
   seconds, and every lamp renders each time, lit or not. The view is a tree under each component, with the value
   each state and prop held (`t`), or the page's own elements as they stand (`d`).
10. **A realm that falls silent.** Stop the launcher: within two minutes the pane says each log is quiet.
11. **What goes through the broker.** In containers or in the cluster, the pane draws the broker in a table of
    its own, apart from the four apps. `b` opens its view, where `beacons.lit` pressed opens on its last messages;
    or ask Claude "do Rohan's watchers keep up" (`mcp__runtime__broker`): the topic, the group, and how many
    records wait. The view has a field, Ask Claude: a question typed there is handed to Claude, which answers it through
    the same tool. "What did Gondor last send" reads the last records of `beacons.lit`, each under the id of the
    request that lit the beacon, which is in Gondor's log and in Rohan's too. Then break it, with `kubectl -n beacons` in the cluster, or `docker
    compose` with `stop`, `start` and `exec` in containers:

    | Do this | What the runtime mod says |
    | --- | --- |
    | `scale deploy/rohan --replicas=0` | The lag grows and nothing is taken; ten seconds on, the group is `Empty`, nobody reads, and a toast says so |
    | `echo not-json \| kubectl -n beacons exec -i deploy/redpanda -- rpk topic produce beacons.lit` | Rohan logs the same error every five seconds, and the lag is stuck behind that record. To move the group past it: scale Rohan to 0, wait until the group is `Empty`, `rpk group seek rohan-watchers --to end` in the broker, and scale Rohan back |
    | `watchPace: "3"` in the chart's values, or `WATCH_PACE=3` for compose | Rohan takes a record every three seconds: the lag climbs, but something is taken, so it is slow and not stuck |
    | `scale deploy/rohan --replicas=3` | The group is rebalancing, then `Stable` with 3 members |
    | `scale deploy/redpanda --replicas=0` | The broker is down, could not be asked, and Gondor logs each tidings lost on the road |
    | Rename `beacon` in what `gondor/tidings.py` sends | Rohan cannot read the tidings: the lag is said against what it was before the edit, on the broker, though the errors are Rohan's and the edit Gondor's |
12. **What the database holds.** In containers or in the cluster, the pane draws the database in a table of its
    own too, with its sessions of those it lets in. `q` opens its view, where `lightings` pressed opens on its last
    rows; or ask Claude "was the lighting of Nardol written" (`mcp__runtime__database`): the sessions by what they
    do and by the app that opened them, the tables, and with `table` the last rows, each under the id of the
    request that lit the beacon, which is in Gondor's log and on the broker too. The runtime mod asks the database's own
    `psql`, with writing turned off. The view has a field, Ask Claude: a question typed there ("which beacon was
    lit most often?") is handed to Claude, which answers it with a SELECT of its own through the same tool. Then break it, with `kubectl -n beacons` in the cluster, or `docker compose`
    with `stop`, `start` and `exec` in containers:

    | Do this | What the runtime mod says |
    | --- | --- |
    | `kubectl -n beacons exec -it deploy/postgres -- psql -U gondor beacons`, then `BEGIN; LOCK TABLE burning;` and leave it open | Gondor's sessions wait for a lock held by that one, each with its statement, and a toast says so; half a minute on, the session that holds it is said idle in an open transaction. Gondor answers 503 once no session of its four is free. `ROLLBACK;` lets them through |
    | `scale deploy/postgres --replicas=0` | The database is down, could not be asked, and Gondor logs that the archives are shut at every request, the page's own every three seconds among them |
    | `scale deploy/postgres --replicas=1` after that | Gondor finds it again by itself. The tables are gone with the pod: the first request fails on `UndefinedTable`, Gondor puts up its shelves again, and no beacon burns |
    | `scale deploy/gondor --replicas=3` | Twelve sessions by the app `gondor`, and the three agree on what burns, which they did not while each kept it in memory |
