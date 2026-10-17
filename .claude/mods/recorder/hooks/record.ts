import type { RunCase, RunsDiff, RunOutcome, RecordedRun, BuildSide, WatchedTool } from '../types'

// What is watched, how a run reaches the shim, and a record read back and said. Text in, text out: nothing here
// touches the machine.

/** The project's own list of the tools it watches, one per line, beside its other Claude files. */
export const PROJECT_FILE = '.claude/recorder'

/** What the project's list was called before: read where the project has not renamed it. */
export const OLD_PROJECT_FILE = '.claude/recorder'

/** Where the launchers and the records are kept, under the working directory: per machine, and never committed. */
export const HOME = '.recorder'

/** A path with forward slashes and no trailing one, so two spellings of a folder compare equal. */
export const tidy = (path: string): string => path.replace(/\\/g, '/').replace(/\/+$/, '')

/** The path from the working directory, unless it is already whole. */
export const under = (cwd: string, path: string): string =>
  /^([A-Za-z]:)?\//.test(tidy(path)) ? tidy(path) : `${tidy(cwd)}/${tidy(path).replace(/^\.\//, '')}`

/**
 * One tool as the project's file writes it: `label=binary@root,root`. The label is the name it is run by, the
 * binary the built file a run of it runs, and the roots the source folders whose edits are edits of it.
 */
export const parseTarget = (spec: string, cwd: string): WatchedTool | undefined => {
  const found = /^([\w.-]+)\s*=\s*(.+)$/.exec(spec.trim())

  if (found === null) return undefined

  const [, label = '', rest = ''] = found
  const cut = rest.lastIndexOf('@')
  const binary = (cut === -1 ? rest : rest.slice(0, cut)).trim()
  const roots = cut === -1 ? [] : rest.slice(cut + 1).split(',').map(root => root.trim()).filter(root => root !== '')

  return binary === '' ? undefined : { label, binary: under(cwd, binary), roots: roots.map(root => under(cwd, root)), build: '', masks: [] }
}

/**
 * What a project's file says, a line each and a `#` line a comment:
 *
 * - `label=binary@root`: a tool to watch;
 * - `label.build=command`: how it is built, from the project's folder;
 * - `label.mask=regex`: what to leave out of its streams when two builds are compared (a time, a process id);
 * - `$ label args`: a run kept to be played again, in the tool's source folder.
 *
 * What does not read is left out, a label is one tool, and a build or a mask of a tool the file does not name is
 * dropped.
 */
export const parseProject = (text: string, cwd: string): { targets: WatchedTool[]; corpus: string[] } => {
  const byLabel = new Map<string, WatchedTool>()
  const builds = new Map<string, string>()
  const masks = new Map<string, string[]>()
  const corpus: string[] = []

  for (const raw of text.split('\n')) {
    const line = raw.trim()
    const kept = /^\$\s+(.+)$/.exec(line)
    const set = /^([\w.-]+)\.(build|mask)\s*=\s*(.+)$/.exec(line)

    if (line === '' || line.startsWith('#')) continue

    if (kept !== null) {
      if (!corpus.includes(kept[1] ?? '')) corpus.push(kept[1] ?? '')
    } else if (set !== null) {
      const [, label = '', what, value = ''] = set

      if (what === 'build') builds.set(label, value.trim())
      else masks.set(label, [...(masks.get(label) ?? []), value.trim()])
    } else {
      const target = parseTarget(line, cwd)

      if (target !== undefined) byLabel.set(target.label, target)
    }
  }

  return { targets: [...byLabel.values()].map(target => ({ ...target, build: builds.get(target.label) ?? '', masks: masks.get(target.label) ?? [] })), corpus }
}

/** Every tool a project's file names. */
export const parseTargets = (text: string, cwd: string): WatchedTool[] => parseProject(text, cwd).targets

/** A path of the project's folder as the same path in a quest's worktree; any other path as it is. */
const moved = (home: string, tree: string, path: string): string => (path === tidy(home) ? tidy(tree) : path.startsWith(`${tidy(home)}/`) ? `${tidy(tree)}${path.slice(tidy(home).length)}` : path)

/**
 * What a quest's worktree is played by: the tools, their builds and binaries as the project's own file says them (a
 * command run on the machine is never read from a branch), moved into the worktree; the runs to play, the project's
 * own, then those the branch keeps besides. A run the branch takes out of its file is played still: the change it
 * proves cannot shrink what proves it.
 */
