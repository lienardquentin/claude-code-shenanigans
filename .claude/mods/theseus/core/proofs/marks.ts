import type { ChangedRun, Outcome, Radius, RunState, Target, TargetKind, TestResult } from '../../types'
import { MARK, under } from './project'
import type { Side, Changed } from './answers'

// Which test pins which run, and how each test ended on both builds.

// How a test is declared, by the language it is written in: Rust, Python, Go, and a JavaScript runner's call
export const DECLARED = [/\bfn\s+(\w+)/, /\bdef\s+(\w+)/, /\bfunc\s+(\w+)/, /\b(?:test|it)\s*\(\s*['"`](.+?)['"`]\s*,/]

export const MARKED = new RegExp(`${MARK}\\s+(.+?)\\s*(?:\\*/|-->)?\\s*$`)

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

// How a runner names a test as it ends: cargo, pytest -v, pytest's summary (-rfE), go test -v, TAP, and a JavaScript
// runner's tick or cross
export type Ended = 'pass' | 'fail' | 'skip'

// A skip as each runner says it: cargo's `ignored` (with its reason or without), pytest's SKIPPED, go's SKIP, TAP's # SKIP
export const ENDED: { pattern: RegExp; read: (found: RegExpExecArray) => [string, Ended] }[] = [
  { pattern: /^test (\S+) \.\.\. (ok|FAILED|ignored)\b/, read: found => [found[1] ?? '', found[2] === 'ok' ? 'pass' : found[2] === 'ignored' ? 'skip' : 'fail'] },
  { pattern: /^(\S+::\S+) (PASSED|FAILED|ERROR|SKIPPED)\b/, read: found => [found[1] ?? '', found[2] === 'PASSED' ? 'pass' : found[2] === 'SKIPPED' ? 'skip' : 'fail'] },
  { pattern: /^(FAILED|ERROR) (\S+)/, read: found => [found[2] ?? '', 'fail'] },
  { pattern: /^\s*--- (PASS|FAIL|SKIP): (\S+)/, read: found => [found[2] ?? '', found[1] === 'PASS' ? 'pass' : found[1] === 'SKIP' ? 'skip' : 'fail'] },
  { pattern: /^ok \d+(?: -)? (.+?)\s*# SKIP\b/i, read: found => [found[1] ?? '', 'skip'] },
  { pattern: /^(ok|not ok) \d+(?: -)? (.+?)\s*$/, read: found => [found[2] ?? '', found[1] === 'ok' ? 'pass' : 'fail'] },
  { pattern: /^\s*([✓✔]|[✗✘×✕])\s+(.+?)(?:\s+\(?\d+(?:\.\d+)?\s*m?s\)?)?\s*$/, read: found => [found[2] ?? '', /[✓✔]/.test(found[1] ?? '') ? 'pass' : 'fail'] },
]

/** How each test ended, by the name its runner gave it; a test said to fail once has failed, and one run once was not skipped. */
export const outcomesOf = (output: string): Record<string, Ended> => {
  const outcomes: Record<string, Ended> = {}

  for (const line of output.split('\n')) {
    for (const { pattern, read } of ENDED) {
      const found = pattern.exec(line)

      if (found === null) continue

      const [name, ended] = read(found)
      const was = outcomes[name]

      if (name !== '') outcomes[name] = was === 'fail' || ended === 'fail' ? 'fail' : was === 'pass' || ended === 'pass' ? 'pass' : 'skip'
      break
    }
  }

  return outcomes
}

/** Whether a runner's name for a test is the one a mark stands above: the same, or the same at the end of a path. */
export const isSameTest = (marked: string, ended: string): boolean => ended === marked || (ended.endsWith(marked) && /[^\w]$/.test(ended.slice(0, ended.length - marked.length)))

export const outcomeOf = (outcomes: Record<string, Ended>, test: string): Outcome => {
  const names = Object.keys(outcomes).filter(name => isSameTest(test, name))

  return names.length === 0 ? 'none' : names.some(name => outcomes[name] === 'fail') ? 'fail' : names.some(name => outcomes[name] === 'pass') ? 'pass' : 'skip'
}

/** Where a changed run stands, by how the tests marked on it ended on each side. */
export const stateOf = (tests: readonly TestResult[], isProved: boolean): RunState =>
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

/** The radius of a change: the kept runs the recorder said changed, each with the tests marked on it. */
export const radiusOf = (input: {
  label: string
  kind: TargetKind
  at: number
  diff: Changed
  marks: readonly { line: string; test: string }[]
}): Radius => ({
  ...(input.diff.unreached !== undefined ? { unreached: input.diff.unreached } : {}),
  label: input.label,
  kind: input.kind,
  at: input.at,
  summary: input.diff.summary,
  // A run kept twice (a request before and after another) is one part of the radius, as a mark names it once
  seams: input.diff.changed
    .filter((one, index, all) => all.findIndex(other => other.line === one.line) === index)
    .map(({ line, evidence }): ChangedRun => {
      const tests = [...new Set(input.marks.filter(mark => mark.line === line).map(mark => mark.test))].map((name): TestResult => ({ name, from: 'none', to: 'none' }))

      return { line, evidence, tests, state: stateOf(tests, false) }
    }),
  unchanged: [...new Set(input.diff.unchanged)].filter(line => !input.diff.changed.some(one => one.line === line)),
  isProved: false,
  unproved: '',
  turned: [],
  isStale: false,
  live: '',
})

export const sideName = (side: Side): string => (side.ref === 'work' ? 'the working tree' : side.sha === '' ? side.ref : `${side.ref} (${side.sha.slice(0, 7)})`)

export const lastLines = (output: string, lines: number): string => output.trim().split('\n').slice(-lines).join('\n')

/** Why a side's tests say nothing of any test: it was not run, or its runner named none (a build that fails). */
export const silent = (side: Side, outcomes: Record<string, unknown>): string =>
  side.error !== ''
    ? `The tests were not run on ${sideName(side)}: ${side.error}.`
    : Object.keys(outcomes).length === 0
      ? `The tests named no test on ${sideName(side)} (exit ${side.exitCode}):\n${lastLines(side.output, 8)}`
      : ''

/** The tests marked on the runs that changed, each once: the only tests in scope of a proof. */
export const markedTests = (radius: Radius): string[] => [...new Set(radius.seams.flatMap(seam => seam.tests.map(({ name }) => name)))]

/** Whether a test command says where the tests in scope are named: one that does not is never run. */
export const isNarrowable = (command: string): boolean => /\{tests(?::[^}]*)?\}/.test(command)

/**
 * A target's test command narrowed to the tests in scope: `{tests}` becomes their names, a space between, and
 * `{tests:SEP}` their names with SEP between (`-k "{tests: or }"` for pytest).
 */
export const narrowed = (command: string, names: readonly string[]): string => command.replace(/\{tests(?::([^}]*))?\}/g, (_, between: string | undefined) => names.join(between ?? ' '))

/**
 * A target's check or audit told the commit the change is compared with: `{against}` becomes it, as one word to the
 * shell whatever it holds (`deslop check --since {against}` judges only the lines the change added).
 */
export const gated = (command: string, against: string): string => command.replaceAll('{against}', `'${against.replaceAll("'", "'\\''")}'`)

/**
 * The radius once its tests were run on both sides: each changed run by how its own tests ended, and each test the
 * caller requires by how it ended. A test neither marked on a changed run nor required is out of scope, and not read.
 */
export const proved = (radius: Radius, proof: { from: Side; to: Side }, required: readonly string[] = []): Radius => {
  const inScope = [...markedTests(radius), ...required]
  const scoped = (outcomes: Record<string, Ended>) => Object.fromEntries(Object.entries(outcomes).filter(([name]) => inScope.some(test => isSameTest(test, name))))
  const before = scoped(outcomesOf(proof.from.output))
  const after = scoped(outcomesOf(proof.to.output))

  return {
    ...radius,
    seams: radius.seams.map(seam => {
      const tests = seam.tests.map(({ name }): TestResult => ({ name, from: outcomeOf(before, name), to: outcomeOf(after, name) }))

      return { ...seam, tests, state: stateOf(tests, true) }
    }),
    isProved: true,
    unproved: [silent(proof.from, before), silent(proof.to, after)].filter(said => said !== '').join('\n'),
    turned: Object.keys(after).filter(name => after[name] === 'fail' && before[name] === 'pass').sort(),
    ...(required.length > 0 ? { required: [...new Set(required)].map((name): TestResult => ({ name, from: outcomeOf(before, name), to: outcomeOf(after, name) })) } : {}),
  }
}

/** A test as its runner is told to run it alone: its own name, without the file or module a caller may put before it. */
export const testName = (name: string): string => name.split('::').at(-1)?.trim() ?? name

/** The tests a caller requires, each `{ file, name }`, that are a target's own: those in a file its tests name. */
export const requiredOf = (target: Pick<Target, 'tests'>, cwd: string, tests: readonly { file: string; name: string }[]): string[] =>
  tests.filter(test => target.tests.some(root => { const path = under(cwd, test.file); return path === root || path.startsWith(`${root}/`) })).map(test => testName(test.name))
