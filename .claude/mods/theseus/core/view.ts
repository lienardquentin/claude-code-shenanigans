import type { Run, RunPhase, RunTask, RunWork } from '../types'
import { PHASE_SAID } from './events'
import type { RunEvent } from './events'
import { BUILDERS } from './runs/builders'
import { laneRefOf } from './runs/work'

// A run as every view of it draws it: the terminal's graph pane, /theseus, and the web view. Each reads this model
// and derives nothing of its own, so the views cannot disagree; and each action a view offers is one of the model's,
// done through one dispatcher. Built from the run as the build keeps it, its work and its log. Text in, text out.

/** The steps a task goes through, in order. */
export const STEPS = ['tests', 'build', 'prove', 'review', 'commit'] as const
export type Step = (typeof STEPS)[number]
export type StepState = 'pending' | 'running' | 'done' | 'failed' | 'skipped'

/** Where a task stands as a whole. */
export type TaskStanding = 'queued' | 'ready' | 'running' | 'waiting' | 'stopped' | 'done' | 'handed back'

/** One task, as a node of the run's graph. */
export type TaskView = {
  id: number
  title: string
  weight: RunTask['weight']
  dependsOn: number[]
  /** How far down the graph it sits: the longest chain of tasks before it. */
  depth: number
  standing: TaskStanding
  steps: Record<Step, StepState>
  /** The try it is on, from 1; 0 before it is sent. */
  attempt: number
  /** Who builds it now, or built it last; empty before it is sent. */
  builder: string
  /** Its commit, once committed. */
  sha: string
  /** Why it waits, stopped or was handed back; empty otherwise. */
  why: string
  /** When it was first sent, and when it was committed; 0 for neither yet. */
  sentAt: number
  doneAt: number
  /** Whether it is built beside the others, in a lane of its own. */
  isLane: boolean
}

/** Something a person can do to a run, as every view offers it: what it is called, and the command that does it. */
export type Action = { id: 'next' | 'commit' | 'submit' | 'halt' | 'auto' | 'abandon'; label: string; command: string }

/** The verb of /theseus build each action is done by: the one dispatcher every view's press goes through. */
export const ACTION_VERB: Record<Action['id'], string> = { next: 'next', commit: 'commit', submit: 'submit', halt: 'halt', auto: 'go', abandon: 'abandon' }

/** A run, whole, as a view draws it. */
export type RunView = {
  ref: string
  title: string
  kind: Run['kind']
  phase: RunPhase
  /** The phase in words. */
  said: string
  isAuto: boolean
  branch: string
  base: string
  pr: string
  /** What it waits for before its next task, and until when; null while it does not. */
  waiting: { why: string; until: number } | null
  /** Why it stopped for the person; empty while it has not. */
  stopped: string
  /** How many tasks are done, of how many. */
  done: number
  total: number
  startedAt: number
  lastAt: number
  tasks: TaskView[]
  actions: Action[]
  /** Its log, oldest first. */
  events: RunEvent[]
}

// The step a run's phase is on, for the task out
const STEP_OF: Partial<Record<RunPhase, Step>> = { 'writing-tests': 'tests', building: 'build', proving: 'prove', reviewing: 'review' }

/** The longest chain of tasks before each, by id. */
const depthsOf = (tasks: readonly RunTask[]): Map<number, number> => {
  const depths = new Map<number, number>()
  const byId = new Map(tasks.map(task => [task.id, task]))
  const depthOf = (id: number, seen: Set<number>): number => {
    const known = depths.get(id)

    if (known !== undefined) return known
    // A cycle the planner wrote is cut where it closes
    if (seen.has(id)) return 0

    const task = byId.get(id)
    const depth = task === undefined || task.dependsOn.length === 0 ? 0 : 1 + Math.max(...task.dependsOn.map(one => depthOf(one, new Set([...seen, id]))))

    depths.set(id, depth)

    return depth
  }

  for (const task of tasks) depthOf(task.id, new Set())

  return depths
}

/** The steps of a task out now, from the phase its run is in: those before done, the one it is on running or failed. */
const stepsOut = (phase: RunPhase, isLight: boolean, stoppedAt: Step | undefined): Record<Step, StepState> => {
  const at = phase === 'stuck' ? stoppedAt : STEP_OF[phase]
  const index = at === undefined ? -1 : STEPS.indexOf(at)

  return Object.fromEntries(
    STEPS.map((step, position) => [
      step,
      step === 'tests' && isLight ? 'skipped' : position < index ? 'done' : position === index ? (phase === 'stuck' ? 'failed' : 'running') : 'pending',
    ]),
  ) as Record<Step, StepState>
}

