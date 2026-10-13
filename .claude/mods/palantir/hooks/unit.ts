import type { ScenarioState, Suite } from '../types'
import { GLYPH, STATE_TEXT, STATE_TONE } from './e2e'
import type { TreeNode } from './kit/tree'

// The unit tests of the project: the suites Claude named, each a command, run from the pane and read by how it
// exits. Here are the list's changes and its texts; the running is the hooks module's. Values in, values out.

const MAX_SUITES = 20
const OUTPUT_CHARS = 4_000

/** How long a suite may run: what the engine allows a command at most. */
export const SUITE_TIMEOUT_MS = 600_000

export const HOW_TO_PLAN_UNIT =
  "No suite yet. Plan has Claude find the project's unit test commands and name them here (mcp__palantir__unit_plan). Each is then run from this pane, one after another, and read by how it exits."

/** What the pane's Plan button asks of Claude. */
export const PLAN_UNIT_PROMPT =
  "Find the unit test suites of this project (each app's own: its package.json scripts, pyproject, Makefile, CI), then name them with mcp__palantir__unit_plan, one suite per command, each with the folder it runs in. Do not run them."

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

/** The suites with the ones named (all, when none is) waiting to be run; one that waits or runs goes on. */
export const queuedSuites = (held: readonly Suite[], ids: readonly string[]): Suite[] =>
  held.map(suite => (suite.state !== 'running' && suite.state !== 'queued' && (ids.length === 0 || ids.includes(suite.id)) ? { ...suite, state: 'queued', note: '', output: '' } : suite))

/** What a command printed and how it exited; none when it could not start or outlived its time, with why. */
export type Ended = { exitCode: number; stdout: string; stderr: string } | { failure: string }

const lastLine = (printed: string): string =>
  printed
    .split('\n')
    // eslint-disable-next-line no-control-regex
    .map(line => line.replace(/\u001B\[[0-9;]*[A-Za-z]/g, '').trim())
    .filter(line => line !== '')
    .pop() ?? ''

/** A suite once its command has ended: passed on exit 0, failed on any other, blocked when it never ran to its end. */
export const endedSuite = (suite: Suite, ended: Ended, ms: number): Suite => {
  if ('failure' in ended) return { ...suite, state: 'blocked', note: ended.failure.slice(0, 300), output: '', ms }

  const printed = [ended.stdout.trimEnd(), ended.stderr.trimEnd()].filter(part => part !== '').join('\n')
  const state: ScenarioState = ended.exitCode === 0 ? 'passed' : 'failed'

  return { ...suite, state, note: state === 'passed' ? '' : `exit ${ended.exitCode}: ${lastLine(printed)}`.replace(/: $/, '').slice(0, 300), output: printed.slice(-OUTPUT_CHARS), ms }
}

const seconds = (ms: number): string => (ms > 0 ? `${Math.max(1, Math.round(ms / 1000))}s` : '')

const where = ({ argv, cwd }: Suite): string => `${argv.join(' ')}${cwd === '' ? '' : `  (in ${cwd})`}`

/** The suites as a tree: a suite a row, why it failed under it; a row opens on its command and what it printed. */
export const suiteTree = (held: readonly Suite[], opened: readonly string[]): TreeNode[] =>
  held.map(suite => ({
    id: `unit:${suite.id}`,
    label: `${GLYPH[suite.state]} ${suite.id.padStart(2)}  ${suite.name}`,
    tone: STATE_TONE[suite.state],
    meta: [STATE_TEXT[suite.state], seconds(suite.ms), suite.target].filter(part => part !== '').join(' · '),
    ...(suite.note === '' ? {} : { children: [{ label: suite.note }] }),
    detail: [`$ ${where(suite)}`, ...(suite.output === '' ? [] : ['', ...suite.output.split('\n')])].join('\n'),
    isOpen: opened.includes(`unit:${suite.id}`),
  }))

// One suite as the model reads it
const said = (suite: Suite, isPrinted: boolean): string[] => [
  `${suite.id}. [${STATE_TEXT[suite.state]}] ${suite.name}${suite.target === '' ? '' : ` (${suite.target})`}${suite.ms > 0 ? ` in ${seconds(suite.ms)}` : ''}`,
  `   $ ${where(suite)}`,
  ...(suite.note === '' ? [] : [`   ${STATE_TEXT[suite.state]}: ${suite.note}`]),
  ...(suite.output === '' || !isPrinted ? [] : ['   it printed, at its end:', ...suite.output.split('\n').map(line => `   | ${line}`)]),
]

/** The suites as the model reads them: each with its command, how it stands, and what a failing one printed. */
export const unitText = (held: readonly Suite[], asked: { id?: unknown } = {}): string => {
  if (held.length === 0) return 'No unit test suite is named. mcp__palantir__unit_plan names them.'

  const id = text(asked.id)
  const shown = held.filter(suite => id === '' || suite.id === id)

  if (shown.length === 0) return `No suite ${id}. The list has ${held.map(suite => suite.id).join(', ')}.`

  return shown.flatMap((suite, index) => [...(index === 0 ? [] : ['']), ...said(suite, suite.state !== 'passed' || id !== '')]).join('\n')
}

/** What Claude is asked to fix: the suites that failed, with what they printed, to be run again by it. */
export const fixUnitPrompt = (failed: readonly Suite[]): string =>
  [
    `Fix what makes ${failed.length === 1 ? 'this unit test suite' : `these ${failed.length} unit test suites`} of the project fail. Find the cause in the code and fix it there; where a test is what is wrong, say so before changing it, and never weaken a test to make it pass. Then run ${failed.length === 1 ? 'its command' : 'their commands'} again yourself and say what passes.`,
    ...failed.flatMap(suite => ['', ...said(suite, true)]),
  ].join('\n')
