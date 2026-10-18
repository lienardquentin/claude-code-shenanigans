# claude-code-shenanigans

Personal Claude Code mods and experiments.

## Mods

Claude sees nothing of a pane by itself, so every mod that opens one also serves it as a tool, `mcp__<mod>__pane`
(`mcp__termaid-view__pane`, `mcp__timeline-view__pane`, `mcp__renovate-desk__pane`, `mcp__recorder__pane`). It answers
whether the pane is open, then its latest drawing as text: the tree you see, so your selection, page and filter are
in it. Ask Claude about "the pane" and it can read it.

### `termaid-view`

A pane that draws the Mermaid diagrams of a session. It lives in [`.claude/mods/termaid-view`](.claude/mods/termaid-view).

- `/termaid` opens the pane on the most recent Mermaid fenced block of Claude's replies in the main conversation.
- In the terminal each diagram is drawn as box-drawing text by [termaid](https://github.com/fasouto/termaid), a
  Python Mermaid renderer, fitted to the pane's width. A drawing still wider than the pane is clipped, with a notice.
  Nothing runs until the pane is open, and a diagram is rendered once per width.
- A diagram that cannot be drawn is shown as its Mermaid source with one line saying why: termaid's own message, a
  timeout (60 seconds), or a failed download of termaid. When `uv` is not installed the line says so and gives the
  command that installs it (the mod never runs it). A failure is kept until the pane is reopened.
- Two actions: the previous and next buttons walk through the session's diagrams, oldest to most recent ("2 of 3"),
  and "Show source" switches the diagram between termaid's drawing and its Mermaid source (the button then reads
  "Show drawing"). The toggle runs no process and keeps its standing while paging. A diagram arriving at the end of a
  turn moves the pane to it.
- A "Theme" picker paints the drawings in one of termaid's color themes (`default`, `terra`, `neon`, `mono`, `amber`,
  `phosphor`, `gruvbox`, `monokai`, `dracula`, `nord`, `solarized`), or `none` for the plain drawing. The colors are
  termaid's own, handed to the pane as data: termaid's command line drops them when piped, so a themed drawing comes
  from its Python API through the script in `hooks/themed.ts`. The theme stays while paging, for the session.
- In the terminal a reply's diagrams are drawn in the transcript too: each Mermaid block termaid has drawn is
  replaced by its drawing, in the pane's theme, under the text the reply opens with. A block not drawn yet, or that
  cannot be drawn, stays as the reply wrote it. "Hide in chat" in the pane turns this off for the session.
- On the desktop app, VS Code and mobile a diagram is a picture: Mermaid's own drawing, as an SVG, in the pane and in
  the transcript in place of its block. The [Mermaid CLI](https://github.com/mermaid-js/mermaid-cli) draws it on this
  machine, in an Edge, Chrome or Chromium already installed (headless: no window opens, and no browser is
  downloaded). The diagram is written to a temporary folder removed after the run; nothing of it leaves the machine.
  - The "Theme" picker there holds Mermaid's themes (`default`, `neutral`, `forest`, `dark`); paging, "Show source",
    the direction of a flowchart and "Hide in chat" work as in the terminal. Mobile draws no picker.
  - A picture is an image, which takes no press: its linked nodes cannot be pressed where they are drawn. They are
    buttons under the picture instead, each called by its node's label with where it leads (`parse.ts:50`,
    `changes of draw.ts`); pressing one opens its code or its changes in the pane, as in the terminal.
  - A picture over the app's limit for an SVG (131,072 characters) is shown as its source, with a line saying so; so
    is a diagram Mermaid cannot draw, with its message.
  - The pictures are drawn one at a time, a few seconds each. The first one downloads the Mermaid CLI, which takes
    about a minute.
  - Tried in the desktop app; VS Code and mobile take the same path and are not yet tried.

