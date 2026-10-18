import { describe, expect, test } from 'claude-code/testing'

import { eventsOf } from '../core/events'
import type { RunEvent } from '../core/events'
import { graphLines, historyLines, historyOf, runView } from '../core/view'
import type { RunView, TaskView } from '../core/view'
import type { Run, RunTask, RunWork } from '../types'

const AT = Date.UTC(2026, 9, 18, 13, 12)
const clock = (ms: number): string => `${new Date(ms).getUTCHours()}:${String(new Date(ms).getUTCMinutes()).padStart(2, '0')}`
const task = (id: number, given: Partial<RunTask> = {}): RunTask => ({ id, title: `Task ${id}`, why: '', steps: [], files: [], dependsOn: [], acceptance: '', weight: 'standard', state: 'todo', ...given })
const run = (given: Partial<Run> = {}): Run =>
  ({ kind: 'plan', ref: 'github:o/r#54', url: '', title: 'Beacons burn out', branch: 'build/54-beacons', base: 'main', tree: '/p/.theseus/trees/build-54', isAuto: false, phase: 'ready', current: null, proof: '', proofLine: '', verdictLine: '', commits: [], pr: '', at: AT, ...given }) as Run
const work = (tasks: RunTask[]): RunWork => ({ ref: 'github:o/r#54', url: '', title: 'Beacons burn out', summary: '', approach: '', tasks, questions: [], decided: [], risks: [], accepted: [] })
const out = (taskId: number, attempt = 1) => ({ taskId, title: `Task ${taskId}`, builder: 'builder-service' as const, agentId: 'a', attempt, at: AT, answer: '' })

describe('a run as every view draws it', () => {
  test('gives each task its steps: done, the one out on the step its run is on, a light one with no tests first, the rest pending', () => {
    const view = runView(
      run({ phase: 'proving', current: out(2), commits: [{ taskId: 1, title: 'Task 1', sha: 'a41c9e2ff', by: 'Light builder 1', minor: [] }] }),
      work([task(1, { state: 'done', weight: 'light' }), task(2, { state: 'doing', dependsOn: [1] }), task(3, { dependsOn: [2] }), task(4)]),
      [],
      [],
    )
    const [one, two, three, four] = view.tasks as [TaskView, TaskView, TaskView, TaskView]

    expect(one).toMatchObject({ standing: 'done', sha: 'a41c9e2', depth: 0, steps: { tests: 'skipped', build: 'done', commit: 'done' } })
    expect(two).toMatchObject({ standing: 'running', depth: 1, builder: 'Service builder', attempt: 1, steps: { tests: 'done', build: 'done', prove: 'running', review: 'pending', commit: 'pending' } })
    expect(three).toMatchObject({ standing: 'queued', depth: 2, why: 'waits for task 2' })
    expect(four).toMatchObject({ standing: 'ready', depth: 0 })
    expect(view).toMatchObject({ done: 1, total: 4, said: 'proving' })
  })

  test('marks the step a run stopped on as failed, with why, and offers to send it again', () => {
    const events: RunEvent[] = [...eventsOf(run({ phase: 'proving', current: out(2, 2) }), run({ phase: 'stuck', current: out(2, 2) }), AT, 'turn')]
    const view = runView(run({ phase: 'stuck', current: out(2, 2) }), work([task(2, { state: 'doing' })]), [], events)

    expect(view.tasks[0]).toMatchObject({ standing: 'stopped', attempt: 2, steps: { build: 'done', prove: 'failed', review: 'pending' }, why: 'Proving → stopped for you' })
    expect(view.actions.map(action => action.command)).toEqual(['/theseus build next github:o/r#54', '/theseus build commit github:o/r#54', '/theseus build go github:o/r#54', '/theseus build abandon github:o/r#54'])
  })

  test('says what a run waits for, and offers to submit one built', () => {
    expect(runView(run({ heldUntil: AT + 60_000, heldWhy: 'the 5-hour quota window is at 91%' }), work([task(1)]), [], []).tasks[0]).toMatchObject({ standing: 'waiting', why: 'the 5-hour quota window is at 91%' })
    expect(runView(run({ phase: 'built', isAuto: true }), work([task(1, { state: 'done' })]), [], []).actions.map(action => action.id)).toEqual(['submit', 'halt', 'abandon'])
  })

  test('shows a task built in a lane by the lane its run keeps', () => {
    const lane = run({ ref: 'github:o/r#54~3', phase: 'reviewing', current: out(3) })

    expect(runView(run({ phase: 'ready' }), work([task(3, { state: 'doing' })]), [lane], []).tasks[0]).toMatchObject({ isLane: true, standing: 'running', steps: { review: 'running' } })
  })
})