const ALL: Record<StepState, Record<Step, StepState>> = Object.fromEntries((['pending', 'running', 'done', 'failed', 'skipped'] as const).map(state => [state, Object.fromEntries(STEPS.map(step => [step, state])) as Record<Step, StepState>])) as Record<StepState, Record<Step, StepState>>

/** A run as a view: the run as the build keeps it, its work, the lanes out beside it, and its log. */
export const runView = (run: Run, work: RunWork | null, lanes: readonly Run[], events: readonly RunEvent[]): RunView => {
  const tasks = work?.tasks ?? run.tasks ?? []
  const depths = depthsOf(tasks)
  const own = events.filter(event => event.ref === run.ref)
  const stuckAt = [...own].reverse().find(event => event.kind === 'moved' && event.to === 'stuck')
  const stoppedAt = stuckAt?.from === undefined ? undefined : STEP_OF[stuckAt.from]
  const isDone = (id: number) => tasks.find(task => task.id === id)?.state === 'done'

  const taskViews = tasks.map((task): TaskView => {
    const lane = lanes.find(one => one.ref === laneRefOf(run.ref, task.id))
    const holder = lane ?? run
    const out = holder.current !== null && holder.current.taskId === task.id ? holder.current : null
    const commit = [...run.commits].reverse().find(one => one.taskId === task.id)
    const sent = own.filter(event => event.kind === 'sent' && event.task === task.id)
    const builderId: string = out?.builder ?? sent.at(-1)?.builder ?? ''
    const builder = builderId === '' ? (commit?.by ?? '') : (BUILDERS[builderId as keyof typeof BUILDERS]?.title ?? builderId)
    const isLight = task.weight === 'light'
    const waitsOn = task.dependsOn.filter(id => !isDone(id))

    const standing: TaskStanding =
      task.state === 'done'
        ? 'done'
        : task.state === 'asked'
          ? 'handed back'
          : out !== null
            ? holder.phase === 'stuck'
              ? 'stopped'
              : 'running'
            : waitsOn.length > 0
              ? 'queued'
              : run.heldUntil !== undefined
                ? 'waiting'
                : 'ready'

    return {
      id: task.id,
      title: task.title,
      weight: task.weight,
      dependsOn: [...task.dependsOn],
      depth: depths.get(task.id) ?? 0,
      standing,
      steps: standing === 'done' ? { ...ALL.done, ...(isLight ? { tests: 'skipped' as const } : {}) } : out !== null ? stepsOut(holder.phase, isLight, holder === run ? stoppedAt : undefined) : { ...ALL.pending, ...(isLight ? { tests: 'skipped' as const } : {}) },
      attempt: out?.attempt ?? sent.at(-1)?.attempt ?? 0,
      builder,
      sha: commit?.sha.slice(0, 7) ?? '',
      why: standing === 'handed back' ? (task.note ?? '') : standing === 'queued' ? `waits for ${waitsOn.map(id => `task ${id}`).join(', ')}` : standing === 'waiting' ? (run.heldWhy ?? 'the quota') : standing === 'stopped' ? (stuckAt?.text ?? '') : '',
      sentAt: sent[0]?.at ?? 0,
      doneAt: own.find(event => event.kind === 'committed' && event.task === task.id)?.at ?? 0,
      isLane: lane !== undefined,
    }
  })

  const ref = run.ref
  const command = (id: Action['id']) => `/theseus build ${ACTION_VERB[id]} ${ref}`
  const actions: Action[] = [
    ...(run.phase === 'ready' || run.phase === 'stuck' ? [{ id: 'next' as const, label: 'Send the next task', command: command('next') }] : []),
    ...(run.phase === 'stuck' && run.current !== null ? [{ id: 'commit' as const, label: 'Put the change up for verification again', command: command('commit') }] : []),
    ...(run.phase === 'built' ? [{ id: 'submit' as const, label: run.kind === 'review' ? 'Push the answers' : 'Push and open the pull request', command: command('submit') }] : []),
    ...(run.isAuto && run.phase !== 'submitted' ? [{ id: 'halt' as const, label: 'Stop after this task', command: command('halt') }] : []),
    ...(!run.isAuto && run.phase !== 'submitted' ? [{ id: 'auto' as const, label: 'Go on by itself', command: command('auto') }] : []),
    ...(run.phase !== 'submitted' ? [{ id: 'abandon' as const, label: 'Abandon the run', command: command('abandon') }] : []),
  ]

  return {
    ref,
    title: run.title,
    kind: run.kind,
    phase: run.phase,
    said: PHASE_SAID[run.phase],
    isAuto: run.isAuto,
    branch: run.branch,
    base: run.base,
    pr: run.pr,
    waiting: run.heldUntil === undefined ? null : { why: run.heldWhy ?? 'the quota', until: run.heldUntil },
    stopped: run.phase === 'stuck' ? (stuckAt?.text ?? 'stopped for you') : '',
    done: tasks.filter(task => task.state === 'done').length,
    total: tasks.length,
    startedAt: own[0]?.at ?? run.at,
    lastAt: own.at(-1)?.at ?? run.at,
    tasks: taskViews,
    actions,
    events: [...own],
  }
}

