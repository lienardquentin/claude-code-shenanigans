# Terminal capabilities per OS

- **Question** (GitHub issue #2): which terminals are recommended on Windows, macOS and Linux, and for each: (a) can it show pixel images, (b) does it report the mouse and how precisely, (c) are hyperlinks clickable, (d) how can a program recognise it from the environment.
- **Date read**: every source below was read on **2026-10-11**.
- **Method**: primary sources only (each terminal's own docs, source repository, changelog or source code; the protocol specs; Claude Code's own docs; the local mod-platform type file). Source code was read where docs were silent. Nothing is filled from memory; a cell that could not be verified is `unknown`.
- **Consumer**: the "terminal guide" table of a Claude Code mod pane is built from this file only.

## Legend

| Value | Meaning |
|---|---|
| `yes` | A cited primary source states or shows the capability. Qualifiers follow in the cell. |
| `no` | A cited primary source states it is unsupported (or, for Ghostty on Windows, that no build exists). |
| `partial` | Supported only behind a setting, a build option, a version, a subset, or "preliminary/incomplete" per the source. The cell says exactly what. |
| `unknown` | Not verified from a primary source. Not a claim of absence. |

Column notes. **Pixel images** lists protocols (kitty = kitty graphics protocol, sixel, iip = iTerm2 inline images / OSC 1337). **Mouse** says whether press/release reporting exists, the encodings (SGR = 1006, SGR-pixel = 1016), and whether coordinates are cell or pixel. **Hyperlinks** is OSC 8 plus how it is clicked when a source says. **Recognise** lists environment variables or identifier queries, each cited; `yes` there means at least one cited identifier exists, `no` that the owner states there is none.

Version scope: unless a cell names a version, it reflects the project's default branch or latest documentation on 2026-10-11 (Alacritty latest release v0.17.0 [S15b], WezTerm latest tag 20240203-110809-5046fc22 [S21b], mintty 3.8.3 [S32], Windows Terminal latest v1.25.2733.0 [S39], foot changelog 1.28.0 [S29b]). A feature added after a project's last release may exist only on its default branch.

## Windows

| Terminal | Pixel images | Mouse | Hyperlinks | Recognise | Version / notes |
|---|---|---|---|---|---|
| Windows Terminal | `yes` sixel ("Terminal and conhost now support Sixels") [S34]. kitty / iip: `unknown` (latest release notes mention Kitty only as keyboard protocol [S39]) | `yes` press/release/motion tracking (default, button-event, any-event) with UTF-8 and SGR encodings, cell coordinates only; the input module has no pixel (1016) mode [S35] | `yes` OSC 8 is parsed and stored [S38]; Ctrl+left-click opens it [S36] | `yes` `WT_SESSION`, `WT_PROFILE_ID` set for the child [S37] | Sixel arrived in Preview v1.22.2362.0 [S34]; stable version not verified. Claude Code notes Windows Terminal / ConPTY hosts can leave stale cells in fullscreen; workaround env var [S1] |
| Windows console host (conhost) | `yes` sixel (same release note) [S34]. kitty / iip: `unknown` | `unknown` (Microsoft's VT-sequence page for the console has no mouse section [S40]) | `unknown` (shared adapter stores OSC 8 [S38]; click behaviour in conhost not verified) | `unknown` (`WT_SESSION` is set by Windows Terminal's connection code, not by conhost [S37]) | conhost is what opens for a console app not attached to a terminal [S41]. Sixel conhost version not verified |
| WezTerm | `yes` iip [S22] and kitty graphics [S21]; sixel `partial`: "preliminary and incomplete" [S23] | `yes` "SGR style mouse reporting" [S21]; SGR-pixel mode implemented in the terminal model [S25] | `yes` OSC 8, "when clicked will open" the URL [S24] | `yes` `TERM_PROGRAM=WezTerm`, `TERM_PROGRAM_VERSION` [S26]; `WEZTERM_PANE`, `WEZTERM_UNIX_SOCKET` [S27]; `TERM` defaults to `xterm-256color` [S23b] | Runs on Windows 10 [S21]. Images "not fully handled by multiplexer sessions" [S22] |
| Alacritty | `unknown` (no image or sixel entry in the supported-sequence list [S17]; no statement either way) | `yes` modes 1000, 1002, 1004, 1005, 1006 listed as implemented, so SGR cell coordinates; 1016 not in the list [S17] | `yes` OSC 8 "Implemented" [S17]; added in 0.11.0 [S20]; opening needs the configured modifiers, Shift bypasses mouse capture [S16] | `partial` `ALACRITTY_WINDOW_ID` set in the unix PTY code [S19]; Windows PTY code not read; `TERM_PROGRAM` not found | Windows supported, ConPTY required (1809+) [S15]. Kitty keyboard protocol supported from 0.16 per Claude Code [S2] |
| Ghostty | `no` no Windows build ("Windows support is planned for the future") [S9] | `no` same | `no` same | `no` same | Official binaries are macOS only; Linux packages are community [S10]. `libghostty-vt` library is Windows-compatible [S9b], that is not the terminal app |
| mintty (Git Bash) | `yes` sixel and iip, formats PNG, JPEG, GIF, TIFF, BMP, Exif [S30]; kitty `unknown` | `yes` xterm mouse tracking; pixel-coordinate mode 1016 from 3.4.0 [S32]; pointer becomes a haircross in pixel modes [S30] | `yes` OSC 8, Ctrl-click opens [S31] | `partial` `TERM_PROGRAM=mintty`, `TERM_PROGRAM_VERSION` set [S33] but the changelog calls them unreliable (3.1.5) [S32]; reply to `CSI > q` is `DCS > \| mintty <version> ST` [S31]; Claude Code special-cases `TERM_PROGRAM=mintty` [S2] | 3.8.3 (2026-06-09) [S32] |

## macOS

| Terminal | Pixel images | Mouse | Hyperlinks | Recognise | Version / notes |
|---|---|---|---|---|---|
| Terminal.app | `unknown` | `partial` reporting exists: View > Allow Mouse Reporting, on by default, app must also request it [S49]; encodings and precision `unknown` | `unknown` | `unknown` (`TERM_PROGRAM=Apple_Terminal` appears only in third-party material, not verified from Apple) | Native-selection key is Fn [S1]; Shift+Enter works without setup [S2] |
| iTerm2 | `yes` iip (OSC 1337) [S42] and kitty graphics ("also supports the Kitty graphics protocol") [S42]; sixel: source includes the sixel module and handles DECSDM [S46] | `yes` DECSET 1006 and 1016 (`MOUSE_FORMAT_SGR_PIXEL`) in source [S46]; per-profile "Enable mouse reporting" must be on [S45][S1] | `yes` OSC 8 [S43]; Command held to highlight on hover [S43] | `partial` `ITERM_SESSION_ID` [S47]; `TERM_PROGRAM=iTerm.app` only mentioned by an issue reporter on the iTerm2 tracker [S48]; `LC_TERMINAL` `unknown` | Not usable with `tmux -CC` integration for Claude Code fullscreen [S1] |
| Ghostty | `yes` kitty graphics [S9]; sixel `unknown` | `yes` SGR (1006) and SGR-pixel (1016) formats enumerated in source [S11] | `yes` OSC 8 hyperlinks implemented in the screen model [S13]; Claude Code: plain click on a link opens it because Cmd is not encodable [S1] | `yes` `TERM_PROGRAM=ghostty`, `TERM_PROGRAM_VERSION` [S12]; `GHOSTTY_RESOURCES_DIR` when resources are found, `GHOSTTY_BIN_DIR` [S12] | macOS and Linux only [S9] |
| kitty | `yes` kitty graphics (originator) [S4] | `yes` pixel coordinates (SGR-pixel) since 0.24.0 [S5] | `yes` OSC 8 since 0.19.0 [S5]; ctrl+shift+click in the documented example [S7] | `yes` `KITTY_WINDOW_ID`, `KITTY_PID`, `TERM=xterm-kitty` [S6] | 0.24.0 and 0.19.0 are the changelog release headings above the entries [S5] |
| WezTerm | `yes` iip [S22] and kitty graphics [S21]; sixel `partial`: "preliminary and incomplete" [S23] | `yes` "SGR style mouse reporting" [S21]; SGR-pixel mode implemented in the terminal model [S25] | `yes` OSC 8, "when clicked will open" the URL [S24] | `yes` `TERM_PROGRAM=WezTerm`, `TERM_PROGRAM_VERSION` [S26]; `WEZTERM_PANE`, `WEZTERM_UNIX_SOCKET` [S27]; `TERM` defaults to `xterm-256color` [S23b] | macOS supported [S21] |
| Alacritty | `unknown` [S17] | `yes` SGR cells, no 1016 listed [S17] | `yes` [S17][S20] | `partial` [S19] | macOS supported [S15] |

## Linux

| Terminal | Pixel images | Mouse | Hyperlinks | Recognise | Version / notes |
|---|---|---|---|---|---|
| GNOME Terminal (VTE) | `partial` sixel only if VTE was built with `-Dsixel=true`; the option defaults to `false` [S52]; kitty / iip `unknown` | `yes` SGR (1006) handled [S53]; pixel (1016) `unknown` | `yes` OSC 8 ("Handle OSC 8 hyperlinks") [S53]; "VTE and iTerm2 support OSC 8" [S43]; click gesture `unknown` | `unknown` (`VTE_VERSION` not found in the VTE or gnome-terminal sources read) | Claude Code: Shift+Enter not available in gnome-terminal [S2]. Distro build options not verified |
| Konsole | `yes` sixel handling in the emulation code [S55]; kitty graphics: listed as an implementer by kitty [S4], and "konsole does process some APCs (kitty images)" [S55] | `yes` 1005, 1006, 1015 and 1016 handled [S55] | `yes` OSC 8 parsed [S55]; direct click vs modifier is a profile option (`OpenLinksByDirectClick`) [S57] | `yes` `KONSOLE_DBUS_SERVICE`, `KONSOLE_DBUS_SESSION`, `WINDOWID` [S56]; `KONSOLE_VERSION` and `TERM_PROGRAM` not set there [S56] | Version of first sixel/kitty support not verified |
| kitty | `yes` kitty graphics (originator) [S4] | `yes` pixel coordinates (SGR-pixel) since 0.24.0 [S5] | `yes` OSC 8 since 0.19.0 [S5]; ctrl+shift+click in the documented example [S7] | `yes` `KITTY_WINDOW_ID`, `KITTY_PID`, `TERM=xterm-kitty` [S6] | |
| Ghostty | `yes` kitty graphics [S9]; sixel `unknown` | `yes` SGR (1006) and SGR-pixel (1016) formats enumerated in source [S11] | `yes` OSC 8 hyperlinks implemented in the screen model [S13]; Claude Code: plain click on a link opens it because Cmd is not encodable [S1] | `yes` `TERM_PROGRAM=ghostty`, `TERM_PROGRAM_VERSION` [S12]; `GHOSTTY_RESOURCES_DIR` when resources are found, `GHOSTTY_BIN_DIR` [S12] | Community packages [S10] |
| WezTerm | `yes` iip [S22] and kitty graphics [S21]; sixel `partial`: "preliminary and incomplete" [S23] | `yes` "SGR style mouse reporting" [S21]; SGR-pixel mode implemented in the terminal model [S25] | `yes` OSC 8, "when clicked will open" the URL [S24] | `yes` `TERM_PROGRAM=WezTerm`, `TERM_PROGRAM_VERSION` [S26]; `WEZTERM_PANE`, `WEZTERM_UNIX_SOCKET` [S27]; `TERM` defaults to `xterm-256color` [S23b] | Linux supported [S21] |
| Alacritty | `unknown` [S17] | `yes` SGR cells [S17] | `yes` [S17] | `partial` [S19] | Linux supported [S15] |
| foot | `yes` sixel [S28]; kitty `unknown` (not in README or control-sequence page [S28][S29]) | `yes` 1000, 1002, 1003, 1006, 1015 and 1016 "SGR-Pixels" [S29] | `yes` OSC 8 (VTE+iTerm2 origin) [S29]; click gesture `unknown` | `partial` `no` env var: "Foot does **not** set any environment variables that can be used to identify foot"; use tertiary DA `DCS ! \| 464f4f54 ST`, secondary DA, or XTVERSION (1.7.0+) [S28] | |
| xterm | `partial` sixel only when xterm "is configured to support" it [S50][S51]; kitty / iip `unknown` | `yes` SGR (1006) and SGR-Pixels (1016, "report position in pixels") [S50] | `unknown` (no OSC 8 entry in the control-sequences document) [S50] | `yes` `XTERM_VERSION`, `WINDOWID`, `XTERM_SHELL`, `XTERM_LOCALE` [S51]; XTVERSION query [S50] | Which distro builds enable sixel not verified |

## Multiplexers and hosts

| Host | Pixel images | Mouse | Hyperlinks | Recognise | Notes |
|---|---|---|---|---|---|
| VS Code integrated terminal (xterm.js) | `partial` sixel and iip, off by default, enabled by `terminal.integrated.enableImages` [S63]; image addon kitty support is "partially" and "WIP" [S66] but the VS Code page lists only sixel and iip [S63]; animated gifs and short images limited [S63] | `yes` 1000, 1002, 1003, 1006 and 1016; 1005 and 1015 not supported [S65] | `yes` OSC 8 (http, https, ftp, file, mailto) [S65]; Claude Code defers to the terminal's own handler and gesture [S1] | `yes` `TERM_PROGRAM=vscode`, `TERM_PROGRAM_VERSION` [S64]; `VSCODE_INJECTION` and other `VSCODE_*` vars with shell integration [S64b] | Claude Code `/terminal-setup` turns GPU acceleration off to avoid garbled text [S2]; one wheel event per notch [S1] |
| tmux | `partial` sixel only if built with `--enable-sixel` (3.4) [S58]; `sixel_support` format var in 3.6 [S58]; everything else only through `allow-passthrough` [S59] | `partial` needs `set -g mouse on`, otherwise events go to tmux [S1][S59]; SGR parsed as cell coordinates, no 1016 [S61] | `yes` OSC 8 since 3.4 [S58]; `hyperlinks` terminal feature [S59] | `yes` `TMUX`, `TMUX_PANE` [S59][S60]; `TERM_PROGRAM` and `TERM_PROGRAM_VERSION` exported since 3.2 [S58]; `TERM` must be `screen` or `tmux` [S59] | `allow-passthrough` default off since 3.3, third state `all` in 3.4 [S58]; DCS `tmux;` prefix for passthrough since 1.5 [S58]. kitty FAQ: advanced kitty features in tmux "may or may not work" [S8]. Mod platform: tmux passes no sub-cell position [S3] |
| GNU screen | `unknown` | `partial` mouse tracking `?1000` and `?9` listed; `mousetrack` selects split regions [S62]; SGR / pixel `unknown` | `unknown`; OSC 8 spec notes GNU screen is buggy for URLs over 700 characters [S54] | `yes` `STY`, `WINDOW`; `TERM=screen` by default [S62] | `ESC P` outputs a string directly to the host terminal [S62]. Claude Code copies long selections to the clipboard differently in screen [S1] |
| ssh | `unknown` | `unknown` | `unknown` (OSC 8 has no detection query, so a program cannot probe support [S54]) | `partial` only `TERM` is always forwarded; `SendEnv` / `AcceptEnv` default is to send / accept none [S67][S68], so `TERM_PROGRAM` and friends generally do not survive; use DA / XTVERSION queries | Claude Code: over SSH it falls back to OSC 52 for clipboard, notifications still reach the local terminal, and it "can't always detect the terminal you're connecting from" [S1][S2]. Fullscreen defaults to classic when SSH-ing to Claude Code on Windows [S1]. kitty's ssh kitten copies terminfo [S8] |

## What Claude Code and the mod platform say

**Claude Code docs** (read 2026-10-11)
- Fullscreen rendering captures the mouse; clicks, drag selection and wheel are handled in-app; `Cmd`-click on macOS, `Ctrl`-click elsewhere opens a URL or path [S1].
- "the terminal mouse protocol has no way to encode the `Cmd` key": in Ghostty and Warp on macOS Claude Code lets a plain click open links [S1].
- In VS Code and similar xterm.js terminals Claude Code "defers to the terminal's own link handler" [S1].
- iTerm2 needs "Enable mouse reporting" in the profile for wheel, click-to-expand and selection [S1].
- tmux: wheel needs `set -g mouse on`; incompatible with iTerm2 `tmux -CC`; tmux up to 3.6 lacks synchronized output [S1]. Passthrough needs `allow-passthrough on` for notifications and progress [S2].
- Desktop notification channels by default only in Ghostty, kitty and iTerm2 [S2]. OSC 7501 status protocol is terminal dependent [S2].
- Shift+Enter: works without setup in Ghostty, kitty, iTerm2, WezTerm, Warp, Apple Terminal, Windows Terminal; foot and Alacritty 0.16+ via kitty keyboard protocol; VS Code, Cursor, Alacritty before 0.16, Zed need `/terminal-setup`; gnome-terminal and JetBrains not available [S2].
- Windows: `^H` is read as Ctrl+Backspace except when `TERM_PROGRAM` is `mintty` or `TERM` is `cygwin` [S2].
- The docs name no "recommended terminal" list, and say nothing about images.

**Mod platform type file** (`.../tool-monitor/.claude-plugin/types/claude-code/index.d.ts`, read 2026-10-11) [S3]
- L1456-1480 `ClientPointerEvent.fine`: "The same position with the fraction of a cell kept (`x: 12`, `fine.x: 12.375`), where the surface knows it: a terminal that reports pixels." (L1468-1470) and "kitty, Ghostty, iTerm2, WezTerm and foot do; tmux passes none through. Absent elsewhere and on `enter`/`leave`" (L1471-1472).
- L1449-1450: "region-relative cells, and the sub-cell position where known."
- L5309-5311 `ImageProps`: "pixels over a box of cells where the terminal can (kitty, Ghostty), the `alt` elsewhere."
- L1409, L1415: `ClientElements` is the terminal element table "less `Client` (none nests), `Raster` and `Image`", so an `Image` cannot be drawn inside a `Client` region.
- L9246-9253 `RasterProps`: "the terminal surface's cell-grid leaf: a fixed box of cells, each a glyph, a foreground and a background"; usable where pixels are not.
- L5642-5644 and L9575-9577 `Link`: "an OSC 8 span on the terminal (else its text then the URL in dim)".
- L1769-1770 `CommandPresentation.isFullscreen`: false on the main screen "(`CLAUDE_CODE_NO_FLICKER=0`, tmux by default)".
- L14102 notification `channel`: `'iterm2' | 'iterm2_with_bell' | 'kitty' | 'ghostty' | 'terminal_bell'`.

Consistency check: the platform's list for `Image` (kitty, Ghostty) is narrower than the protocol's implementers (iTerm2, WezTerm, Konsole also implement kitty graphics per [S4][S42][S21][S55]); the platform's `fine` list (kitty, Ghostty, iTerm2, WezTerm, foot) matches what the sources show for those five, and the sources additionally show 1016 in mintty [S32], Konsole [S55], xterm [S50], xterm.js [S65].

## Sources

All read 2026-10-11. "Used for" lists the cells it supports.

| ID | URL | Used for |
|---|---|---|
| <a id="s1"></a>S1 | https://code.claude.com/docs/en/fullscreen | Claude Code mouse, links, tmux, VS Code, iTerm2, ssh |
| <a id="s2"></a>S2 | https://code.claude.com/docs/en/terminal-config | Shift+Enter table, notifications, tmux passthrough, mintty TERM_PROGRAM |
| <a id="s3"></a>S3 | `C:\Users\quent\.claude\dev-mods\5f91f982-dac4-426a-b273-d95336a0acc0\tool-monitor\.claude-plugin\types\claude-code\index.d.ts` | what the platform says (line numbers above) |
| <a id="s4"></a>S4 | https://sw.kovidgoyal.net/kitty/graphics-protocol/ | kitty graphics spec, list of implementers (Ghostty, Konsole, WezTerm, iTerm2, xterm.js, Warp) |
| <a id="s5"></a>S5 | https://raw.githubusercontent.com/kovidgoyal/kitty/master/docs/changelog.rst | SGR-pixel 0.24.0, hyperlinks 0.19.0, mouse-leave extension 0.42.2 |
| <a id="s6"></a>S6 | https://raw.githubusercontent.com/kovidgoyal/kitty/master/docs/glossary.rst | `KITTY_WINDOW_ID`, `KITTY_PID`, `TERM` |
| <a id="s7"></a>S7 | https://sw.kovidgoyal.net/kitty/open_actions/ | hyperlink support and ctrl+shift click example |
| <a id="s8"></a>S8 | https://sw.kovidgoyal.net/kitty/faq/ | tmux caveat, ssh kitten |
| <a id="s9"></a>S9 | https://raw.githubusercontent.com/ghostty-org/website/main/docs/features/index.mdx (rendered at https://ghostty.org/docs/features); S9b https://raw.githubusercontent.com/ghostty-org/ghostty/main/README.md | Ghostty platforms, kitty graphics, libghostty-vt on Windows |
| <a id="s10"></a>S10 | https://ghostty.org/docs/install/binary | binaries macOS only |
| <a id="s11"></a>S11 | https://raw.githubusercontent.com/ghostty-org/ghostty/main/src/terminal/mouse.zig | mouse event and format enums incl. `sgr_pixels` (1016) |
| <a id="s12"></a>S12 | https://raw.githubusercontent.com/ghostty-org/ghostty/main/src/termio/Exec.zig | `TERM_PROGRAM`, `GHOSTTY_RESOURCES_DIR`, `GHOSTTY_BIN_DIR` |
| <a id="s13"></a>S13 | https://raw.githubusercontent.com/ghostty-org/ghostty/main/src/terminal/hyperlink.zig | OSC 8 in the screen model |
| <a id="s15"></a>S15 | https://raw.githubusercontent.com/alacritty/alacritty/master/README.md; S15b https://api.github.com/repos/alacritty/alacritty/releases/latest (v0.17.0, 2026-04-06) | Alacritty platforms, release |
| <a id="s16"></a>S16 | https://raw.githubusercontent.com/alacritty/alacritty/master/docs/features.md | URL opening with the mouse, Shift bypass |
| <a id="s17"></a>S17 | https://raw.githubusercontent.com/alacritty/alacritty/master/extra/man/alacritty-escapes.7.scd | supported modes, OSC 8, DCS list |
| <a id="s19"></a>S19 | https://raw.githubusercontent.com/alacritty/alacritty/master/alacritty_terminal/src/tty/unix.rs | `ALACRITTY_WINDOW_ID` |
| <a id="s20"></a>S20 | https://raw.githubusercontent.com/alacritty/alacritty/master/CHANGELOG.md | OSC 8 added in 0.11.0 |
| <a id="s21"></a>S21 | https://raw.githubusercontent.com/wezterm/wezterm/main/docs/features.md; S21b https://api.github.com/repos/wezterm/wezterm/releases/latest | WezTerm features, platforms, latest tag |
| <a id="s22"></a>S22 | https://raw.githubusercontent.com/wezterm/wezterm/main/docs/imgcat.md | iip, multiplexer caveat |
| <a id="s23"></a>S23 | https://raw.githubusercontent.com/wezterm/wezterm/main/docs/escape-sequences.md; S23b .../docs/faq.md | sixel status, OSC 8, TERM default |
| <a id="s24"></a>S24 | https://raw.githubusercontent.com/wezterm/wezterm/main/docs/hyperlinks.md | OSC 8 |
| <a id="s25"></a>S25 | https://raw.githubusercontent.com/wezterm/wezterm/main/term/src/terminalstate/mod.rs | `SGRPixelsMouse` mode |
| <a id="s26"></a>S26 | https://raw.githubusercontent.com/wezterm/wezterm/main/config/src/config.rs | `TERM_PROGRAM` |
| <a id="s27"></a>S27 | https://raw.githubusercontent.com/wezterm/wezterm/main/mux/src/domain.rs | `WEZTERM_PANE` |
| <a id="s28"></a>S28 | https://codeberg.org/dnkl/foot/raw/branch/master/README.md | foot sixel, no env var, DA / XTVERSION |
| <a id="s29"></a>S29 | https://codeberg.org/dnkl/foot/raw/branch/master/doc/foot-ctlseqs.7.scd; S29b .../CHANGELOG.md | mouse modes incl. 1016, OSC 8 |
| <a id="s30"></a>S30 | https://mintty.github.io/mintty.1.html | sixel, images, OSC 8, pixel pointer |
| <a id="s31"></a>S31 | https://raw.githubusercontent.com/mintty/mintty/master/wiki/CtrlSeqs.md | OSC 8 Ctrl-click, identification replies |
| <a id="s32"></a>S32 | https://raw.githubusercontent.com/mintty/mintty/master/wiki/Changelog.md | 1016 in 3.4.0, TERM_PROGRAM caveat 3.1.5, 3.8.3 |
| <a id="s33"></a>S33 | https://raw.githubusercontent.com/mintty/mintty/master/src/child.c | `TERM_PROGRAM` set |
| <a id="s34"></a>S34 | https://github.com/microsoft/terminal/releases/tag/v1.22.2362.0 | sixel in Terminal and conhost |
| <a id="s35"></a>S35 | https://raw.githubusercontent.com/microsoft/terminal/main/src/terminal/input/terminalInput.hpp | mouse modes and encodings |
| <a id="s36"></a>S36 | https://raw.githubusercontent.com/microsoft/terminal/main/src/cascadia/TerminalControl/ControlInteractivity.cpp | Ctrl+click hyperlink |
| <a id="s37"></a>S37 | https://raw.githubusercontent.com/microsoft/terminal/main/src/cascadia/TerminalConnection/ConptyConnection.cpp | `WT_SESSION`, `WT_PROFILE_ID` |
| <a id="s38"></a>S38 | https://raw.githubusercontent.com/microsoft/terminal/main/src/terminal/adapter/adaptDispatch.cpp | `AddHyperlink`, Sixel parser, kitty keyboard |
| <a id="s39"></a>S39 | https://github.com/microsoft/terminal/releases/latest (v1.25.2733.0, "02 Oct", year not shown) | latest release notes |
| <a id="s40"></a>S40 | https://raw.githubusercontent.com/MicrosoftDocs/console-docs/main/docs/console-virtual-terminal-sequences.md | console VT sequences page has no mouse section |
| <a id="s41"></a>S41 | https://learn.microsoft.com/en-us/windows/terminal/faq | what conhost is; VS Code is xterm.js |
| <a id="s42"></a>S42 | https://iterm2.com/documentation-images.html | iip, kitty graphics |
| <a id="s43"></a>S43 | https://iterm2.com/documentation-escape-codes.html | OSC 8 |
| <a id="s45"></a>S45 | https://iterm2.com/documentation-preferences-profiles-terminal.html | mouse reporting settings |
| <a id="s46"></a>S46 | https://raw.githubusercontent.com/gnachman/iTerm2/master/sources/VT100/VT100Terminal.m | 1006, 1016, sixel |
| <a id="s47"></a>S47 | https://iterm2.com/documentation-url-scheme.html | `ITERM_SESSION_ID` |
| <a id="s48"></a>S48 | https://gitlab.com/gnachman/iterm2/-/issues/1025 | `TERM_PROGRAM=iTerm.app` mentioned by a user |
| <a id="s49"></a>S49 | https://support.apple.com/guide/terminal/turn-on-mouse-reporting-trmlc69728a5/mac | Terminal.app mouse reporting |
| <a id="s50"></a>S50 | https://invisible-island.net/xterm/ctlseqs/ctlseqs.html | 1006, 1016, sixel, XTVERSION |
| <a id="s51"></a>S51 | https://invisible-island.net/xterm/manpage/xterm.html | env vars, sixel resources |
| <a id="s52"></a>S52 | https://gitlab.gnome.org/GNOME/vte/-/raw/master/meson_options.txt | `sixel` option default false |
| <a id="s53"></a>S53 | https://gitlab.gnome.org/GNOME/vte/-/raw/master/src/vteseq.cc | OSC 8, SGR mouse (first 100000 characters only) |
| <a id="s54"></a>S54 | https://gist.github.com/egmontkob/eb114294efbcd5adb1944c9f3cb5feda | OSC 8 spec: no detection, buggy screen |
| <a id="s55"></a>S55 | https://invent.kde.org/utilities/konsole/-/raw/master/src/Vt102Emulation.cpp | Konsole sixel, OSC 8, kitty APC, mouse 1016 |
| <a id="s56"></a>S56 | https://invent.kde.org/utilities/konsole/-/raw/master/src/session/Session.cpp | Konsole env vars |
| <a id="s57"></a>S57 | https://invent.kde.org/utilities/konsole/-/raw/master/src/terminalDisplay/TerminalDisplay.cpp | link click option |
| <a id="s58"></a>S58 | https://raw.githubusercontent.com/tmux/tmux/master/CHANGES | sixel 3.4, OSC 8 3.4, passthrough 3.3/3.4, TERM_PROGRAM 3.2 |
| <a id="s59"></a>S59 | https://raw.githubusercontent.com/tmux/tmux/master/tmux.1 | options, terminal-features, TMUX_PANE |
| <a id="s60"></a>S60 | https://raw.githubusercontent.com/tmux/tmux/master/spawn.c | `TMUX_PANE` set |
| <a id="s61"></a>S61 | https://raw.githubusercontent.com/tmux/tmux/master/tty-keys.c | SGR mouse parsing, no 1016 |
| <a id="s62"></a>S62 | https://www.gnu.org/software/screen/manual/screen.html (first 200000 characters) | mouse, ESC P, STY, WINDOW |
| <a id="s63"></a>S63 | https://raw.githubusercontent.com/microsoft/vscode-docs/main/docs/terminal/advanced.md | images setting and limits |
| <a id="s64"></a>S64 | https://github.com/microsoft/vscode/commit/9c82ae899c79de07413af7cdbe262dbe4550abd0 (via issue #29426); S64b https://raw.githubusercontent.com/microsoft/vscode/main/src/vs/platform/terminal/node/terminalEnvironment.ts | `TERM_PROGRAM`, `VSCODE_*` |
| <a id="s65"></a>S65 | https://xtermjs.org/docs/api/vtfeatures/ | xterm.js mouse modes, OSC 8, sixel external |
| <a id="s66"></a>S66 | https://raw.githubusercontent.com/xtermjs/xterm.js/master/addons/addon-image/README.md | image addon protocols |
| <a id="s67"></a>S67 | https://man.openbsd.org/ssh_config | `SendEnv` default none, TERM always sent |
| <a id="s68"></a>S68 | https://man.openbsd.org/sshd_config | `AcceptEnv` default none |

## Open questions / unknown cells

1. **Terminal.app**: images, hyperlinks (OSC 8), mouse encodings (1006 / 1016), and `TERM_PROGRAM=Apple_Terminal` from an Apple source. Apple's Terminal guide has no escape-sequence reference.
2. **conhost**: mouse reporting, OSC 8 click behaviour, any identifier. Only the Terminal repo's shared code was read.
3. **Windows Terminal**: stable version that introduced sixel (Preview v1.22.2362.0 is the only version cited); kitty graphics and iip (no statement found).
4. **Alacritty**: images/sixel (absence from the escape list is not an explicit statement), `ALACRITTY_WINDOW_ID` on Windows, any `TERM_PROGRAM`.
5. **VTE / GNOME Terminal**: pixel mouse (1016), `VTE_VERSION`, which distro builds enable sixel, click gesture. Only the first 100000 characters of `vteseq.cc` were read, and VTE's NEWS and docs/modes pages could not be fetched.
6. **Konsole**: first version with sixel / kitty graphics; whether 1016 reports pixels (mode is handled, semantics not read).
7. **xterm**: OSC 8 (no entry found in the control-sequences document) and the `sixelGraphics` resource default.
8. **iTerm2**: `TERM_PROGRAM` and `LC_TERMINAL` from the owner; whether sixel is on by default.
9. **kitty / foot / Ghostty**: Ghostty sixel; foot kitty graphics; click modifier for OSC 8 in Ghostty and foot.
10. **GNU screen**: images, SGR / pixel mouse, OSC 8 passthrough. Manual read to character 200000 of 261440.
11. **tmux**: exact `TERM_PROGRAM` value (the changelog says it is exported, not to what); `TMUX` set location (man page says it is initialised, spawn.c sets only `TMUX_PANE`).
12. **ssh**: whether any image or mouse capability is lost over ssh was not stated by a primary source beyond the Claude Code notes.
13. **Versions**: no cell carries a per-feature terminal version except those cited above; Ghostty and WezTerm cells reflect default-branch docs, not a tagged release.