In the terminal it needs [`uv`](https://docs.astral.sh/uv/). The mod runs `uvx termaid==<version>` (the version is fixed in
`hooks/register.tsx`), so **termaid is downloaded from PyPI the first time it is used** and cached by uv after. This
is one of the two places a mod of this repo fetches code from an external site at run time. A theme runs
`uvx --from termaid[rich]==<version> python`, which also downloads [rich](https://github.com/Textualize/rich) and its
dependencies the first time.

Off the terminal it needs [Node.js](https://nodejs.org/) and one of those browsers. The mod runs
`npx -y @mermaid-js/mermaid-cli@<version>` (the version is fixed in `hooks/pictured.ts`), so **the Mermaid CLI is
downloaded from npm the first time it is used** and cached by npm after: the second place this mod fetches code at
run time. Only the CLI's own version is fixed; the versions of what it depends on (Mermaid, Puppeteer) are npm's
pick within the ranges the CLI names. Puppeteer's own browser download is turned off.

Install it from a clone:

```
claude plugin marketplace add <path to this clone>/.claude/mods/termaid-view
claude plugin install termaid-view@termaid-view-mods
```

### `status-line`

One plain-text line under the prompt, with the four things worth knowing and nothing else. It lives in
[`.claude/mods/status-line`](.claude/mods/status-line).

```
claude · main* · Opus 5.5 · 42%
```

- The folder: the last component of the session's working directory.
- The git branch, with a `*` when the tree is dirty (untracked files included); a short commit hash on a detached
  HEAD; a name over 32 characters cut in the middle. Gone outside a git repo.
- The model, as `/model` shows it.
- The context fill, a bare percentage, marked `!` from 60% and `!!` from 85%. Left out until there is a figure.
- A segment with nothing to say is left out with its separator. In a narrow terminal the model goes first, then the
  branch, then the folder; the context fill stays.
- Redrawn at session start, after every tool call, when a turn completes, and every 10 seconds.
- No command and no option: disabling the plugin is the off switch.

Install it from a clone:

```
claude plugin marketplace add <path to this clone>/.claude/mods/status-line
claude plugin install status-line@status-line-mods
```

### `timeline-view`

A pane that draws what a session did over time. It lives in [`.claude/mods/timeline-view`](.claude/mods/timeline-view).

- `/timeline` opens the pane. Each lane is one row of cells over the period shown: the main conversation first, then
  one lane per subagent, from its spawn to the end of its run. A pipeline run's builders are subagents, so each task
  being built has a lane of its own.
- A cell a tool call ran in is filled, in the color of its kind of work (reads, edits, shell, agents, other), and a
  failed call is red and never painted over. A cell where the lane was at work with no tool running (the model
  thinking or writing) is shaded; an idle cell is a dot.
- Pressing a lane's name lists its calls under the drawing, the latest first: when each started, the tool, what it
  worked on (its command, file or pattern) and how long it took. A turn is listed with its prompt.
- "Show" limits the drawing to the whole session, the latest turn, or the last 5, 15 or 60 minutes. What still runs
  grows every second; a quiet session redraws nothing. "Clear" empties what has ended.
- It records the last 1,500 turns and calls of the session, in the session's memory only: nothing is written to disk
  and nothing leaves the machine. A `/clear` empties it.

Install it from a clone:

```
claude plugin marketplace add <path to this clone>/.claude/mods/timeline-view
claude plugin install timeline-view@timeline-view-mods
```

### `renovate-desk`

A pane that looks after your open Renovate pull requests on GitHub, or merge requests on GitLab. It lives in
[`.claude/mods/renovate-desk`](.claude/mods/renovate-desk).

- Sorts them into safe (minor, patch, digest, pin or lockfile update, checks green, mergeable), waiting (checks
  running, or conflicts Renovate rebases itself) and to look at (major, failing or missing checks, a review needed).
- `m` merges every safe one, each with its repo's default merge method and pinned to the commit that was judged. A
  pull request to look at that the forge would take has a `merge` button of its own.
- Quiet on the forge: one search request per refresh, only on `/renovate` or `r`, never on a timer; the only write
  is the merge. No comment, no approval, no rebase request.
- On GitHub it looks at `author:app/renovate user:@me` by default; the `query` option takes other search qualifiers.
- On GitLab it looks at every open merge request of the user Renovate runs as, `renovate-bot` by default (the
  `gitlabAuthor` option). A merge goes through `glab mr merge` with `--sha` and `--auto-merge=false`: the commit that
  was judged, now or not at all.
- The forge is the one the session's repo is on (GitLab when its origin's host has `gitlab` in it, GitHub
  otherwise); the `forge` option, `github` or `gitlab`, settles it by hand.

It needs the CLI of the forge, signed in: `gh` for GitHub, `glab` for GitLab. The GitLab side was written from
GitLab's documentation and is answered in the tests by a stand-in: it has not met `glab` itself yet. Install it from
a clone:

```
claude plugin marketplace add <path to this clone>/.claude/mods/renovate-desk
claude plugin install renovate-desk@renovate-desk-mods
```

Then open the pane with `/renovate`.

### Pipeline

The workflow mods are one marketplace, `pipeline`, kept in
[`.claude/mods/.claude-plugin/marketplace.json`](.claude/mods/.claude-plugin/marketplace.json), of three plugins:

- `pipeline` ([`.claude/mods/pipeline`](.claude/mods/pipeline)) takes a GitHub or GitLab issue, or a pull request's
  review, to committed and reviewed work. Its parts each have a folder under `hooks/`, and their logic, which never
  touches the engine, is under `core/`: the issues pane lists the issues (`/issues`), the planner plans (`/planner`),
  the build builds in a worktree of its own (`/build`), the test writer writes tests first (`/tests`), verify proves
  and reviews each change (`/checks`), the review follow-up reads review (`/follow-up`) and the cleanup clears what is
  merged (`/cleanup`). Its tools are `mcp__pipeline__*`; `mcp__pipeline__pane` reads any of its panes by name.
  A pull request says of each task its commit, how long it took, what it changed beyond its files and what its builder
  left unticked, then what was not built, the reviewers' minor findings and what the run spent. `/follow-up` takes a
  pull request's failing checks (GitHub checks, GitLab pipeline jobs) up as changes, beside its review comments.
  `/planner <idea>` starts from a sentence instead of an issue: Claude grills you on it, opens the issue and has it
  planned (`--auto` asks nothing, and lists what it decided in the issue). An auto run settles a plan's open questions
  and risks itself, and the plan and the pull request list them under "Decided without the person".
  Verify proves each change against the targets a project names in `.claude/verify`; a project that names none is
  proved by the verification commands its plan states, or its issue's `## Verification` section (and `## Setup` for a
  fresh worktree). A run with neither is not started.
  A run starts no task while the 5-hour quota window is past 90%: it waits, and goes on by itself once the window
  resets (past 90% of the weekly window it stops for you). A builder that fills 70% of a context window is stopped,
  and its task said to be too large, to be split. Each threshold is an option of the plugin (`/plugin`).
