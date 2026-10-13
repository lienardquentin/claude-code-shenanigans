import type { Case, ScenarioState, Suite } from '../types'
import { GLYPH, STATE_TEXT, STATE_TONE } from './e2e'
import type { TreeNode } from './kit/tree'

// The unit tests of the project: the suites Claude named, each a command, run from the pane and read by how it
// exits, its tests read off the lines it printed. Here are the list's changes and its texts; the running is the
// hooks module's. Values in, values out.

const MAX_SUITES = 20
const MAX_CASES = 400
const OUTPUT_CHARS = 4_000

/** How long a suite may run: what the engine allows a command at most. */
export const SUITE_TIMEOUT_MS = 600_000

export const HOW_TO_PLAN_UNIT =
  "No suite yet. Plan has Claude find the project's unit test commands and name them here (mcp__palantir__unit_plan), each under the app it tests. Each is then run from this pane, one after another, and read by how it exits; its tests are listed under it, read off what it printed."

/** What the pane's Plan button asks of Claude. */
export const PLAN_UNIT_PROMPT =
  "Find the unit test suites of this project (each app's own: its package.json scripts, pyproject, Makefile, CI), then name them with mcp__palantir__unit_plan, one suite per command, each with the folder it runs in and the watched app it tests as its target. Have each command print a line per test (pytest -v, vitest --reporter=verbose, go test -v), so the pane can list them. Do not run them."

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

export type PlannedSuites = { suites: Suite[]; refused: string[] }

/**
 * The suites as a plan leaves them, in place of the ones held. A command is an argument vector, as no shell reads
 * it: one written as a line is refused, and so is one with no name. `labels` are the watched apps.
 */
export const plannedSuites = (asked: { suites?: unknown }, labels: readonly string[]): PlannedSuites => {
  const refused: string[] = []
  const suites: Suite[] = []

  for (const [index, item] of (Array.isArray(asked.suites) ? asked.suites : []).entries()) {
    const { name, command, cwd, target } = (typeof item === 'object' && item !== null ? item : {}) as Record<string, unknown>
    const argv = Array.isArray(command) ? command.filter((part): part is string => typeof part === 'string' && part !== '') : []

    if (text(name) === '' || argv.length === 0 || argv.length !== (Array.isArray(command) ? command.length : -1)) {
      refused.push(`suite ${index + 1} has ${text(name) === '' ? 'no name' : 'no command written as a list of arguments'}`)
      continue
    }

    if (suites.length >= MAX_SUITES) {
      refused.push(`the list holds ${MAX_SUITES} suites: "${text(name)}" is left out`)
      continue
    }

    suites.push({ id: String(suites.length + 1), name: text(name).slice(0, 80), target: labels.includes(text(target)) ? text(target) : '', argv, cwd: text(cwd), state: 'todo', note: '', output: '', at: 0, ms: 0 })
  }

  return { suites, refused }
}

/** The suites of one app, which the pane shows when that app is picked; all of them when none is. */
export const suitesOf = <Held extends { target: string }>(held: readonly Held[], picked: string): Held[] => held.filter(({ target }) => picked === '' || target === picked)

/** The suites with the ones named (all, when none is) waiting to be run; one that waits or runs goes on. */
export const queuedSuites = (held: readonly Suite[], ids: readonly string[]): Suite[] =>
  held.map(suite => (suite.state !== 'running' && suite.state !== 'queued' && (ids.length === 0 || ids.includes(suite.id)) ? { ...suite, state: 'queued', note: '', output: '', tests: [] } : suite))

/** What a command printed and how it exited; none when it could not start or outlived its time, with why. */
export type Ended = { exitCode: number; stdout: string; stderr: string } | { failure: string }

