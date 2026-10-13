import type { Attachment, Browser, Scenario, ScenarioState } from '../types'
import type { TreeNode } from './kit/tree'

// The end-to-end checklist of a frontend: the scenarios Claude wrote, each run on the page by a subagent of its
// own, and what that subagent said came of it. Here are the checklist's changes and its texts; the spawning is the
// hooks module's. Values in, values out.

/** The agent type a scenario is run by, as the engine names it. */
export const AGENT_TYPE = 'palantir:e2e'

const MAX_SCENARIOS = 40
const MAX_STEPS = 20
const NOTE_CHARS = 300
const REPORT_CHARS = 2_000

/**
 * The agent that runs one scenario. It has the session's tools, the browser's among them, less those that change
 * the project: a scenario is done on the page, as a person would do it.
 */
export const AGENT = {
  name: 'e2e',
  description: 'Runs one end-to-end scenario of the palantir checklist on the page of a watched frontend, in the browser, and says whether it passed.',
  model: 'haiku',
  disallowedTools: ['Edit', 'Write', 'NotebookEdit', 'Bash', 'Agent'],
  maxTurns: 60,
  omitClaudeMd: true,
  background: true,
  prompt: [
    'You run one end-to-end scenario on a web app, in a browser that is already open, and say whether it passed.',
    '',
    "Drive the page with the browser tools you have: a Chrome DevTools server's (list the pages, select one, navigate, take a snapshot, click, fill, press a key, wait for a text). If none is listed, find them with ToolSearch. Work in the tab that shows the app; open the address in a new tab only when none does.",
    '',
    'Do the steps in order, as a person would, and read the page after each one before going on. The palantir tools say what the page and the apps did: mcp__palantir__dom the elements of the page, mcp__palantir__interactions what a click led to, mcp__palantir__logs and mcp__palantir__errors_since_edit what the apps wrote.',
    '',
    'Change no file and run no command. Do the steps as they are written: when one cannot be done on the page, do not find another way around it, the scenario has failed. It is blocked, not failed, when it could not be tried at all: no browser tool, no tab and no address, the app not answering.',
    '',
    'End with a few lines on what you saw at each step, then one last line, exactly one of:',
    'VERDICT: pass',
    'VERDICT: fail: <what was expected and what happened instead>',
    'VERDICT: blocked: <why it could not be tried>',
  ].join('\n'),
} as const

export const HOW_TO_PLAN =
  'No scenario yet. Plan has Claude write the checklist of what a person does on the frontend (mcp__palantir__e2e_plan). Each scenario is then run on the page, in the debug Chrome, by a Haiku subagent of its own, one after another.'

/** What the pane's Plan button asks of Claude. */
export const PLAN_PROMPT =
  'Plan the end-to-end scenarios of the frontend palantir watches: read its routes and its pages, then write the checklist with mcp__palantir__e2e_plan, one scenario per thing a person does there (the steps as they would do them, and what must be seen at the end). Do not run them yet.'

const text = (value: unknown): string => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '')

const stepsOf = (value: unknown): string[] =>
  (Array.isArray(value) ? value.map(text) : text(value).split(/\s*(?:\n|;)\s*/))
    .map(step => step.replace(/^\d+[.)]\s*/, '').slice(0, 400))
    .filter(step => step !== '')
    .slice(0, MAX_STEPS)

export type Planned = { scenarios: Scenario[]; refused: string[] }

/**
 * The checklist as a plan leaves it: the scenarios it names, in place of the ones held or (`add`) after them. One
 * with no name or no step is left out, and said. `labels` are the watched apps: a scenario that names none of them
 * is of the first.
 */
export const planned = (held: readonly Scenario[], asked: { scenarios?: unknown; add?: unknown }, labels: readonly string[]): Planned => {
  const kept = asked.add === true ? held : []
  const refused: string[] = []
  const scenarios: Scenario[] = [...kept]
  let last = kept.reduce((most, { id }) => Math.max(most, Number(id) || 0), 0)

  for (const [index, item] of (Array.isArray(asked.scenarios) ? asked.scenarios : []).entries()) {
    const { name, steps, expect, target } = (typeof item === 'object' && item !== null ? item : {}) as Record<string, unknown>
    const said = stepsOf(steps)

    if (text(name) === '' || said.length === 0) {
      refused.push(`scenario ${index + 1} has ${text(name) === '' ? 'no name' : 'no step'}`)
      continue
    }

    if (scenarios.length >= MAX_SCENARIOS) {
      refused.push(`a checklist holds ${MAX_SCENARIOS} scenarios: "${text(name)}" is left out`)
      continue
    }

    last += 1
    scenarios.push({
      id: String(last),
      name: text(name).slice(0, 120),
      target: labels.includes(text(target)) ? text(target) : (labels[0] ?? ''),
      steps: said,
      expect: text(expect).slice(0, 400),
      state: 'todo',
      note: '',
      report: '',
      agentId: '',
      at: 0,
      ms: 0,
    })
  }

  return { scenarios, refused }
}