- `recorder` and `runtime`, each useful alone, watch what the code does. Verify reads the recorder's diff for a
  command-line tool.

Install them from a clone:

```
claude plugin marketplace add <path to this clone>/.claude/mods
for mod in pipeline recorder runtime; do
  claude plugin install "$mod@pipeline"
done
```

To take a new version after pulling, update each plugin and restart Claude Code. Every change to a plugin bumps its
`version` (see each plugin's `CHANGELOG.md`): an update leaves a plugin whose version did not change as it was.

```
for mod in pipeline recorder runtime; do
  claude plugin update "$mod@pipeline"
done
```

The plugins were named for The Lord of the Rings until #104 (`middle-earth`, `anduril`, `palantir`). A plugin's kept
state belongs to its id, so on its first start `pipeline` carries the plans and runs the old `middle-earth` plugin kept
into its own store, and each mod still reads a project's file under its old name (`.claude/argonath`,
`.claude/anduril`, `.claude/palantir`) until it is moved. Uninstall the old ones once the new ones are installed.

```
claude plugin validate .claude/mods/pipeline
claude plugin test .claude/mods/pipeline
```

### `recorder`

Keeps a record of every run of the command-line tool being written, whoever ran it, and shows them in a pane. It
lives in [`.claude/mods/recorder`](.claude/mods/recorder), and [`narsil`](narsil) is the tool it is shown on.

