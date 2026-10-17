# Orcrist

A linter in Rust for what an AI leaves behind in code: comments that restate it, errors it drops, guards for what
cannot happen, names that say nothing, abstractions no second caller needs, and helpers the project already has. It
reads Rust, Python, TypeScript, JavaScript, JSX and the `<script>` of Vue components through tree-sitter, and judges a
change, not a whole codebase: the rules are guesses, and one that fires on every old line of a project is not read.

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
| `orcrist check --since <commit>` | Judges only the lines the working tree added since that commit, and the whole of each file git does not track yet; names on stderr what it left unjudged, of no language it reads |

Each finding is printed as `file:line rule: what is wrong`, or, with `--format json`, as an array of objects with
its `file`, `line`, `column`, `rule` and `message`, or, with `--format sarif`, as SARIF 2.1.0 for code scanning. Lines
and columns count from 1, a column in characters. SARIF names each file by its path relative to the current folder,
or by a `file:///` URI when it was given as an absolute path; for GitHub's code scanning, run orcrist from the
repository's root on relative paths.

Whatever the format, orcrist exits 0 when there is no finding, 1 when there is any, and 2 when a file cannot be read,
is of a language orcrist does not read, or git fails.

The rules that look across files read the project: in a git repository, every file of a language orcrist reads below
the current folder, tracked or not yet; elsewhere, the files given. A file of the project that cannot be read, such as a
bundle that is not UTF-8, is left out of it and named on stderr; only a file given to be judged makes orcrist exit 2.

What those rules find in each file is kept between runs in `orcrist-cache`, in the repository's git folder, under a
key made of the file's content, the settings that shape it and the orcrist binary that found it; a run reads again
only the files that changed, and what no run used for a week is let go. On Django, 560,000 lines, judging one file
takes half a second with it kept, where it took four without. Deleting the folder costs one slower run. What is kept
includes the literals each call passes, which may be secrets written into the code: the folder is its owner's
alone, inside `.git`, which git neither tracks nor pushes. Orcrist keeps nothing where `orcrist-cache` is a link or a
file, and lets go only of what it wrote there.

| Language | Files |
| --- | --- |
| Rust | `.rs` |
| Python | `.py` |
| TypeScript | `.ts`, `.mts`, `.cts` |
| TypeScript or JavaScript, JSX allowed | `.tsx`, `.jsx`, `.js`, `.mjs`, `.cjs` |
| Vue | `.vue`, its `<script>` read as TypeScript |

## Rules

| Rule | What it finds | Rust | Python | TypeScript, JavaScript, Vue |
| --- | --- | --- | --- | --- |
| `restating-comment` | A comment three quarters of whose words, the filler left out, are in the line of code below it | ✓ | ✓ | ✓ |
| `swallowed-error` | An error dropped where someone needed to know of it | `call().ok();`, `let _ = call();` | `except …: pass`, Ctrl+C's `KeyboardInterrupt` aside | `catch {}`, `.catch(() => {})` |
| `vague-name` | A function, variable or parameter every word of whose name could name anything (`data`, `tmp2`, `info`); a verb such as `process` or `handle` only in a function's name | ✓ | ✓ | ✓ |
| `impossible-guard` | A check on a parameter that its own annotation decides: `isinstance`/`typeof` of the type it has, a None, null or undefined check, `?.` | | ✓ | ✓ |
| `single-use-abstraction` | An interface one type implements in the whole project; a parameter every one of at least two calls passes the same literal for | traits | ABCs | interfaces, abstract classes |
| `duplicate-helper` | A function whose parameters and body are piece for piece another's of the project, the names each declares itself aside | ✓ | ✓ | ✓ |
| `unexplained-spare` | A spare that does not say why | ✓ | ✓ | ✓ |

## Sparing a finding

A finding the rule got wrong is spared by a comment on its line or the line above, naming the rule and saying why:

```rust
io::stdout().flush().ok(); // orcrist: spare swallowed-error: a progress bar that fails to show changes nothing
```

A spare without a reason spares nothing and is a finding of its own.

## Configuring it

A project tells orcrist what fits it in an `orcrist.toml`, looked for in the current folder and each folder above it up
to the repository's root; outside a repository, only in the current folder. Without one, every rule judges everywhere
by the defaults below. Globs are relative to the folder of the `orcrist.toml`: `*` does not cross a `/`, `**` crosses
any number.

```toml
# Left out of the project: neither judged under --since nor read by the rules that look across files.
# A file named on the command line is judged all the same.
ignore = ["dist/**", "**/*.min.js"]

[rules.duplicate-helper]
skip = ["hooks/kit/**"]   # where this rule's findings are not reported; every rule takes `skip` and `off`
smallest = 24             # pieces of code below which two functions alike are alike by chance

[rules.restating-comment]
share = 0.75              # share of a comment's words, the filler left out, found in the line below it
filler = ["we", "here"]   # filler besides the built-in words

[rules.vague-name]
words = ["blob"]          # vague words besides the built-in ones
verbs = ["execute"]       # vague verbs, for a function's name, besides the built-in ones

[rules.single-use-abstraction]
calls = 2                 # calls below which a parameter every call passes one literal for is not judged

[rules.swallowed-error]
off = true
```

A key orcrist does not know, a rule it has not, a setting given to a rule it is not for, or a value out of range is
refused with exit 2, so that a typo does not quietly judge by the defaults.

## Adding a language

What orcrist knows of a language's grammar is gathered in one table in `src/syntax.rs`: the kinds of its comments,
functions, calls and literals, where its names are declared, and which of its checks tell a swallowed error, an
impossible guard or an interface. To read another language, add its tree-sitter grammar to `Cargo.toml`; a
`Language` with its extensions, pathspecs and grammar in `src/lang.rs`; and its table, with any check of its own
written in the rule's module. A rule the language has no case of leaves the table's list empty. The rules still take
some grammar as given: a call names what it calls in a `function` field, a function its parameters in `parameters`,
and a bare name is an `identifier`. A grammar shaped otherwise needs those rules taught too.

## Keeping it precise

`fixtures/clean` holds idiomatic code of each language, in styles other than this repository's: arrow-heavy
TypeScript, a React component, plain JavaScript, Python with a `Protocol`, Rust with its own error type. Any finding
there is a false one, and the tests and kept runs hold them at none.

`precision/check.sh` runs orcrist on well-known projects of each language, each at the commit `precision/projects`
pins, and compares what it finds with the findings kept in `precision/<name>.txt`. A change to a rule shows there as
the findings it adds or loses on code nobody wrote for orcrist. It needs the network the first time it fetches a
project; `ORCRIST_PRECISION_CACHE` names a folder to keep them in between runs. `--update` keeps what orcrist finds
now, once the difference is read and wanted.
