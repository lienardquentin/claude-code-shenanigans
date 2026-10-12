# The Mermaid CLI (`mmdc`): what it could add to a mod

- **Question**: should the owner later build anything on the official Mermaid CLI, next to or instead of `termaid`? (Spec: `.scratch/mod-that-renders-mermaid-diagram-with-te/spec.md`, ticket 05.)
- **Date written**: 2026-10-12.
- **`mmdc` version the sources describe**: **unknown**. See "Read this first".
- **Nothing was installed and nothing was executed** to write this document. No `npm`, no `mmdc`, no browser, no Node.

## Read this first: how far these sources were read

The run that wrote this document had no tool that reaches the network (file tools and a restricted shell only). The primary sources below could therefore **not be opened in that run**. Every statement marked **(recalled)** comes from the author's memory of that source and was **not re-checked against it**. Every statement marked **unknown** is one the author could not state even from memory. The links are the places where each statement must be confirmed before anyone acts on it. The ticket's rule that a figure the sources do not give is marked unknown, not estimated, is applied here to the whole document: treat "recalled" as "unverified".

Sources:

- [M1] Mermaid CLI repository README: <https://github.com/mermaid-js/mermaid-cli>
- [M2] Mermaid CLI releases and changelog: <https://github.com/mermaid-js/mermaid-cli/releases>
- [M3] Mermaid CLI Puppeteer configuration file section of [M1] (the `-p` / `--puppeteerConfigFile` option), same page as [M1].
- [M4] Mermaid documentation, "Mermaid CLI" page: <https://mermaid.js.org/config/mermaidCLI.html>
- [M5] Mermaid documentation, syntax reference (diagram types): <https://mermaid.js.org/intro/syntax-reference.html>
- [M6] Puppeteer documentation, installation (browser download): <https://pptr.dev/guides/installation> (Puppeteer is the Mermaid CLI's browser driver per [M1], recalled)
- [T1] termaid repository: <https://github.com/fasouto/termaid>
- [A1] `docs/adr/0001-own-flowchart-layout-engine.md` in this repo.
- [A2] `docs/research/terminal-capabilities.md` in this repo (pixel image protocols per terminal).

## 1. What `mmdc` produces, and from what input

| Question | Statement | Source |
|---|---|---|
| Output formats | SVG, PNG and PDF, chosen by the output file's extension or by `-e` / `--outputFormat` (recalled) | [M1] |
| Input | A Mermaid definition file given with `-i` / `--input` (recalled) | [M1] |
| Standard input | `-i -` reads the definition from standard input (recalled) | [M1] |
| Standard output | Writing the result to standard output with `-o -` is supported for some formats: **unknown** which formats and since which version | [M1], [M2] |
| Markdown input | When the input file is Markdown (`.md`), `mmdc` finds the fenced `mermaid` blocks, renders each to an image file, and writes a new Markdown file in which each block is replaced by an image link (recalled). Whether it also accepts a Markdown file on standard input: **unknown** | [M1] |
| Styling options | Theme (`-t`), background colour (`-b`), width/height (`-w`, `-H`), scale (`-s`), a config file for Mermaid (`-c`) and a CSS file (`-C`) (recalled) | [M1], [M4] |

Nothing in the recalled material says `mmdc` produces text or box-drawing output. It produces images or vector documents.

## 2. What must be installed, and the start-up cost

| Question | Statement | Source |
|---|---|---|
| Runtime | Node.js, and the package installed through npm (`@mermaid-js/mermaid-cli`) (recalled). The minimum Node version: **unknown** | [M1] |
| Browser | It renders by driving a headless Chromium through Puppeteer; installing the package normally makes Puppeteer download a Chromium build (recalled) | [M1], [M6] |
| Size of that download | **unknown** (varies by platform and Puppeteer release; not stated in the sources recalled) | [M6] |
| Sandbox in containers or as root | The README documents a Puppeteer config file (`-p`) used to pass launch arguments such as `--no-sandbox` (recalled) | [M1], [M3] |
| Start-up cost | The README does not, to the author's recollection, give a figure or a statement about start-up time. Each `mmdc` run launches a browser (recalled), so a per-call cost exists, but its size is **unknown**. It must not be estimated | [M1] |
| Install by `npx` without installing | Running through `npx` is mentioned in the README (recalled); the first-run download cost is **unknown** | [M1] |

## 3. What `mmdc` would allow that `termaid` cannot

The facts on termaid are from [T1]: it is a pure-Python renderer that prints box-drawing text and is run here through `uvx` (spec, "Rendering"). Which Mermaid diagram types it supports is read from its README at the time of a later run, not here: **unknown** in this document.

A mod reaches the host only through the engine's process call, which exists only in the CLI (spec, "Surfaces"). It takes a command and arguments, optional standard input, and gives back output and an exit status. It does not give the mod a file system, a pixel surface or terminal control. Everything below is bounded by that.

### 3.1 Image export (SVG, PNG, PDF)