- A project names what is watched in [`.claude/recorder`](.claude/recorder), a line each:
  `narsil=narsil/target/debug/narsil@narsil` is the name the tool is run by, the built binary a run of it runs, and
  the folder of its source.
- For each tool the mod writes a launcher of that name in `.recorder/bin`, which hands the run to
  [`shim/recorder_shim.py`](.claude/mods/recorder/shim/recorder_shim.py). A command of Claude's that names the tool
  finds the launcher first on its PATH, and Claude is told to run the tool by its name. For the runs you make in a
  terminal of your own, put the folder first on its PATH: `export PATH="$PWD/.recorder/bin:$PATH"`.
- The tool runs as it would without the shim: a stream that was a terminal is still one for it, of the same size, so
  its colours and its width are its own, and `tool | head` breaks its pipe as it would have.
- A record is what was run and where, by whom, the exit code or the signal, the tool's own duration, its processor
  time and peak memory, whether each stream was a terminal, and what it wrote to stdout and to stderr, kept apart:
  all of it up to 256 kB, and past that its start and its end.
  The last 500 are kept, as files under `.recorder/runs`; the folder ignores itself for git.
- `/recorder` opens the pane: the runs newest first, `f` for the failed ones alone, a run pressed for what it wrote.
  It remarks on a run that sent colour down a pipe, failed without a word on stderr, or met a broken pipe.
- Claude reads the same through `mcp__recorder__runs` (a list it can narrow by tool, failure or text) and
  `mcp__recorder__run` (one run in full), so it sees what you ran and what it printed without being pasted it.
- **What changed between two builds.** The project's file also keeps runs to play again, a `$ narsil show 999` line
  each; `k` on an opened run in the pane keeps it. `d` plays them on the working tree, built afresh, and on HEAD, and
  shows the runs that ended otherwise or wrote something else, each stream as a diff: what the uncommitted edits
  changed in what the tool does. The field above it takes any other commit to compare with (a tag, a branch).
  Claude has it as `mcp__recorder__diff`, which also compares two commits, or a branch with where it left another
  (`mergeBase`), and is told to call it after changing the tool's source.
- A comparison needs `narsil.build=…`, the command that builds the tool from the repo's root. A commit is checked
  out in a git worktree of the tool's own, `.recorder/trees/narsil`, built there, and its binary kept by commit under
  `.recorder/builds`, so each commit is built once. Both builds play the runs in order in a fresh copy of the tool's
  source folder as the working tree has it, with an empty home and no terminal: they read the same files, and what
  a run writes there reaches nothing of yours. `narsil.mask=…` lines are regular expressions for what to leave out
  of a comparison, a time or a process id.
- Files are compared run by run: a file a run changed that is not the same on both builds is said under that run, a
  text file as a diff with the masks applied. Where `strace` is installed each run is traced, which adds two things:
  the files a run wrote outside the folders it was played in (those writes reach your machine, and are said even
  when both builds made them), and the files it wrote and removed again before it ended. Without `strace` the
  comparison says that neither was looked for.

It needs `python3`, and `git` for a comparison, on a POSIX system; it has only been run on Linux. Not recorded: a run made by the binary's path or through `cargo run`, and
what was typed on stdin. The shim adds about 60 ms to a run, which the recorded duration leaves out. Install it with
the other [pipeline](#pipeline) mods, or alone from a clone:

```
claude plugin marketplace add <path to this clone>/.claude/mods/recorder
claude plugin install recorder@recorder-mods
```

Then build `narsil` (`cargo build --manifest-path narsil/Cargo.toml`), open the pane with `/recorder`, and run
`narsil ls`. Tests:

```
claude plugin test .claude/mods/recorder
```