const STEP_MARK: Record<StepState, string> = { pending: '·', running: '◐', done: '✓', failed: '✗', skipped: '–' }
const STANDING_MARK: Record<TaskStanding, string> = { queued: '○', ready: '○', running: '◐', waiting: '◔', stopped: '✗', done: '●', 'handed back': '?' }

/** A task's steps in a line: a mark and a name each. */
export const stepsLine = (steps: Record<Step, StepState>): string => STEPS.map(step => `${STEP_MARK[steps[step]]} ${step}`).join('  ')

/** A duration as a person reads it: 45s, 12m, 1h 05m. */
export const durationOf = (ms: number): string => {
  const seconds = Math.max(0, Math.round(ms / 1000))

  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`

  return `${Math.floor(seconds / 3600)}h ${String(Math.round((seconds % 3600) / 60)).padStart(2, '0')}m`
}

/**
 * A run as the terminal draws it, a line each: its head, each task as a node of its graph (indented by depth, its
 * steps, who builds it, its commit or why it waits), and the actions open on it. `clock` says a time.
 */
export const graphLines = (view: RunView, now: number, clock: (ms: number) => string): string[] => [
  `${view.ref} · ${view.title}`,
  `${view.kind} · ${view.said}${view.isAuto ? ' · going on by itself' : ''} · ${view.done}/${view.total} done · ${durationOf(now - view.startedAt)} · ${view.branch} ← ${view.base}${view.pr !== '' ? ` · ${view.pr}` : ''}`,
  ...(view.waiting !== null ? [`Waiting until ${clock(view.waiting.until)}: ${view.waiting.why}`] : []),
  ...(view.stopped !== '' ? [`Stopped: ${view.stopped}`] : []),
  '',
  ...view.tasks.flatMap(task => {
    const indent = '  '.repeat(task.depth)
    const after = task.sha !== '' ? task.sha : task.why

    return [
      `${indent}${STANDING_MARK[task.standing]} ${task.id}. ${task.title}${task.isLane ? ' (lane)' : ''}`,
      `${indent}   ${stepsLine(task.steps)}${task.builder !== '' ? ` · ${task.builder}${task.attempt > 1 ? `, try ${task.attempt}` : ''}` : ''}${after !== '' ? ` · ${after}` : ''}`,
    ]
  }),
  ...(view.actions.length > 0 ? ['', ...view.actions.map(action => `${action.label}: ${action.command}`)] : []),
]

/** One run of the history: kept from its log, under way or not. */
export type PastRun = { ref: string; status: 'under way' | 'pull request' | 'stopped' | 'abandoned'; startedAt: number; lastAt: number; pr: string; done: number; branch: string }

/** Each run the logs hold, the latest first: how it ended (or that it has not), when, and its pull request. */
export const historyOf = (logs: readonly { ref: string; events: readonly RunEvent[] }[]): PastRun[] =>
  logs
    .filter(log => log.events.length > 0)
    .map(({ ref, events }): PastRun => {
      const last = events.at(-1)
      const opened = [...events].reverse().find(event => event.kind === 'opened')
      const isDropped = last?.kind === 'dropped'
      const isStuck = [...events].reverse().find(event => event.kind === 'moved')?.to === 'stuck'
      const started = events.find(event => event.kind === 'started')

      return {
        ref,
        status: opened !== undefined ? 'pull request' : isDropped ? 'abandoned' : isStuck ? 'stopped' : 'under way',
        startedAt: events[0]?.at ?? 0,
        lastAt: last?.at ?? 0,
        pr: opened?.url ?? '',
        done: events.filter(event => event.kind === 'committed').length,
        branch: /^Started .*? on (\S+?),/.exec(started?.text ?? '')?.[1] ?? '',
      }
    })
    .sort((one, other) => other.lastAt - one.lastAt)

/** The history as /theseus history says it, a run a line. */
export const historyLines = (past: readonly PastRun[], clock: (ms: number) => string): string[] =>
  past.length === 0
    ? ['No run has a log yet: a run keeps one from Theseus 0.8.0 on.']
    : past.map(run => `${run.status.padEnd(12)} ${run.ref} · ${run.done} ${run.done === 1 ? 'task' : 'tasks'} committed · ${durationOf(run.lastAt - run.startedAt)} · ${clock(run.startedAt)}${run.pr !== '' ? ` · ${run.pr}` : ''}${run.branch !== '' ? ` · ${run.branch}` : ''}`)
