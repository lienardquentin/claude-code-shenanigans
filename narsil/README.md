# Narsil

A small command-line tool in Rust that reads and keeps a chronicle of beacon lightings: something that is run, prints
and breaks, for the `anduril` mod to watch. Nothing here is meant to be useful; every part of it is there to show one
thing the mod does. So far the mod records each run; the rest is still to be written, against this.

The chronicle is a file of lightings, one JSON object to a line. [`chronicle.jsonl`](chronicle.jsonl) holds forty of
them, and one line a scribe wrote in haste that is no JSON at all.

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
| `narsil tally [--by beacon\|keeper\|realm] [--format …]` | The lightings and their watchers, counted | Where the time goes, on a large chronicle |
| `narsil copy <src> <dst> [--force]` | Copies a file, with a bar of how far it got | A bar that is drawn where it should not be |
| `narsil seal <file> [--check]` | Writes the file's checksum beside it as `<file>.seal`, or compares the two | Which files a run read and wrote |
| `narsil scribe` | Asks for a lighting, a question at a time, and writes it at the end of the chronicle | A run that is a conversation, kept and played again |
| `narsil archive prune --before <date> [--dry-run]` | Takes the lightings before a date out | A command under a command, for the tree of them |
| `narsil forge <dst> [--count n] [--seed n] [--force]` | A chronicle of made-up lightings, the same ones for the same seed | What the timings are run on |
| `narsil completions <shell>` | The completions of a shell | [`completions/narsil.bash`](completions/narsil.bash) is kept in the repo, to go stale |

Every command takes `--chronicle <file>`. Without it the chronicle is the one `NARSIL_CHRONICLE` names, else the one
the config names, else `chronicle.jsonl` where narsil is run.

The config is `$XDG_CONFIG_HOME/narsil/config`, or `~/.config/narsil/config`: lines of `key = value`. `chronicle` is
the file to work on, and `keeper` the name `scribe` offers when it asks who lit the beacon. It is read at every run,
whatever the command.

The checksum is FNV-1a over 64 bits: it tells that a file changed, and proves nothing of who changed it.

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
narsil ls --until 3019-03-10
narsil show 3
narsil show 999
narsil tally --by keeper
narsil tally --by realm --format json
narsil archive prune --before 3019-03-10 --dry-run
narsil seal chronicle.jsonl
narsil --chronicle big.jsonl tally
```

The last is for the timings, on a chronicle forged for it: `narsil forge big.jsonl --count 200000`.