/** The checklist with the scenarios named (all of them when none is) waiting to be run; one that runs goes on. */
export const queued = (held: readonly Scenario[], ids: readonly string[]): Scenario[] =>
  held.map(scenario => (scenario.state !== 'running' && scenario.state !== 'queued' && (ids.length === 0 || ids.includes(scenario.id)) ? { ...scenario, state: 'queued', note: '', report: '' } : scenario))

/** The checklist with nothing left to run: what waited is to run again, and what ran is said to have been stopped. */
export const stopped = (held: readonly Scenario[]): Scenario[] =>
  held.map(scenario =>
    scenario.state === 'queued' ? { ...scenario, state: 'todo' } : scenario.state === 'running' ? { ...scenario, state: 'blocked', note: 'stopped before its subagent answered', agentId: '' } : scenario,
  )

export type Verdict = { state: Extract<ScenarioState, 'passed' | 'failed' | 'blocked'>; note: string }

const STATE_OF = { pass: 'passed', fail: 'failed', blocked: 'blocked' } as const

/**
 * What a subagent's answer says came of its scenario: the last `VERDICT:` it holds, wherever on a line it stands.
 * An answer with none is no verdict.
 */
export const verdictOf = (answer: string, reason: string): Verdict => {
  const said = [...answer.matchAll(/VERDICT:[\s*_`]*(pass|fail|blocked)\w*[ \t*_`]*[:,.—-]?[ \t]*(.*)$/gim)].pop()

  if (said !== undefined) return { state: STATE_OF[(said[1] ?? '').toLowerCase() as keyof typeof STATE_OF], note: (said[2] ?? '').replace(/[*_`]+$/, '').trim().slice(0, NOTE_CHARS) }
  if (reason !== 'answer') return { state: 'blocked', note: reason === 'aborted' ? 'its subagent was interrupted' : `its subagent ended on ${reason === 'refusal' ? 'a refusal' : 'an error'}` }

  return { state: 'blocked', note: `its subagent gave no verdict: ${answer.trim().split('\n').pop()?.slice(0, 200) ?? ''}`.replace(/: $/, '') }
}

/** The checklist once the subagent named has answered; unchanged when it runs none of its scenarios. */
export const settled = (held: readonly Scenario[], agentId: string, verdict: Verdict, answer: string, ms: number): Scenario[] =>
  held.map(scenario => (scenario.state === 'running' && scenario.agentId === agentId ? { ...scenario, ...verdict, report: answer.trim().slice(-REPORT_CHARS), ms } : scenario))

/** Where a scenario's app is: the tab that shows it, or the port it listens on when no tab is known to. */
export type Address = { url: string; isOpen: boolean }

export const addressOf = ({ target }: Scenario, { pages }: Browser, attachments: readonly Attachment[]): Address => {
  const page = pages.find(({ label }) => label === target) ?? (pages.length === 1 ? pages[0] : undefined)
  const port = attachments.find(({ label }) => label === target)?.port ?? 0

  return page !== undefined ? { url: page.address, isOpen: true } : { url: port > 0 ? `http://localhost:${port}/` : '', isOpen: false }
}

/** What the subagent is asked: the one scenario, where its app is, and what must be seen. */
export const scenarioPrompt = (scenario: Scenario, { url, isOpen }: Address): string =>
  [
    `Scenario: ${scenario.name}`,
    ...(scenario.target === '' ? [] : [`App: ${scenario.target}, as palantir names it.`]),
    isOpen
      ? `The app is open in a tab of the browser at ${url}`
      : url === ''
        ? 'No tab is known to show the app: look for it among the pages of the browser.'
        : `The app answers at ${url}: use the tab that shows it, or open that address in a new one.`,
    '',
    'Steps:',
    ...scenario.steps.map((step, index) => `${index + 1}. ${step}`),
    '',
    `It passes when: ${scenario.expect === '' ? 'every step could be done and the page showed no error.' : scenario.expect}`,
  ].join('\n')

export const STATE_TEXT: Record<ScenarioState, string> = { todo: 'to run', queued: 'queued', running: 'running', passed: 'passed', failed: 'failed', blocked: 'blocked' }

export const STATE_TONE = { todo: 'neutral', queued: 'info', running: 'accent', passed: 'success', failed: 'danger', blocked: 'warning' } as const satisfies Record<ScenarioState, string>

type Stood = { state: ScenarioState }

const count = (held: readonly Stood[], state: ScenarioState): number => held.filter(scenario => scenario.state === state).length

/** Whether a scenario waits or runs. */
export const isUnderWay = (held: readonly Stood[]): boolean => held.some(({ state }) => state === 'queued' || state === 'running')

/** The checklist in one line: how many passed, failed, could not be tried, and are yet to run. */
export const tally = (held: readonly Stood[]): { label: string; tone: 'neutral' | 'accent' | 'success' | 'warning' | 'danger' } => {
  const [passed, failed, blocked, running] = [count(held, 'passed'), count(held, 'failed'), count(held, 'blocked'), count(held, 'running') + count(held, 'queued')]
  const left = held.length - passed - failed - blocked - running

  return {
    label: [`${passed} passed`, `${failed} failed`, ...(blocked > 0 ? [`${blocked} blocked`] : []), ...(running > 0 ? [`${running} under way`] : []), ...(left > 0 ? [`${left} to run`] : [])].join(' · '),
    tone: failed > 0 ? 'danger' : blocked > 0 ? 'warning' : running > 0 ? 'accent' : left > 0 ? 'neutral' : 'success',
  }
}

const seconds = (ms: number): string => (ms > 0 ? ` in ${Math.max(1, Math.round(ms / 1000))}s` : '')

export const GLYPH: Record<ScenarioState, string> = { todo: '○', queued: '○', running: '▶', passed: '✓', failed: '✗', blocked: '!' }

/** What a row opens on: the steps, what must be seen, and the end of what the subagent reported. */
const detailOf = ({ steps, expect, report }: Scenario): string =>
  [...steps.map((step, index) => `${index + 1}. ${step}`), ...(expect === '' ? [] : [`Passes when: ${expect}`]), ...(report === '' ? [] : ['', 'Its subagent reported:', ...report.split('\n').map(line => `  ${line}`)])].join('\n')

/**
 * The checklist as a tree: a scenario a row, its mark and its name in the color of how it stands, then how it
 * stands and how long it took; why it failed or could not be tried hangs under it. `opened` are the rows open on
 * their steps, each named `e2e:<id>`.
 */
export const scenarioTree = (held: readonly Scenario[], { opened, isByApp }: { opened: readonly string[]; isByApp: boolean }): TreeNode[] =>
  held.map(scenario => {
    const { id, name, target, state, note, ms } = scenario

    return {
      id: `e2e:${id}`,
      label: `${GLYPH[state]} ${id.padStart(2)}  ${name}`,
      tone: STATE_TONE[state],
      meta: [STATE_TEXT[state], ...(ms > 0 ? [`${Math.max(1, Math.round(ms / 1000))}s`] : []), ...(isByApp && target !== '' ? [target] : [])].join(' · '),
      ...(note === '' ? {} : { children: [{ label: note }] }),
      detail: detailOf(scenario),
      isOpen: opened.includes(`e2e:${id}`),
    }
  })

// One scenario as the model reads it: its steps, how it stands and why, and what its subagent reported
const said = (scenario: Scenario, isReported: boolean): string[] => [
  `${scenario.id}. [${STATE_TEXT[scenario.state]}] ${scenario.name}${scenario.target === '' ? '' : ` (${scenario.target})`}${seconds(scenario.ms)}`,
  ...scenario.steps.map((step, index) => `   ${index + 1}. ${step}`),
  ...(scenario.expect === '' ? [] : [`   passes when: ${scenario.expect}`]),
  ...(scenario.note === '' ? [] : [`   ${STATE_TEXT[scenario.state]}: ${scenario.note}`]),
  ...(scenario.report === '' || !isReported ? [] : ['   its subagent reported:', ...scenario.report.split('\n').map(line => `   | ${line}`)]),
]

/** The checklist as the model reads it: each scenario with its steps, how it stands, and what its subagent reported. */
export const e2eText = (held: readonly Scenario[], asked: { id?: unknown } = {}): string => {
  if (held.length === 0) return 'No end-to-end scenario is planned. mcp__palantir__e2e_plan writes the checklist.'

  const id = text(asked.id)
  const shown = held.filter(scenario => id === '' || scenario.id === id)

  if (shown.length === 0) return `No scenario ${id}. The checklist has ${held.map(scenario => scenario.id).join(', ')}.`

  return [
    `${tally(held).label}.${isUnderWay(held) ? ' The run is under way: ask again once it is over.' : ''}`,
    // A scenario that passed needs no more said; of any other, what its subagent saw is what there is to go on
    ...shown.flatMap(scenario => ['', ...said(scenario, scenario.state !== 'passed' || id !== '')]),
  ].join('\n')
}

/**
 * What Claude is asked to fix: the scenarios that failed, each with what its subagent saw, to be run again once
 * the code is changed. A scenario may be what is wrong, not the app: that is said, and the code left alone.
 */
export const fixPrompt = (failed: readonly Scenario[]): string =>
  [
    `Fix what makes ${failed.length === 1 ? 'this end-to-end scenario' : `these ${failed.length} end-to-end scenarios`} of the palantir checklist fail. Find the cause in the app's code, frontend or backend (mcp__palantir__logs and mcp__palantir__errors_since_edit say what the apps wrote), and fix it there, not around it. Where the scenario is what is wrong and the app does what it should, say so and change no code for it. Then run ${failed.length === 1 ? 'it' : 'them'} again with mcp__palantir__e2e_run, ids ${failed.map(({ id }) => id).join(', ')}, and read mcp__palantir__e2e once the run is over before saying what is fixed.`,
    ...failed.flatMap(scenario => ['', ...said(scenario, true)]),
  ].join('\n')