- **What `mmdc` gives**: files in those formats [M1] (recalled).
- **What a mod would have to do**:
  1. Call `mmdc` (or `npx @mermaid-js/mermaid-cli`) through the process call with the source on standard input (`-i -`) and an output path. Whether the output can be read back through the process call, or only written to disk, depends on standard-output support, which is **unknown** [M1].
  2. If it writes to a file, the mod must choose a path and tell the reader where it is. Whether the mod can write or delete that file itself, rather than only through the command, is not settled here; it would be read from the mod platform's type file in the later run.
  3. Offer a button for it in the pane. The spec lists export as out of scope for `termaid-view`, so this would be a new action.
- **What the later run must settle by trying**: whether `mmdc` starts at all on the owner's machine, how long a call takes cold and warm, where it can write, and whether the engine's per-call limits allow it.

### 3.2 Pixel rendering in terminals with a graphics protocol

- **What `mmdc` gives**: a PNG (or an SVG to be rasterised) [M1] (recalled). `mmdc` itself does not draw to a terminal.
- **Which terminals could show it**: the ones with a pixel image protocol (kitty graphics, sixel, iTerm2 inline images). Per terminal support is tabulated in [A2].
- **What a mod would have to do**:
  1. Produce the PNG as in 3.1.
  2. Get the image bytes drawn by the terminal. A pane is drawn by the engine from a component tree; whether it can carry raw escape sequences for a graphics protocol, and whether the engine or a multiplexer would pass them through, is **unknown**. [A2] notes that images are "not fully handled by multiplexer sessions" for at least one terminal.
  3. Detect that the terminal supports a protocol (environment variables per [A2]) and fall back to termaid's text otherwise.
- **What the later run must settle by trying**: whether any pane component can emit a graphics sequence at all. If it cannot, this feature is dead whatever `mmdc` does. That is the first thing to try, and it needs no `mmdc`.

### 3.3 Full syntax coverage

- **What `mmdc` gives**: it renders with Mermaid itself in a browser, so it supports the diagram types Mermaid supports at its bundled version [M1] (recalled), listed in [M5]. Which diagram types and syntax forms termaid does not cover is **unknown** here (not read from [T1]).
- **What a mod would have to do**: use `mmdc` as a fallback only when termaid fails on a diagram, and show the result as an image (needs 3.1 and 3.2) or not at all. A full-fidelity drawing in a text pane is impossible: `mmdc` has no text output (see section 1).
- **What the later run must settle by trying**: a list of real diagrams from the owner's sessions that termaid rejects, and whether `mmdc` draws them. Without that list the gain is unmeasured.

## 4. ADR 0001's reasons for rejecting `mmdc`

[A1] rejected the official renderer for these reasons. It is retired, but its reasoning is checked here against the situation now that no feature needs node positions.

| ADR reason | Still holds? |
|---|---|
| It needs Node and a headless browser | **Yes, in fact, but changed in kind.** The ADR said neither is available to a mod, because a mod runs without a DOM or Node. Through the process call a mod can now start a host command, as `termaid-view` does with `uvx`. So the objection becomes "an extra install and a browser download for the reader", not "impossible". Section 2 holds. [A1], [M1] |
| It returns a finished picture with no node positions; clicking, edge highlighting and keyboard walking need positions | **No longer applies.** Nothing in the current spec needs node positions (spec, "Out of Scope": clickable nodes). Image and vector output is enough for the features in section 3. [A1] |
| Owning the geometry gives the same behaviour on every surface | **Does not apply to export**, and **still holds as a limit**: the process call exists only in the CLI, so `mmdc` would work only there, as termaid does. Image display additionally depends on the terminal (3.2) |
| Fidelity cost of a subset | **Weaker now.** termaid also covers a subset; `mmdc` would be the only way to cover everything (3.3), but only as an image |
| Option "vendored layout package" | Not relevant to `mmdc`; not examined here |

## 5. Recommendation

Not a decision; what each candidate needs before a run is worth planning. All of it rests on sources not re-read in this run, so the first step of any later run is to confirm sections 1 and 2 against [M1] and [M2].

| Candidate | Worth a later run? | What that run must settle first, by trying |
|---|---|---|
| Image export | **Maybe, small.** It is the least dependent on the engine: one process call and a file | Install `mmdc` on the owner's machine, time a cold and a warm call, and check where a call can write and whether its output can come back through the process call |
| Pixel rendering in a terminal | **Not yet.** Everything hangs on one unknown: whether a pane can emit a graphics protocol sequence | Try emitting an image sequence from a pane in a terminal that supports one ([A2]) with a hand-made PNG, before any `mmdc` work. If it fails, stop |
| Full syntax coverage | **Not yet.** The gain is unmeasured and the result could only be an image | Collect the diagrams termaid rejects in real use, then run `mmdc` on them. Decide only when that list is non-empty |

If only one is pursued, pursue image export; the other two depend on it (they need a PNG) and the second also depends on a platform question that costs nothing to try.

## What is unknown (collected)

- The `mmdc` version and its minimum Node version.
- Whether `-o -` works, and for which formats; whether Markdown can come on standard input.
- The Chromium download size and any statement of start-up cost.
- Whether a pane can emit a terminal graphics sequence.
- Which diagram types termaid does not cover.