export const projectInTree = (home: { text: string; cwd: string }, tree: { text: string; cwd: string }): { targets: WatchedTool[]; corpus: string[] } => {
  const kept = parseProject(home.text, home.cwd).corpus

  return {
    targets: parseProject(home.text, home.cwd).targets.map(target => ({ ...target, binary: moved(home.cwd, tree.cwd, target.binary), roots: target.roots.map(root => moved(home.cwd, tree.cwd, root)) })),
    corpus: [...kept, ...parseProject(tree.text, tree.cwd).corpus.filter(line => !kept.includes(line))],
  }
}

/** The kept runs that are runs of one tool. */
export const corpusOf = (corpus: readonly string[], label: string): string[] => corpus.filter(line => line.split(/\s+/)[0] === label)

/** The project's file with one more run kept at its end; as it was when the run is already kept. */
export const withKept = (text: string, line: string): string =>
  text.split('\n').some(one => one.trim() === `$ ${line}`) ? text : `${text === '' || text.endsWith('\n') ? text : `${text}\n`}$ ${line}\n`

/** A word as a POSIX shell reads it back whole. */
export const shQuote = (text: string): string => (/^[\w@%+=:,./-]+$/.test(text) ? text : `'${text.replace(/'/g, `'\\''`)}'`)

const quoted = (text: string): string => `'${text.replace(/'/g, `'\\''`)}'`

/** Where a tool's launcher is: a file named as the tool, in a folder put first on the PATH. */
export const binDir = (cwd: string): string => `${tidy(cwd)}/${HOME}/bin`

/** The launcher: the tool's name on the PATH, which hands the run to the shim with the binary to run. */
export const launcher = (input: { shim: string; cwd: string; target: WatchedTool }): string =>
  [
    '#!/bin/sh',
    `# Written by the recorder from ${PROJECT_FILE}: runs ${input.target.label} and keeps a record of the run.`,
    `exec python3 ${quoted(tidy(input.shim))} --dir ${quoted(`${tidy(input.cwd)}/${HOME}`)} --label ${quoted(input.target.label)} --binary ${quoted(input.target.binary)} -- "$@"`,
    '',
  ].join('\n')

/** Whether a command's text names one of the tools as a word: only such a command is given the launchers. */
export const names = (command: string, targets: readonly WatchedTool[]): boolean =>
  targets.some(({ label }) => new RegExp(`(^|[^\\w./-])${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\w/-])`).test(command))

/** The one line put before a command of Claude's: the launchers first on the PATH, and who is running. */
export const prelude = (cwd: string): string => `export PATH=${quoted(binDir(cwd))}:"$PATH" RECORDER_BY=claude\n`

const text = (value: unknown): string => (typeof value === 'string' ? value : '')
const number = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)

/** A record as the shim wrote it; `undefined` for a file that is none, or is half written. */
export const parseRun = (source: string): RecordedRun | undefined => {
  let value: Record<string, unknown>

  try {
    value = JSON.parse(source) as Record<string, unknown>
  } catch {
    return undefined
  }

  if (value === null || typeof value !== 'object' || typeof value.id !== 'string' || !Array.isArray(value.argv)) return undefined

  const env = value.env !== null && typeof value.env === 'object' ? (value.env as Record<string, unknown>) : {}

  return {
    id: value.id,
    label: text(value.label),
    argv: value.argv.map(text),
    cwd: text(value.cwd),
    by: value.by === 'claude' ? 'claude' : 'person',
    startedAt: number(value.startedAt),
    durationMs: number(value.durationMs),
    exitCode: number(value.exitCode),
    signal: text(value.signal),
    userMs: number(value.userMs),
    sysMs: number(value.sysMs),
    maxRssKb: number(value.maxRssKb),
    isStdinTty: value.isStdinTty === true,
    isStdoutTty: value.isStdoutTty === true,
    isStderrTty: value.isStderrTty === true,
    columns: number(value.columns),
    env: Object.fromEntries(Object.entries(env).map(([name, held]) => [name, text(held)])),
    binary: text(value.binary),
    builtAt: number(value.builtAt),
    stdout: text(value.stdout),
    stderr: text(value.stderr),
    stdoutBytes: number(value.stdoutBytes),
    stderrBytes: number(value.stderrBytes),
  }
}

