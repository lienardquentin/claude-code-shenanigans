import type { StingOutcome, StingRadius, StingSeam, StingState, StingSuite, StingTest } from '../types'

// Which tests a project names, what anduril said changed, which test is marked on which run, and how a test ended
// on each side. Text in, text out: nothing here touches the machine.

/** The project's own list of the integration tests of each tool, beside its other Claude files. */
export const PROJECT_FILE = '.claude/sting'

/** Where the checkouts a proof runs the tests in are kept, under the working directory: per machine, never committed. */
export const HOME = '.sting'

/** What a comment above a test says to mark it on a kept run: `sting: narsil show 999`. */
export const MARK = 'sting:'

/** A path with forward slashes and no trailing one, so two spellings of a folder compare equal. */
export const tidy = (path: string): string => path.replace(/\\/g, '/').replace(/\/+$/, '')

const under = (cwd: string, path: string): string => (/^([A-Za-z]:)?\//.test(tidy(path)) ? tidy(path) : `${tidy(cwd)}/${tidy(path).replace(/^\.\//, '')}`)

/**
 * What a project's file says, a line each and a `#` line a comment:
 *
 * - `label.tests=path,path`: the files and folders that hold the tool's integration tests;
 * - `label.test=command`: how they are run, from the project's folder, each test named as it ends.
 *
 * A tool with one and not the other is left out.
 */
export const parseProject = (text: string, cwd: string): StingSuite[] => {
  const tests = new Map<string, string[]>()
  const commands = new Map<string, string>()

  for (const raw of text.split('\n')) {
    const set = /^([\w.-]+)\.(tests|test)\s*=\s*(.+)$/.exec(raw.trim())

    if (set === null) continue

    const [, label = '', what, value = ''] = set

    if (what === 'test') commands.set(label, value.trim())
    else tests.set(label, value.split(',').map(path => path.trim()).filter(path => path !== '').map(path => under(cwd, path)))
  }

  return [...tests].flatMap(([label, paths]) => (paths.length > 0 && commands.has(label) ? [{ label, tests: paths, test: commands.get(label) ?? '' }] : []))
}

/**
 * What anduril's `diff` said, read back: the line that names the two builds, each kept run that changed with how,
 * and the ones that did not. `undefined` for an answer that is no comparison (no tool watched, a build that fails):
 * that answer is then the thing to say.
 */
export const parseDiffText = (text: string): { summary: string; changed: { line: string; evidence: string }[]; unchanged: string[] } | undefined => {
  const lines = text.split('\n')
  const head = /^(.+: \d+ of \d+ kept runs? changed)\./.exec(lines[0] ?? '')

  if (head === null) return undefined

  const changed: { line: string; evidence: string[] }[] = []
  const unchanged: string[] = []
  let open: { line: string; evidence: string[] } | undefined

  for (const line of lines.slice(1)) {
    if (line.startsWith('changed: ')) {
      open = { line: line.slice('changed: '.length).trim(), evidence: [] }
      changed.push(open)
    } else if (open !== undefined && line.startsWith('  ')) {
      open.evidence.push(line.slice(2))
    } else {
      open = undefined

      if (line.startsWith('unchanged: ')) unchanged.push(...line.slice('unchanged: '.length).split(' · ').map(one => one.trim()).filter(one => one !== ''))
    }
  }

  return { summary: head[1] ?? '', changed: changed.map(one => ({ line: one.line, evidence: one.evidence.join('\n') })), unchanged }
}

// How a test is declared, by the language it is written in: Rust, Python, Go, and a JavaScript runner's call
const DECLARED = [/\bfn\s+(\w+)/, /\bdef\s+(\w+)/, /\bfunc\s+(\w+)/, /\b(?:test|it)\s*\(\s*['"`](.+?)['"`]\s*,/]

const MARKED = new RegExp(`${MARK}\\s+(.+?)\\s*(?:\\*/|-->)?\\s*$`)

/** The marks a test file holds: each run named in a comment, with the test declared next beneath it. */
export const marksOf = (source: string): { line: string; test: string }[] => {
  const marks: { line: string; test: string }[] = []
  let waiting: string[] = []

  for (const line of source.split('\n')) {
    const mark = MARKED.exec(line)

    if (mark !== null) {
      waiting.push(mark[1] ?? '')
      continue
    }

    if (waiting.length === 0) continue

    const test = DECLARED.map(declared => declared.exec(line)?.[1]).find(name => name !== undefined)

    if (test !== undefined) {
      marks.push(...waiting.map(run => ({ line: run, test })))
      waiting = []
    }
  }

  return marks
}

// How a runner names a test as it ends: cargo, pytest -v, go test -v, TAP, and a JavaScript runner's tick or cross
const ENDED: { pattern: RegExp; read: (found: RegExpExecArray) => [string, boolean] }[] = [
  { pattern: /^test (\S+) \.\.\. (ok|FAILED)\s*$/, read: found => [found[1] ?? '', found[2] === 'ok'] },
  { pattern: /^(\S+::\S+) (PASSED|FAILED|ERROR)\b/, read: found => [found[1] ?? '', found[2] === 'PASSED'] },
  { pattern: /^\s*--- (PASS|FAIL): (\S+)/, read: found => [found[2] ?? '', found[1] === 'PASS'] },
  { pattern: /^(ok|not ok) \d+(?: -)? (.+?)\s*$/, read: found => [found[2] ?? '', found[1] === 'ok'] },
  { pattern: /^\s*([✓✔]|[✗✘×✕])\s+(.+?)(?:\s+\(?\d+(?:\.\d+)?\s*m?s\)?)?\s*$/, read: found => [found[2] ?? '', /[✓✔]/.test(found[1] ?? '')] },
]

/** How each test ended, by the name its runner gave it; a test said to fail once has failed. */
export const outcomesOf = (output: string): Record<string, 'pass' | 'fail'> => {
  const outcomes: Record<string, 'pass' | 'fail'> = {}

  for (const line of output.split('\n')) {
    for (const { pattern, read } of ENDED) {
      const found = pattern.exec(line)

      if (found === null) continue

      const [name, isPassed] = read(found)

      if (name !== '') outcomes[name] = isPassed && outcomes[name] !== 'fail' ? 'pass' : 'fail'
      break
    }
  }

  return outcomes
}

/** Whether a runner's name for a test is the one a mark stands above: the same, or the same at the end of a path. */
export const isSameTest = (marked: string, ended: string): boolean => ended === marked || (ended.endsWith(marked) && /[^\w]$/.test(ended.slice(0, ended.length - marked.length)))

const outcomeOf = (outcomes: Record<string, 'pass' | 'fail'>, test: string): StingOutcome => {
  const names = Object.keys(outcomes).filter(name => isSameTest(test, name))

  return names.length === 0 ? 'none' : names.some(name => outcomes[name] === 'fail') ? 'fail' : 'pass'
}

/** Where a changed run stands, by how the tests marked on it ended on each side. */
export const stateOf = (tests: readonly StingTest[], isProved: boolean): StingState =>
  tests.length === 0
    ? 'bare'
    : !isProved
      ? 'marked'
      : tests.some(test => test.to === 'fail')
        ? 'broken'
        : tests.some(test => test.from === 'fail' && test.to === 'pass')
          ? 'pinned'
          : tests.some(test => test.from === 'pass' && test.to === 'pass')
            ? 'loose'
            : 'marked'

/** The radius of a change: the kept runs anduril said changed, each with the tests marked on it. */
export const radiusOf = (input: {
  label: string
  at: number
  diff: { summary: string; changed: { line: string; evidence: string }[]; unchanged: string[] }
  marks: readonly { line: string; test: string }[]
}): StingRadius => ({
  label: input.label,
  at: input.at,
  summary: input.diff.summary,
  seams: input.diff.changed.map(({ line, evidence }): StingSeam => {
    const tests = [...new Set(input.marks.filter(mark => mark.line === line).map(mark => mark.test))].map((name): StingTest => ({ name, from: 'none', to: 'none' }))

    return { line, evidence, tests, state: stateOf(tests, false) }
  }),
  unchanged: input.diff.unchanged,
  isProved: false,
  unproved: '',
  turned: [],
  isStale: false,
})

type Side = { ref: string; sha: string; error: string; exitCode: number; output: string }

const text = (value: unknown): string => (typeof value === 'string' ? value : '')

const sideOf = (value: unknown): Side => {
  const held = (value !== null && typeof value === 'object' ? value : {}) as Record<string, unknown>

  return { ref: text(held.ref), sha: text(held.sha), error: text(held.error), exitCode: typeof held.exitCode === 'number' ? held.exitCode : -1, output: text(held.output) }
}

/** What the prove script answered; `undefined` when it answered nothing that reads. */
export const parseProof = (source: string): { from: Side; to: Side } | undefined => {
  let value: Record<string, unknown>

  try {
    value = JSON.parse(source) as Record<string, unknown>
  } catch {
    return undefined
  }

  return value === null || typeof value !== 'object' || typeof value.label !== 'string' ? undefined : { from: sideOf(value.from), to: sideOf(value.to) }
}

const sideName = (side: Side): string => (side.ref === 'work' ? 'the working tree' : side.sha === '' ? side.ref : `${side.ref} (${side.sha.slice(0, 7)})`)

const lastLines = (output: string, lines: number): string => output.trim().split('\n').slice(-lines).join('\n')

/** Why a side's tests say nothing of any test: it was not run, or its runner named none (a build that fails). */
const silent = (side: Side, outcomes: Record<string, unknown>): string =>
  side.error !== ''
    ? `The tests were not run on ${sideName(side)}: ${side.error}.`
    : Object.keys(outcomes).length === 0
      ? `The tests named no test on ${sideName(side)} (exit ${side.exitCode}):\n${lastLines(side.output, 8)}`
      : ''

/** The radius once its tests were run on both sides: each changed run by how its own tests ended, and the tests that turned. */
export const proved = (radius: StingRadius, proof: { from: Side; to: Side }): StingRadius => {
  const before = outcomesOf(proof.from.output)
  const after = outcomesOf(proof.to.output)

  return {
    ...radius,
    seams: radius.seams.map(seam => {
      const tests = seam.tests.map(({ name }): StingTest => ({ name, from: outcomeOf(before, name), to: outcomeOf(after, name) }))

      return { ...seam, tests, state: stateOf(tests, true) }
    }),
    isProved: true,
    unproved: [silent(proof.from, before), silent(proof.to, after)].filter(said => said !== '').join('\n'),
    turned: Object.keys(after).filter(name => after[name] === 'fail' && before[name] === 'pass').sort(),
  }
}

/** How many changed runs stand in each state. */
export const tally = (radius: StingRadius): Record<StingState, number> => {
  const counts: Record<StingState, number> = { bare: 0, marked: 0, pinned: 0, loose: 0, broken: 0 }
  for (const seam of radius.seams) counts[seam.state] += 1

  return counts
}

const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`

/** Whether every changed run is pinned and no test turned: nothing is owed. */
export const isQuiet = (radius: StingRadius): boolean => radius.seams.every(seam => seam.state === 'pinned') && radius.turned.length === 0

/** The radius in a line: how many kept runs changed and where they stand, and the tests that turned. */
export const radiusLine = (radius: StingRadius): string => {
  const counts = tally(radius)
  const states = (['pinned', 'marked', 'loose', 'broken', 'bare'] as const).filter(state => counts[state] > 0).map(state => `${counts[state]} ${state}`)

  return radius.seams.length === 0
    ? `${radius.label}: no kept run changed`
    : [`${radius.label}: ${plural(radius.seams.length, 'kept run', 'kept runs')} changed`, ...states, ...(radius.turned.length > 0 ? [plural(radius.turned.length, 'test turned', 'tests turned')] : [])].join(' · ')
}

/** What a changed run's state asks for, as a sentence. */
export const owed = (seam: StingSeam): string => {
  const names = seam.tests.map(test => test.name).join(', ')

  return {
    bare: `no test is marked on it. Write one that makes this run and asserts what it now does, with a comment \`${MARK} ${seam.line}\` above it.`,
    marked: `marked by ${names}, not proved: \`prove\` runs it on both sides.`,
    pinned: `pinned by ${names}: it fails on the commit's source and passes on the working tree.`,
    loose: `${names} ${seam.tests.length === 1 ? 'passes' : 'pass'} on both sides, so ${seam.tests.length === 1 ? 'it does' : 'they do'} not see the change: assert what changed.`,
    broken: `${seam.tests.filter(test => test.to === 'fail').map(test => test.name).join(', ')} ${seam.tests.filter(test => test.to === 'fail').length === 1 ? 'fails' : 'fail'} on the working tree.`,
  }[seam.state]
}

/** The radius in full, for the model: each changed run with where it stands and how it changed, then what is outside. */
export const radiusText = (radius: StingRadius): string =>
  [
    `${radius.summary}.`,
    radius.seams.length === 0 ? 'Nothing a kept run does changed: no integration test is owed.' : `${radiusLine(radius)}.`,
    ...(radius.isStale ? ['A file was edited since: this is of an earlier working tree.'] : []),
    ...radius.seams.flatMap(seam => ['', `${seam.state}: ${seam.line}`, `  ${owed(seam)}`, ...(seam.state === 'pinned' ? [] : seam.evidence.split('\n').filter(line => line !== '').map(line => `  ${line}`))]),
    ...(radius.turned.length > 0
      ? ['', `Passing on the commit's source and failing on the working tree: ${radius.turned.join(', ')}. Each pins what the change changed, and is to be brought to what the tool now does, or shows a regression.`]
      : []),
    ...(radius.unproved !== '' ? ['', radius.unproved] : []),
    ...(radius.unchanged.length > 0 ? ['', `Outside the radius, owed no test: ${radius.unchanged.join(' · ')}`] : []),
  ].join('\n')

/** How to have a tool's tests known, said where none are. */
export const HOW_TO = [
  `sting knows no integration tests here. Name those of a tool anduril watches in ${PROJECT_FILE}, a line each:`,
  '',
  '    narsil.tests=narsil/tests',
  '    narsil.test=cargo test --manifest-path narsil/Cargo.toml --test cli',
  '',
  'The files and folders that hold its integration tests, and the command that runs them from the project\'s folder, naming each test as it ends. Then /sting.',
].join('\n')
