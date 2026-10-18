// A project as Theseus leaves it after part of a run: its views (a snapshot a change) and its log, with a value in
// every field a view draws, so a test can find each one on the page.
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const AT = Date.UTC(2026, 9, 18, 13, 12)
export const REF = 'github:o/r#54'
export const FILE = 'github-o-r-54'

const task = (id, given) => ({ id, title: `Task ${id}`, weight: 'standard', dependsOn: [], depth: 0, standing: 'queued', steps: { tests: 'pending', build: 'pending', prove: 'pending', review: 'pending', commit: 'pending' }, attempt: 0, builder: '', sha: '', why: '', sentAt: 0, doneAt: 0, isLane: false, ...given })

/** The run's view at a moment: its first task committed, its second on its second try at the proof. */
export const viewAt = (at, second) => ({
  ref: REF,
  title: 'Beacons burn out after a watch',
  kind: 'plan',
  phase: second.phase,
  said: second.said,
  isAuto: false,
  branch: 'build/54-beacons-burn-out',
  base: 'main',
  pr: '',
  waiting: null,
  stopped: '',
  done: 1,
  total: 3,
  startedAt: AT,
  lastAt: at,
  at,
  tasks: [
    task(1, { title: 'Keep when a beacon was lit', weight: 'light', standing: 'done', steps: { tests: 'skipped', build: 'done', prove: 'done', review: 'done', commit: 'done' }, attempt: 1, builder: 'Light builder 1', sha: 'a41c9e2', sentAt: AT + 60_000, doneAt: AT + 600_000 }),
    task(2, { title: 'Quench beacons past their watch', dependsOn: [1], depth: 1, standing: second.standing, steps: second.steps, attempt: 2, builder: 'Service builder', why: second.why, sentAt: AT + 660_000 }),
    task(3, { title: 'The chronicle records a burn-out', dependsOn: [2], depth: 2, why: 'waits for task 2' }),
  ],
  actions: [
    { id: 'next', label: 'Send the next task', command: `/theseus build next ${REF}` },
    { id: 'abandon', label: 'Abandon the run', command: `/theseus build abandon ${REF}` },
  ],
})

export const VIEWS = [
  viewAt(AT + 660_000, { phase: 'building', said: 'building', standing: 'running', why: '', steps: { tests: 'done', build: 'running', prove: 'pending', review: 'pending', commit: 'pending' } }),
  viewAt(AT + 900_000, { phase: 'proving', said: 'proving', standing: 'running', why: '', steps: { tests: 'done', build: 'done', prove: 'running', review: 'pending', commit: 'pending' } }),
  viewAt(AT + 960_000, { phase: 'stuck', said: 'stopped for you', standing: 'stopped', why: 'Proving → stopped for you', steps: { tests: 'done', build: 'done', prove: 'failed', review: 'pending', commit: 'pending' } }),
]

const event = (ms, kind, cause, text, extra = {}) => ({ at: AT + ms, ref: REF, kind, cause, text, ...extra })

export const EVENTS = [
  event(0, 'started', 'command', 'Started a plan on build/54-beacons-burn-out, from main', { to: 'ready' }),
  event(60_000, 'sent', 'command', 'Sent Light builder 1 on task 1: Keep when a beacon was lit', { task: 1, attempt: 1 }),
  event(600_000, 'committed', 'turn', 'Committed task 1 as a41c9e2: Keep when a beacon was lit', { task: 1, sha: 'a41c9e2' }),
  event(660_000, 'sent', 'clock', 'Sent Service builder on task 2: Quench beacons past their watch', { task: 2, attempt: 2 }),
  event(900_000, 'working', 'turn', 'Proving task 2…'),
  event(960_000, 'moved', 'turn', 'Proving → stopped for you', { from: 'proving', to: 'stuck' }),
]

/** A project folder holding the run's views and log. */
export const project = async () => {
  const root = await mkdtemp(join(tmpdir(), 'theseus-ui-'))

  await mkdir(join(root, '.theseus', 'views'), { recursive: true })
  await mkdir(join(root, '.theseus', 'runs'), { recursive: true })
  await writeFile(join(root, '.theseus', 'views', `${FILE}.jsonl`), VIEWS.map(one => JSON.stringify(one)).join('\n') + '\n')
  await writeFile(join(root, '.theseus', 'runs', `${FILE}.jsonl`), EVENTS.map(one => JSON.stringify(one)).join('\n') + '\n')

  return root
}
