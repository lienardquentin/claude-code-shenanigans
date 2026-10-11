import { TERMINALS } from './terminals'
import type { Terminal, Value } from './terminals'

export type Os = 'windows' | 'macos' | 'linux'

export const OS_NAMES: Record<Os, string> = { windows: 'Windows', macos: 'macOS', linux: 'Linux' }

/** How the mod reads a variable of the environment: `undefined` when it is not set. */
export type Env = (name: string) => string | undefined

// What identifies a terminal: a variable that is set, or one that has a given value. Each is one the research file
// cites for that terminal (a test holds the rules to the file's own words), and a terminal the file found no
// identifier for is never named: it is reported as not recognised.
type Rule = { terminal: string; set?: string; is?: readonly [string, string] }

const RULES: readonly Rule[] = [
  { terminal: 'Windows Terminal', set: 'WT_SESSION' },
  { terminal: 'kitty', set: 'KITTY_WINDOW_ID' },
  { terminal: 'WezTerm', is: ['TERM_PROGRAM', 'WezTerm'] },
  { terminal: 'WezTerm', set: 'WEZTERM_PANE' },
  { terminal: 'Alacritty', set: 'ALACRITTY_WINDOW_ID' },
  { terminal: 'Ghostty', is: ['TERM_PROGRAM', 'ghostty'] },
  { terminal: 'Ghostty', set: 'GHOSTTY_RESOURCES_DIR' },
  { terminal: 'iTerm2', set: 'ITERM_SESSION_ID' },
  { terminal: 'Konsole', set: 'KONSOLE_DBUS_SERVICE' },
  { terminal: 'mintty', is: ['TERM_PROGRAM', 'mintty'] },
  { terminal: 'VS Code integrated terminal', is: ['TERM_PROGRAM', 'vscode'] },
  { terminal: 'xterm', set: 'XTERM_VERSION' },
]

// The multiplexers a terminal may be inside, and what says so
const HOST_RULES: readonly Rule[] = [
  { terminal: 'tmux', set: 'TMUX' },
  { terminal: 'GNU screen', set: 'STY' },
]

/** The variables the rules read, so that the guide asks for exactly these. */
export const VARIABLES: readonly string[] = [
  ...new Set([...RULES, ...HOST_RULES].flatMap(rule => [rule.set, rule.is?.[0]].filter((name): name is string => name !== undefined))),
  'OS',
  'HOME',
]

/** The identifiers the rules rely on, as `NAME` or `NAME=value`, for a test to hold against the research file. */
export const IDENTIFIERS: readonly { terminal: string; text: string }[] = [...RULES, ...HOST_RULES].map(rule => ({
  terminal: rule.terminal,
  text: rule.set ?? `${rule.is?.[0]}=${rule.is?.[1]}`,
}))

const matches = (rule: Rule, env: Env): boolean =>
  rule.set !== undefined
    ? (env(rule.set) ?? '') !== ''
    : rule.is !== undefined && env(rule.is[0])?.toLowerCase() === rule.is[1].toLowerCase()

/** The operating system, from the environment: Windows sets `OS`; a home folder under /Users is a Mac's. */
export const detectOs = (env: Env): Os | undefined => {
  if (env('OS') === 'Windows_NT') return 'windows'

  const home = env('HOME') ?? ''
  if (home.startsWith('/Users/')) return 'macos'
  if (home.startsWith('/home/') || home === '/root') return 'linux'

  return undefined
}

/** The terminal the session runs in, as named in the research file, or `undefined` when the environment says none. */
export const detectTerminal = (env: Env): string | undefined => RULES.find(rule => matches(rule, env))?.terminal

/** The multiplexer the session runs inside, if the environment says one. */
export const detectHost = (env: Env): string | undefined => HOST_RULES.find(rule => matches(rule, env))?.terminal

/** The row of the research file for a terminal on an operating system (or any, when it is not given). */
export const rowFor = (name: string, os?: Os): Terminal | undefined => {
  const named = TERMINALS.filter(row => row.name === name || row.name.startsWith(`${name} `))

  // On a system it is not known for, the row of the system where the terminal exists at all comes first (Ghostty
  // has a row for Windows that says there is no build)
  return (
    named.find(row => row.os === os) ?? named.find(row => score(row) > 0) ?? named[0]
  )
}

const CAPABILITIES = ['images', 'mouse', 'links'] as const
export type Capability = (typeof CAPABILITIES)[number]

export const CAPABILITY_NAMES: Record<Capability, string> = {
  images: 'Pixel images',
  mouse: 'Mouse reporting',
  links: 'Clickable links',
}

const score = (row: Terminal): number => CAPABILITIES.filter(name => row[name].value === 'yes').length

/**
 * The terminals recommended on an operating system: those of the research file's table for it, ranked by how many of
 * pixel images, mouse reporting and clickable links it marks `yes`, the file's order breaking a tie. Only terminals
 * with at least two are named, and a terminal the file found does not exist on the system has none.
 */
export const recommended = (os: Os): Terminal[] =>
  TERMINALS.filter(row => row.os === os)
    .map((row, index) => ({ row, index }))
    .filter(entry => score(entry.row) >= 2)
    .sort((a, b) => score(b.row) - score(a.row) || a.index - b.index)
    .map(entry => entry.row)

/** The research file's table for an operating system. */
export const tableFor = (os: Os): Terminal[] => TERMINALS.filter(row => row.os === os)

/** The tone a value is drawn in. */
export const toneOfValue = (value: Value): 'success' | 'warning' | 'danger' | 'neutral' =>
  value === 'yes' ? 'success' : value === 'partial' ? 'warning' : value === 'no' ? 'danger' : 'neutral'

/**
 * What a terminal lacks, as lines: for each of pixel images, mouse reporting and clickable links that the file does
 * not mark `yes`, what it says, and which terminals on this operating system the file marks `yes` for it.
 */
export const gaps = (row: Terminal, os: Os | undefined): string[] =>
  CAPABILITIES.flatMap(name => {
    const capability = row[name]
    if (capability.value === 'yes') return []

    const others =
      os === undefined
        ? []
        : TERMINALS.filter(candidate => candidate.os === os && candidate[name].value === 'yes').map(candidate => candidate.name)
    const say = capability.value === 'unknown' ? 'not verified' : capability.value

    return [
      `${CAPABILITY_NAMES[name]}: ${say}${capability.note !== '' ? ` (${capability.note})` : ''}.${
        others.length > 0 ? ` On ${OS_NAMES[os as Os]} with it: ${others.join(', ')}.` : ''
      }`,
    ]
  })