const plainLines = (printed: string): string[] =>
  printed
    .split('\n')
    // eslint-disable-next-line no-control-regex
    .map(line => line.replace(/\u001B\[[0-9;]*[A-Za-z]/g, '').trim())
    .filter(line => line !== '')

const lastLine = (printed: string): string => plainLines(printed).pop() ?? ''

const PYTEST: Record<string, Case['state']> = { PASSED: 'passed', XFAIL: 'passed', FAILED: 'failed', ERROR: 'failed', XPASS: 'failed', SKIPPED: 'skipped' }
const MARK: Record<string, Case['state']> = { '✓': 'passed', '✔': 'passed', '×': 'failed', '✗': 'failed', '✕': 'failed', '↓': 'skipped', '○': 'skipped' }
const GO: Record<string, Case['state']> = { PASS: 'passed', FAIL: 'failed', SKIP: 'skipped' }

// One printed line as the test it reports, in the words of the runners that say a test a line
const caseOf = (line: string): Case | undefined => {
  // pytest -v: tests/test_rohan.py::test_health PASSED   [  9%]
  const pytest = /^(\S+?::.+?) (PASSED|FAILED|ERROR|SKIPPED|XFAIL|XPASS)(?:\s+\(.*\))?(?:\s+\[\s*\d+%\])?$/.exec(line)

  if (pytest !== null) return { name: (pytest[1] ?? '').replace(/^(?:[^:]*\/)?([^/:]+)::/, '$1 > ').replace(/::/g, ' > '), state: PYTEST[pytest[2] ?? ''] ?? 'failed', ms: 0 }

  // vitest --reporter=verbose and jest --verbose: ✓ tests/names.test.ts > named > writes a stone too 2ms
  const marked = /^([✓✔×✗✕↓○])\s+(.+?)(?:\s+\(?(\d+)\s?ms\)?)?$/u.exec(line)

  // A line for a whole file (its tests counted) is no test
  if (marked !== null && !/\(\d+ tests?[^)]*\)$/.test(marked[2] ?? '')) return { name: (marked[2] ?? '').replace(/^(?:\S*\/)?(\S+ > )/, '$1'), state: MARK[marked[1] ?? ''] ?? 'failed', ms: Number(marked[3] ?? 0) }

  // go test -v: --- PASS: TestMuster (0.02s)
  const go = /^--- (PASS|FAIL|SKIP): (\S+)(?: \((\d+(?:\.\d+)?)s\))?$/.exec(line)

  if (go !== null) return { name: go[2] ?? '', state: GO[go[1] ?? ''] ?? 'failed', ms: Math.round(Number(go[3] ?? 0) * 1000) }

  // TAP, as node --test and others print: not ok 3 - musters the Rohirrim
  const tap = /^(not ok|ok) \d+ (?:- )?(.+?)(?:\s+# (skip|todo)\b.*)?$/i.exec(line)

  if (tap !== null) return { name: tap[2] ?? '', state: tap[3] !== undefined ? 'skipped' : tap[1] === 'ok' ? 'passed' : 'failed', ms: 0 }

  return undefined
}

/** The tests a command reported, a line a test, in the order it ran them; none when it printed them no such way. */
export const casesOf = (printed: string): Case[] =>
  plainLines(printed)
    .flatMap(line => caseOf(line) ?? [])
    .slice(0, MAX_CASES)

/** A suite once its command has ended: passed on exit 0, failed on any other, blocked when it never ran to its end. */
export const endedSuite = (suite: Suite, ended: Ended, ms: number): Suite => {
  if ('failure' in ended) return { ...suite, state: 'blocked', note: ended.failure.slice(0, 300), output: '', tests: [], ms }

  const printed = [ended.stdout.trimEnd(), ended.stderr.trimEnd()].filter(part => part !== '').join('\n')
  const state: ScenarioState = ended.exitCode === 0 ? 'passed' : 'failed'

  return { ...suite, state, note: state === 'passed' ? '' : `exit ${ended.exitCode}: ${lastLine(printed)}`.replace(/: $/, '').slice(0, 300), output: printed.slice(-OUTPUT_CHARS), tests: casesOf(printed), ms }
}

const seconds = (ms: number): string => (ms > 0 ? `${Math.max(1, Math.round(ms / 1000))}s` : '')

const where = ({ argv, cwd }: Suite): string => `${argv.join(' ')}${cwd === '' ? '' : `  (in ${cwd})`}`

const CASE_GLYPH: Record<Case['state'], string> = { passed: GLYPH.passed, failed: GLYPH.failed, skipped: '-' }
const CASE_TONE: Record<Case['state'], NonNullable<TreeNode['tone']>> = { passed: 'success', failed: 'danger', skipped: 'neutral' }

// How many of its tests passed, with what did not: said only of a suite that reported some
const counted = (tests: readonly Case[]): string => {
  const of = (state: Case['state']) => tests.filter(test => test.state === state).length
  const [failed, skipped] = [of('failed'), of('skipped')]

  return tests.length === 0 ? '' : [`${of('passed')}/${tests.length} tests`, ...(failed > 0 ? [`${failed} failed`] : []), ...(skipped > 0 ? [`${skipped} skipped`] : [])].join(', ')
}

/**
 * The suites as a tree: a suite a row, why it failed and each of its tests under it; a row opens on its command
 * and what it printed.
 */
export const suiteTree = (held: readonly Suite[], opened: readonly string[]): TreeNode[] =>
  held.map(suite => {
    const tests = suite.tests ?? []

    return {
      id: `unit:${suite.id}`,
      label: `${GLYPH[suite.state]} ${suite.id.padStart(2)}  ${suite.name}`,
      tone: STATE_TONE[suite.state],
      meta: [STATE_TEXT[suite.state], counted(tests), seconds(suite.ms), suite.target].filter(part => part !== '').join(' · '),
      children: [
        ...(suite.note === '' ? [] : [{ label: suite.note }]),
        ...tests.map(test => ({ label: `${CASE_GLYPH[test.state]} ${test.name}`, tone: CASE_TONE[test.state], ...(test.ms > 0 ? { meta: `${test.ms}ms` } : {}) })),
      ],
      detail: [`$ ${where(suite)}`, ...(suite.output === '' ? [] : ['', ...suite.output.split('\n')])].join('\n'),
      isOpen: opened.includes(`unit:${suite.id}`),
    }
  })

// One suite as the model reads it: the tests that failed always, every one of them when it is asked for alone
const said = (suite: Suite, isPrinted: boolean, isListed = false): string[] => [
  `${suite.id}. [${STATE_TEXT[suite.state]}] ${suite.name}${suite.target === '' ? '' : ` (${suite.target})`}${suite.ms > 0 ? ` in ${seconds(suite.ms)}` : ''}`,
  `   $ ${where(suite)}`,
  ...(suite.note === '' ? [] : [`   ${STATE_TEXT[suite.state]}: ${suite.note}`]),
  ...((suite.tests ?? []).length === 0 ? [] : [`   ${counted(suite.tests ?? [])}`]),
  ...(suite.tests ?? []).filter(test => isListed || test.state === 'failed').map(test => `   ${CASE_GLYPH[test.state]} ${test.name}`),
  ...(suite.output === '' || !isPrinted ? [] : ['   it printed, at its end:', ...suite.output.split('\n').map(line => `   | ${line}`)]),
]

/** The suites as the model reads them: each with its command, how it stands, and what a failing one printed. */
export const unitText = (held: readonly Suite[], asked: { id?: unknown } = {}): string => {
  if (held.length === 0) return 'No unit test suite is named. mcp__palantir__unit_plan names them.'

  const id = text(asked.id)
  const shown = held.filter(suite => id === '' || suite.id === id)

  if (shown.length === 0) return `No suite ${id}. The list has ${held.map(suite => suite.id).join(', ')}.`

  return shown.flatMap((suite, index) => [...(index === 0 ? [] : ['']), ...said(suite, suite.state !== 'passed' || id !== '', id !== '')]).join('\n')
}

/** What Claude is asked to fix: the suites that failed, with what they printed, to be run again by it. */
export const fixUnitPrompt = (failed: readonly Suite[]): string =>
  [
    `Fix what makes ${failed.length === 1 ? 'this unit test suite' : `these ${failed.length} unit test suites`} of the project fail. Find the cause in the code and fix it there; where a test is what is wrong, say so before changing it, and never weaken a test to make it pass. Then run ${failed.length === 1 ? 'its command' : 'their commands'} again yourself and say what passes.`,
    ...failed.flatMap(suite => ['', ...said(suite, true)]),
  ].join('\n')
