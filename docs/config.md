# The project file: `.claude/theseus.toml`

Theseus proves a change by what the project builds. `.claude/theseus.toml` names each thing it builds (a *target*),
the folders whose edits are edits of it, and how it is tested and checked; and who reviews a settled change.

`/theseus init` proposes the file from the project's manifests (a CLI for each Cargo binary, a service for each
FastAPI app, a frontend for each JavaScript app with a `test` script), and `/theseus init --write` writes it.
`/theseus doctor` checks that it reads and that every command it names can start.

Without the file, Theseus proves a change by the verification commands its plan states, or its issue's
`## Verification` section.

Editors that read a `#:schema` line (Taplo, Even Better TOML) complete and check the file against
[`theseus.schema.json`](../.claude/mods/theseus/schema/theseus.schema.json):

```toml
#:schema https://raw.githubusercontent.com/lienardquentin/theseus/main/theseus/schema/theseus.schema.json
```

## An example

```toml
review = ["/code-review medium", "/security-review"]
standards = ["docs/agents/standards.md"]

[targets.narsil]
kind = "cli"
roots = ["narsil"]
tests = ["narsil/tests"]
test = "cargo test --manifest-path narsil/Cargo.toml -- --exact {tests}"
affected = "cargo test --manifest-path narsil/Cargo.toml"
checks = ["cargo clippy --manifest-path narsil/Cargo.toml -- -D warnings"]

[targets.gondor]
kind = "service"
app = "gondor.app:app"
roots = ["beacons/gondor"]
python = "beacons"
tests = ["beacons/tests"]
test = 'uv run --project beacons pytest -v beacons/tests -k "{tests: or }"'
requests = ["GET /health", "POST /beacons/amon-din/light"]

[targets.gondor.db]
image = "postgres:18-alpine"
```

This repository's own [`.claude/theseus.toml`](../.claude/theseus.toml) uses every key, each explained in a comment.

## The keys

### Top level

| Key | Type | What it does |
|---|---|---|
| `review` | list of strings | The slash commands that review a settled change, in turn, each with what follows its name: `"/code-review medium"`. |
| `standards` | list of strings | Files of written standards, from the project's folder, handed to every reviewer and builder. A run's branch never changes them. |
| `targets` | tables | Each thing the project builds, under its name: `[targets.<name>]`. |

### A target: `[targets.<name>]`

| Key | Type | What it does |
|---|---|---|
| `kind` | `"cli"`, `"service"` or `"frontend"` | **Required.** A `cli` is proved by the runs the recorder keeps of it (name it in `.claude/recorder` too); a `service` by its `requests`, played on the commit and the change; a `frontend` by its own tests and checks alone. |
| `roots` | list of strings | **Required.** The folders whose edits are edits of the target. |
| `app` | string | **Required for a service.** Its app as Python imports it: `"module:app"`. |
| `python` | string | A service's Python folder: put on the path, and its uv project when it has one. |
| `tests` | list of strings | The files and folders that hold its integration tests. |
| `test` | string | Runs the named tests from the project's folder, naming each as it ends. `{tests}` is filled with the tests a change marks (`-- --exact {tests}` for cargo, `-k "{tests: or }"` for pytest, the separator after the colon). A command without `{tests}` is not run: it would run every test. |
| `affected` | string | Runs every test a change of the target can break. Run on the change, and on the commit only when one fails, to tell what the change broke from what was broken before it. |
| `checks` | list of strings | Lint, type and format checks the change may not newly fail, each judged apart. `{against}` is the commit the change is compared with. |
| `audit` | string | Audits the target's dependencies, run when a change touches a dependency manifest in its folders. |
| `env` | table of strings | What a service is played with, the same on both builds: `env = { ROHAN_URL = "http://127.0.0.1:9" }`. |
| `masks` | list of strings | Regular expressions, as Python reads them: what each matches in an answer is left out of a comparison (a timestamp). Write them as literal strings, `'\d+'`, so backslashes stay. |
| `requests` | list of strings | A service's kept requests, played in order against one app: `"GET /health"`. A JSON body is one quoted word after the path: `"POST /light '{\"keeper\": \"Hirgon\"}'"`. |

### A service's database: `[targets.<name>.db]`

Each build of the service plays against a Postgres of its own, made in a container kept warm between proofs. Needs
Docker.

| Key | Type | What it does |
|---|---|---|
| `image` | string | **Required.** A Postgres image: `"postgres:18-alpine"`. |
| `env` | string | The variable the database's address is set in. `DATABASE_URL` when not said. |
| `setup` | string | Run in the build's folder before it plays, the address set: a migration. Leave it out when the app makes its own tables. |

### Readiness: `[targets.<name>.ready]`

| Key | Type | What it does |
|---|---|---|
| `request` | string | **Required.** Asked before the service is played, until it answers 2xx: `"GET /health"`. |
| `match` | string | A regular expression the answer's body must match too. |

### Where it is deployed: `[targets.<name>.live]`

While the service runs in a cluster, both builds are played again against its real dependencies, reached by
port-forward, with the deployed workload's own variables. A context whose name holds `prod` is refused. Needs kubectl.

| Key | Type | What it does |
|---|---|---|
| `workload` | string | **Required.** `context/namespace/kind/name`. |
| `forward` | list of strings | The services reached by port-forward, `service:port`; the workload's variables are pointed at the forwarded ones. |
| `env` | table of strings | Laid over the workload's variables. |
| `db` | string | The database's workload in the same namespace, `deployment/postgres`. |
| `scratch` | string | The variable each build's copy of the deployed database is set in: each build plays against a copy made from one dump, dropped after. |
| `before`, `cleanup`, `restore` | string, list, string | Statements run around each build: what is read before, what the run wrote taken out (`{rid}` is its request id), and what was read put back. |

## Errors

Every error names its line: `.claude/theseus.toml:12: targets.gondor.app must name the service's app as Python imports
it, "module:app"`. An unknown key, a value of the wrong type and a missing required key are each an error; the rest of
the file is still read. Errors are said once in a toast, listed by `/theseus doctor`, and stop a run from starting.

## The line format

Before 0.6.0 the file was `.claude/verify`, a line each (`narsil=cli@narsil`, `narsil.test=…`, `$ gondor GET /health`).
It is still read when `.claude/theseus.toml` is not there, with a warning, for one release. `/theseus init --write`
writes the TOML file from it, the same targets and reviews.
