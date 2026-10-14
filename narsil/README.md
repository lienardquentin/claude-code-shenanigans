# Narsil

A small command-line tool in Rust that reads and keeps a chronicle of beacon lightings: something that is run, prints
and breaks, for the `anduril` mod to watch. Nothing here is meant to be useful; every part of it is there to show one
thing the mod does. So far the mod records each run; the rest is still to be written, against this.

The chronicle is a file of lightings, one JSON object to a line. [`chronicle.jsonl`](chronicle.jsonl) holds forty of
them, and one line a scribe wrote in haste that is no JSON at all. A lighting's `keeper` is the name of who lit it, or
`null` for a lighting with no keeper; a missing or blank keeper reads as `null` too.

## Build it

With [rustup](https://rustup.rs)'s toolchain, from this folder:

```
cargo build
cargo test
target/debug/narsil ls
```

`cargo build --profile profiling` is a release build that keeps its symbols, in `target/profiling/narsil`: the one to
put under a profiler, which says little of a debug build.

## Commands

| Command | What it does | What it is there to show |
| --- | --- | --- |
| `narsil ls [--format table\|json]` | The lightings, as a table as wide as the terminal, or as JSON | A diff of what is printed; the same run at several widths, in colour and piped |
| `narsil show <id> [--format …]` | One lighting, and where it stands in the chronicle. Exits 1 when there is none | Exit codes, and what goes to stderr |
| `narsil tally [--by beacon\|keeper\|realm] [--format …]` | The lightings and their watchers, counted; a lighting with no keeper is counted as `(no keeper)` | Where the time goes, on a large chronicle |
| `narsil copy <src> <dst> [--force]` | Copies a file, with a bar of how far it got | A bar that is drawn where it should not be |
| `narsil seal <file> [--check]` | Writes the file's checksum beside it as `<file>.seal`, or compares the two | Which files a run read and wrote |
| `narsil scribe` | Asks for a lighting, a question at a time, and writes it at the end of the chronicle | A run that is a conversation, kept and played again |
| `narsil archive prune --before <date> [--dry-run]` | Takes the lightings before a date out | A command under a command, for the tree of them |
| `narsil forge <dst> [--count n] [--seed n] [--force]` | A chronicle of made-up lightings, the same ones for the same seed | What the timings are run on |
| `narsil sync --from <url> [--dry-run]` | Appends the lightings Gondor has and the chronicle does not, under fresh ids | Two runs of one answer, and a dry run that writes nothing |
| `narsil completions <shell>` | The completions of a shell | [`completions/narsil.bash`](completions/narsil.bash) is kept in the repo, to go stale |

Every command takes `--chronicle <file>`. Without it the chronicle is the one `NARSIL_CHRONICLE` names, else the one
the config names, else `chronicle.jsonl` where narsil is run.

The config is `$XDG_CONFIG_HOME/narsil/config`, or `~/.config/narsil/config`: lines of `key = value`. `chronicle` is
the file to work on, and `keeper` the name `scribe` offers when it asks who lit the beacon. It is read at every run,
whatever the command.

The checksum is FNV-1a over 64 bits: it tells that a file changed, and proves nothing of who changed it.

## Keeper-less lightings

A lighting with no keeper has `"keeper": null` in the chronicle. `ls` and `show` print `(no keeper)` where the keeper
goes, and `tally --by keeper` counts all of them on one row of that name, which `--format json` gives as `"name": null`:

```
NAME         LIGHTINGS  WATCHERS
(no keeper)          1         2
Hirgon               1         5
Mablung              1         3
ALL                  3        10
```

## Gondor's lightings

`narsil sync --from http://127.0.0.1:8101` asks Gondor for every lighting it knows, its `GET /lightings`, and appends
to the chronicle each one the chronicle does not hold. Gondor is local or reached by a port-forward, so only plain
`http://` is spoken: an `https://` address is refused before anything is asked, and nothing is written when Gondor
does not answer, answers with an error, or answers with what is not a list of lightings.

A lighting is known when the chronicle holds one with the same beacon, `lit_at` and keeper, whatever id either side
gave it. `lit_at` is compared as its text, so it must be spelt as Gondor spells it: UTC to the millisecond, with `Z`
(`3019-03-12T21:04:09.481Z`). A line that spells the same moment another way, without milliseconds or with `+00:00`,
is not known: the first sync appends Gondor's copy beside it, as a lighting of its own, and the copy is known after that.

A lighting that is not known is appended under a fresh id: the largest id in the chronicle plus one, then the next.
Gondor numbers its own lightings from 1 again when it wakes with no database, so an id Gondor gives may be taken in
the chronicle already, by another lighting. Each such renumbering is said, as `Gondor's lighting 1 is written as 41`.
A chronicle that is not there yet is started by the sync.

`--dry-run` says what would be appended, in the words with `would`, and writes nothing. A second sync after the first
appends nothing:

```
Gondor's lighting 1 would be written as 41
would append lighting 41: Calenhad lit at 3019-03-12T21:04:09.481Z by Hirgon
Gondor's lighting 2 would be written as 42
would append lighting 42: Nardol lit at 3019-03-12T21:04:09.482Z by (no keeper)
would append 2 lightings from http://127.0.0.1:8101 to shipped.jsonl
```

The tests run the sync against a Gondor of their own, on 127.0.0.1, that answers what they say.

## What is wrong with it, on purpose

- **A warning goes to stdout.** The line of `chronicle.jsonl` that is no JSON is skipped with a warning, printed
  where the answer is: `narsil ls --format json | jq .` fails on its first line.
- **An empty chronicle is a panic.** `narsil show 1` on a file with no lighting in it looks at the first one before
  it looks for the one asked for: an index out of bounds and exit 101, where "no lighting 1" and exit 1 were meant.
- **A closed pipe is a panic.** `narsil ls | head -3` on a large chronicle: `head` leaves, narsil goes on printing,
  and dies of it with a panic and exit 101.
- **Colour goes down a pipe.** `ls` paints unless `NO_COLOR` is set, and does not ask whether anyone is there to see
  it: `narsil ls | cat -v` is full of escape codes.
- **The bar is drawn on stdout**, carriage returns and all, so `narsil copy a b > log` keeps every step of it.
- **`ls` says when it was run**, on its last line, so no two runs print the same thing. It is there for a diff to
  have something to leave out.
- **Pruning loses what could not be read.** `archive prune` writes back the lightings it kept, and the line that is
  no JSON is not one of them: it goes without a word, and with `--before` set earlier than every lighting it is all
  that goes.
- **A flag of `ls` is in its `--help` and not in the table above.**
- **`scribe` writes today's date** among lightings of the year 3019, and dates are compared as text: a prune takes
  the new lighting out with the old ones.

## What to run

Eleven runs that between them touch every part, for `anduril` to keep and to play again on another build.
[`.claude/anduril`](../.claude/anduril) keeps them, with the forging of the large chronicle the last one reads:

```
narsil ls
narsil ls --format json
narsil ls --since 3019-03-12
narsil show 3
narsil show 999
narsil tally --by keeper
narsil tally --by realm --format json
narsil archive prune --before 3019-03-10 --dry-run
narsil seal chronicle.jsonl
narsil sync --from http://127.0.0.1:9 --dry-run
narsil --chronicle big.jsonl tally
```

The sync is pointed at a port nothing listens on, so it is refused at once, and writes nothing. The last is for the
timings, on a chronicle forged for it: `narsil forge big.jsonl --count 200000`.