/** A text held to so many characters: its start and its end, half each, with a line between saying what is left out. */
export const ends = (text: string, chars: number): string => {
  if (text.length <= chars) return text

  const half = Math.floor(chars / 2)

  return `${text.slice(0, half)}\n… ${text.length - 2 * half} characters not held here …\n${text.slice(text.length - half)}`
}

/** The run with each stream held to its start and its end: what the session holds of it. */
export const trimmed = (run: RecordedRun, chars: number): RecordedRun => ({ ...run, stdout: ends(run.stdout, chars), stderr: ends(run.stderr, chars) })

/**
 * The lines of a stream as the pane draws them: all of them, or the first and the last with a line between saying
 * how many are not drawn. A tool that fails says why at the end.
 */
export const excerpt = (lines: readonly string[], most: number): string[] => {
  if (lines.length <= most) return [...lines]

  const first = Math.ceil(most / 2)
  const last = most - first

  return [...lines.slice(0, first), `… ${lines.length - most} lines not drawn …`, ...lines.slice(lines.length - last)]
}

/** The run as it was typed. */
export const commandLine = (run: Pick<RecordedRun, 'label' | 'argv'>): string => [run.label, ...run.argv.map(shQuote)].join(' ')

/** How long, for a person: `4.2 ms`, `310 ms`, `2.31 s`. */
export const duration = (ms: number): string => (ms < 10 ? `${ms.toFixed(1)} ms` : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`)

/** How much, for a person: `812 B`, `5.3 kB`, `92 MB`. */
export const size = (bytes: number): string =>
  bytes < 1000 ? `${bytes} B` : bytes < 1_000_000 ? `${(bytes / 1000).toFixed(1)} kB` : `${Math.round(bytes / 1_000_000)} MB`

/** The time of day a run started, to the second. */
export const clock = (ms: number): string => {
  const at = new Date(ms)
  const two = (value: number) => String(value).padStart(2, '0')

  return `${two(at.getHours())}:${two(at.getMinutes())}:${two(at.getSeconds())}`
}

/** How a run ended, in a word or two: `0`, `1`, `101 panic`, `143 SIGTERM`. */
export const ending = (run: Pick<RecordedRun, 'exitCode' | 'signal' | 'stderr'>): string =>
  run.signal !== '' ? `${run.exitCode} ${run.signal}` : run.exitCode === 101 && /panicked at /.test(run.stderr) ? '101 panic' : String(run.exitCode)

const ESCAPES = /\u001b\[[0-9;?]*[ -/]*[@-~]/g

/** What a stream wrote with its colours taken out, as a reader of it would see the text. */
export const plain = (stream: string): string => stream.replace(ESCAPES, '')

/** Whether a stream holds terminal escape codes. */
export const hasEscapes = (stream: string): boolean => /\u001b\[/.test(stream)

/**
 * What a terminal element may draw of a stream: the escapes gone, a carriage return a new line, and no other
 * control character but tab and newline, which make a tree refused.
 */
// eslint-disable-next-line no-control-regex
export const drawable = (stream: string): string => plain(stream).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')

/** What stands out about how a run was made and what it wrote, each as a short sentence: what a reader should not miss. */
export const remarks = (run: RecordedRun): string[] => [
  ...(run.stdoutBytes > 0 && !run.isStdoutTty && hasEscapes(run.stdout) ? ['It wrote terminal escape codes to a stdout that was no terminal.'] : []),
  ...(run.exitCode !== 0 && run.stderrBytes === 0 ? ['It failed and wrote nothing to stderr.'] : []),
  ...(/Broken pipe/.test(run.stderr) ? ['Whoever read its output left before it was done (a broken pipe).'] : []),
]

const cutNote = (kept: string, bytes: number, shown: number): string => {
  const left = kept.length - shown

  return left > 0 ? `\n… ${left} more characters kept, ${size(bytes)} written in all` : ''
}

const streamText = (name: string, kept: string, bytes: number, max: number, isTty: boolean): string => {
  if (bytes === 0) return `${name}: nothing`

  const shown = kept.slice(0, max)

  return `${name} (${size(bytes)}${isTty ? ', to a terminal' : ''}):\n${shown.trimEnd()}${cutNote(kept, bytes, shown.length)}`
}

/** One run in full, for the model: what was run and how, how it ended, what it cost and what it wrote. */
export const runText = (run: RecordedRun, max: number): string => {
  const env = Object.entries(run.env).map(([name, value]) => `${name}=${value}`)
  const said = remarks(run)

  return [
    `Run ${run.id}: ${commandLine(run)}`,
    `by ${run.by === 'claude' ? 'Claude' : 'the person'} at ${clock(run.startedAt)}, in ${run.cwd}`,
    `exit ${ending(run)} after ${duration(run.durationMs)} (cpu ${duration(run.userMs)} user, ${duration(run.sysMs)} system; ${size(run.maxRssKb * 1024)} of memory at most)`,
    `stdin ${run.isStdinTty ? 'a terminal' : 'not a terminal'}, stdout ${run.isStdoutTty ? 'a terminal' : 'not a terminal'}, stderr ${run.isStderrTty ? 'a terminal' : 'not a terminal'}${run.columns > 0 ? `, ${run.columns} columns` : ''}${env.length > 0 ? `; ${env.join(' ')}` : ''}`,
    ...(said.length > 0 ? [said.join(' ')] : []),
    '',
    streamText('stdout', run.stdout, run.stdoutBytes, max, run.isStdoutTty),
    '',
    streamText('stderr', run.stderr, run.stderrBytes, max, run.isStderrTty),
  ].join('\n')
}

/** The runs as a list, newest last, for the model: one line each, which `run` then opens by its id. */
export const runsText = (runs: readonly RecordedRun[], total: number): string =>
  runs.length === 0
    ? 'No run matches.'
    : [
        `${runs.length} of ${total} recorded ${total === 1 ? 'run' : 'runs'}, oldest first. \`run\` with an id says one in full.`,
        ...runs.map(run => `${run.id}  ${clock(run.startedAt)}  ${run.by === 'claude' ? 'claude' : 'person'}  exit ${ending(run)}  ${duration(run.durationMs)}  ${commandLine(run)}`),
      ].join('\n')