// Every field of the model is drawn by the terminal view, or named here as left out of it on purpose: a field added to
// the model and drawn by no view fails this test
const LEFT_OUT: readonly string[] = ['kind', 'phase', 'lastAt', 'events', 'tasks.weight', 'tasks.dependsOn', 'tasks.depth', 'tasks.standing', 'tasks.sentAt', 'tasks.doneAt', 'actions.id']

describe('the terminal view', () => {
  const full: RunView = {
    ref: 'REF-1',
    title: 'TITLE-2',
    kind: 'plan',
    phase: 'stuck',
    said: 'SAID-3',
    isAuto: true,
    branch: 'BRANCH-4',
    base: 'BASE-5',
    pr: 'PR-6',
    waiting: { why: 'WHY-7', until: AT },
    stopped: 'STOPPED-8',
    done: 7,
    total: 9,
    startedAt: AT - 3_600_000,
    lastAt: AT,
    tasks: [{ id: 11, title: 'TASK-12', weight: 'heavy', dependsOn: [], depth: 0, standing: 'stopped', steps: { tests: 'done', build: 'done', prove: 'failed', review: 'pending', commit: 'pending' }, attempt: 13, builder: 'BUILDER-14', sha: '', why: 'TASKWHY-15', sentAt: AT, doneAt: 0, isLane: true }],
    actions: [{ id: 'next', label: 'LABEL-16', command: 'COMMAND-17' }],
    events: [],
  }
  const drawn = graphLines(full, AT, clock).join('\n')

  test('draws every field of a run and its tasks that is not left out on purpose', () => {
    const shown: Record<string, string> = {
      ref: 'REF-1', title: 'TITLE-2', said: 'SAID-3', isAuto: 'going on by itself', branch: 'BRANCH-4', base: 'BASE-5', pr: 'PR-6', waiting: 'WHY-7', stopped: 'STOPPED-8', done: '7/9', total: '7/9', startedAt: '1h 00m',
      'tasks.id': '11.', 'tasks.title': 'TASK-12', 'tasks.steps': '✗ prove', 'tasks.attempt': 'try 13', 'tasks.builder': 'BUILDER-14', 'tasks.why': 'TASKWHY-15', 'tasks.isLane': '(lane)', 'tasks.sha': '',
      'actions.label': 'LABEL-16', 'actions.command': 'COMMAND-17',
    }
    const fields = [...Object.keys(full).filter(key => !['tasks', 'actions'].includes(key)), ...Object.keys(full.tasks[0] ?? {}).map(key => `tasks.${key}`), ...Object.keys(full.actions[0] ?? {}).map(key => `actions.${key}`)]

    for (const field of fields) expect([field, field in shown || LEFT_OUT.includes(field)]).toEqual([field, true])
    for (const [field, text] of Object.entries(shown)) if (text !== '') expect([field, drawn.includes(text)]).toEqual([field, true])
    expect(graphLines({ ...full, tasks: [{ ...(full.tasks[0] as TaskView), sha: 'SHA-18' }] }, AT, clock).join('\n')).toContain('SHA-18')
  })
})

describe('the history', () => {
  test('is each run its logs hold, the latest first: under way, a pull request, stopped or abandoned', () => {
    const at = (ms: number, kind: RunEvent['kind'], extra: Partial<RunEvent> = {}): RunEvent => ({ at: AT + ms, ref: 'x', kind, cause: 'clock', text: '', ...extra })
    const past = historyOf([
      { ref: 'github:o/r#1', events: [at(0, 'started', { text: 'Started a plan on build/1-a, from main' }), at(60_000, 'committed'), at(120_000, 'opened', { url: 'https://github.com/o/r/pull/9' })] },
      { ref: 'github:o/r#2', events: [at(0, 'started'), at(300_000, 'dropped')] },
      { ref: 'github:o/r#3', events: [at(0, 'started'), at(30_000, 'moved', { to: 'stuck' })] },
      { ref: 'github:o/r#4', events: [] },
    ])

    expect(past.map(one => [one.ref, one.status])).toEqual([
      ['github:o/r#2', 'abandoned'],
      ['github:o/r#1', 'pull request'],
      ['github:o/r#3', 'stopped'],
    ])
    expect(historyLines(past, clock)[1]).toBe('pull request github:o/r#1 · 1 task committed · 2m · 13:12 · https://github.com/o/r/pull/9 · build/1-a')
    expect(historyLines([], clock)).toEqual(['No run has a log yet: a run keeps one from Theseus 0.8.0 on.'])
  })
})
