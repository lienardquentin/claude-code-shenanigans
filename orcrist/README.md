# Orcrist

A linter in Rust for what an AI leaves behind in code: comments that restate it, errors it drops, and in time guards
for what cannot happen and names that say nothing. It reads Rust through tree-sitter and judges a change, not a whole
codebase: the rules are guesses, and one that fires on every old line of a project is not read.

## Build it

With [rustup](https://rustup.rs)'s toolchain, from this folder:

```
cargo build
cargo test
target/debug/orcrist check src/*.rs
```

## Commands

| Command | What it does |
| --- | --- |
| `orcrist check <files>…` | Judges every line of the given files |
| `orcrist check --since <commit>` | Judges only the lines the working tree added since that commit, in the Rust files git tracks |

Each finding is printed as `file:line rule: what is wrong`. It exits 0 when there is none, 1 when there is any, and 2
when a file cannot be read or git fails.

## Rules

| Rule | What it finds |
| --- | --- |
| `restating-comment` | A `//` comment three quarters of whose words, the filler left out, are in the line of code below it |
| `swallowed-error` | `call().ok();` and `let _ = call();`: what the call returned, an error among it, dropped |
| `unexplained-spare` | A spare that does not say why |

## Sparing a finding

A finding the rule got wrong is spared by a comment on its line or the line above, naming the rule and saying why:

```rust
io::stdout().flush().ok(); // orcrist: spare swallowed-error: a progress bar that fails to show changes nothing
```

A spare without a reason spares nothing and is a finding of its own.