/** How to have a tool watched, said where nothing is. */
export const HOW_TO_WATCH = [
  `The recorder watches no tool here. Name one in ${PROJECT_FILE}, a line each:`,
  '',
  '    narsil=narsil/target/debug/narsil@narsil',
  '',
  'The name it is run by, the built binary a run of it runs, and after @ the folder of its source. Then /recorder.',
].join('\n')

const outcomeOf = (value: unknown): RunOutcome => {
  const held = (value !== null && typeof value === 'object' ? value : {}) as Record<string, unknown>

  return {
    exitCode: number(held.exitCode),
    signal: text(held.signal),
    durationMs: number(held.durationMs),
    stdoutBytes: number(held.stdoutBytes),
    stderrBytes: number(held.stderrBytes),
    error: text(held.error),
  }
}

const sideOf = (value: unknown): BuildSide => {
  const held = (value !== null && typeof value === 'object' ? value : {}) as Record<string, unknown>

  return { ref: text(held.ref), sha: text(held.sha), error: text(held.error) }
}

const bothOf = (value: unknown): { from: string[]; to: string[] } => {
  const held = (value !== null && typeof value === 'object' ? value : {}) as Record<string, unknown>
  const paths = (list: unknown): string[] => (Array.isArray(list) ? list.map(text) : [])

  return { from: paths(held.from), to: paths(held.to) }
}

/** What the replay script answered; `undefined` when it answered nothing that reads. */
export const parseDiff = (source: string, at: number): RunsDiff | undefined => {
  let value: Record<string, unknown>

  try {
    value = JSON.parse(source) as Record<string, unknown>
  } catch {
    return undefined
  }

  if (value === null || typeof value !== 'object' || typeof value.label !== 'string') return undefined

  const rows = (held: unknown): Record<string, unknown>[] => (Array.isArray(held) ? (held as Record<string, unknown>[]) : [])

  return {
    label: value.label,
    at,
    from: sideOf(value.from),
    to: sideOf(value.to),
    error: text(value.error),
    untraced: text(value.untraced),
    cases: rows(value.cases).map(one => ({
      line: text(one.line),
      isChanged: one.isChanged === true,
      from: outcomeOf(one.from),
      to: outcomeOf(one.to),
      stdoutDiff: text(one.stdoutDiff),
      stderrDiff: text(one.stderrDiff),
      files: rows(one.files).map(file => ({ path: text(file.path), change: file.change === 'added' ? 'added' : file.change === 'removed' ? 'removed' : 'changed', diff: text(file.diff) })),
      outside: bothOf(one.outside),
      transient: bothOf(one.transient),
    })),
  }
}

/** A build as a person names it: `the working tree`, `HEAD (223f934)`. */
export const sideName = (side: BuildSide): string => (side.ref === 'work' ? 'the working tree' : side.sha === '' ? side.ref : `${side.ref} (${side.sha.slice(0, 7)})`)

const endOf = (outcome: RunOutcome): string => (outcome.error !== '' ? outcome.error : outcome.signal !== '' ? `${outcome.exitCode} ${outcome.signal}` : String(outcome.exitCode))

/** How a run's ending changed between the two builds, `exit 1 → 2`; empty when it ended the same. */
export const exitChange = (one: RunCase): string => (endOf(one.from) === endOf(one.to) ? '' : `exit ${endOf(one.from)} → ${endOf(one.to)}`)

const sameList = (one: readonly string[], other: readonly string[]): boolean => one.length === other.length && one.every((path, index) => path === other[index])

const pathsNote = (diff: RunsDiff, both: { from: string[]; to: string[] }, what: string): string[] =>
  sameList(both.from, both.to)
    ? []
    : [`${what}: ${sideName(diff.from)} ${both.from.length > 0 ? both.from.join(', ') : 'nothing'}; ${sideName(diff.to)} ${both.to.length > 0 ? both.to.join(', ') : 'nothing'}`]

/**
 * What a run did to files that the two builds do not agree on, each as a line: a file it left that differs, what
 * it wrote outside the place it was played in, and what it wrote and removed again.
 */
export const fileNotes = (diff: RunsDiff, one: RunCase): string[] => [
  ...one.files.map(({ path, change }) => `file ${path}: ${change === 'added' ? `${sideName(diff.to)} alone left it` : change === 'removed' ? `${sideName(diff.from)} alone left it` : 'not the same'}`),
  ...pathsNote(diff, one.outside, 'written outside the folder'),
  ...pathsNote(diff, one.transient, 'written and removed again'),
]

/** Every file a run of either build wrote outside the place it was played in: those writes reached the machine. */
export const writtenOutside = (diff: RunsDiff): string[] => [...new Set(diff.cases.flatMap(one => [...one.outside.from, ...one.outside.to]))].sort()

/** What stands in the way of a comparison, each as a sentence; none when both builds were played. */
export const diffProblems = (diff: RunsDiff): string[] => [
  ...(diff.error !== '' ? [`Nothing was played: ${diff.error}.`] : []),
  ...[diff.from, diff.to].filter(side => side.error !== '').map(side => `${sideName(side)} was not played: ${side.error}`),
]

/** A comparison in a line: which builds, and how many of the kept runs changed. */
export const diffSummary = (diff: RunsDiff): string => {
  const changed = diff.cases.filter(one => one.isChanged).length

  return `${diff.label}, ${sideName(diff.to)} against ${sideName(diff.from)}: ${diffProblems(diff).length > 0 ? 'not compared' : `${changed} of ${diff.cases.length} kept ${diff.cases.length === 1 ? 'run' : 'runs'} changed`}`
}

/** A comparison in full, for the model: each run that changed with how, then the runs that did not, by name. */
export const diffText = (diff: RunsDiff): string => {
  const problems = diffProblems(diff)

  if (problems.length > 0) return [`${diffSummary(diff)}.`, ...problems].join('\n')

  const changed = diff.cases.filter(one => one.isChanged)
  const same = diff.cases.filter(one => !one.isChanged)

  return [
    `${diffSummary(diff)}. Each was played on both builds in a copy of the tool's source folder, with no terminal; a line with - is ${sideName(diff.from)}'s, one with + ${sideName(diff.to)}'s.`,
    ...changed.flatMap(one => [
      '',
      `changed: ${one.line}`,
      ...(exitChange(one) !== '' ? [`  ${exitChange(one)}`] : []),
      ...fileNotes(diff, one).map(line => `  ${line}`),
      ...[one.stdoutDiff, one.stderrDiff, ...one.files.map(file => file.diff)].filter(part => part !== '').map(part => plain(part).replace(/^/gm, '  ')),
    ]),
    ...(same.length > 0 ? ['', `unchanged: ${same.map(one => one.line).join(' · ')}`] : []),
    ...(writtenOutside(diff).length > 0 ? ['', `Written outside the folder the runs were played in, so on this machine: ${writtenOutside(diff).join(', ')}.`] : []),
    ...(diff.untraced !== '' ? ['', `No run was traced (${diff.untraced}): what a run writes outside the folder it is played in, or writes and removes again, was not seen.`] : []),
  ].join('\n')
}
