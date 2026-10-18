import type { Run, RunPhase } from '../types'
import { clockTime } from './budget'
import { BUILDERS } from './run'

// A run's history, a line a move: what changed, when, and what caused it. The build keeps a run only through one
// change at a time, and each change it keeps is told here as the events it makes, appended to the run's log under
// .theseus/runs/. The panes, /theseus and the run views to come read a run from its log. Text in, text out.

/** What set a change off: a command typed, a tool Claude called, the clock, an agent's turn ending, a press on a pane. */
export type Cause = 'command' | 'tool' | 'clock' | 'turn' | 'press' | 'session'

/** One thing that happened to a run. */
export type RunEvent = {
  at: number
  ref: string
  kind: 'started' | 'moved' | 'sent' | 'committed' | 'waiting' | 'resumed' | 'proved' | 'judged' | 'opened' | 'note' | 'working' | 'dropped'
  cause: Cause
  /** What happened, as a person reads it. */
  text: string
  from?: RunPhase
  to?: RunPhase
  task?: number
  attempt?: number
  builder?: string
  sha?: string
  until?: number
  url?: string
}

/** Where the runs' logs are kept, from the project's folder. */
export const RUNS_DIR = '.theseus/runs'

/** The log of a run, under the project's folder. */
export const logPathOf = (root: string, ref: string): string => `${root.replace(/\/+$/, '')}/${RUNS_DIR}/${ref.replace(/[^A-Za-z0-9._-]+/g, '-')}.jsonl`

const PHASE_SAID: Record<RunPhase, string> = {
  ready: 'ready for its next task',
  'writing-tests': 'writing tests first',
  building: 'building',
  proving: 'proving',
  reviewing: 'reviewing',
  stuck: 'stopped for you',
  built: 'built',
  'reviewing-branch': 'reviewing its whole branch',
  submitted: 'submitted',
}

/** The events a change of a run makes: what differs between the run as it was and as it is kept. */
export const eventsOf = (was: Run | undefined, now: Run, at: number, cause: Cause): RunEvent[] => {
  const base = { at, ref: now.ref, cause }
  const events: RunEvent[] = []

  if (was === undefined) return [{ ...base, kind: 'started', to: now.phase, text: `Started ${now.kind === 'errand' ? 'an errand' : now.kind === 'review' ? 'a review follow-up' : 'a plan'} on ${now.branch}, from ${now.base}${now.isAuto ? ', going on by itself' : ''}` }]

  const sent = now.current
  if (sent !== null && (was.current === null || was.current.taskId !== sent.taskId || was.current.attempt !== sent.attempt || was.current.builder !== sent.builder))
    events.push({ ...base, kind: 'sent', task: sent.taskId, attempt: sent.attempt, builder: sent.builder, text: `Sent ${BUILDERS[sent.builder]?.title ?? sent.builder} on task ${sent.taskId}${sent.attempt > 1 ? `, try ${sent.attempt}` : ''}: ${sent.title}` })

  for (const commit of now.commits.slice(was.commits.length)) events.push({ ...base, kind: 'committed', task: commit.taskId, sha: commit.sha, text: `Committed task ${commit.taskId} as ${commit.sha.slice(0, 7)}: ${commit.title}` })

  if (now.proofLine !== was.proofLine && now.proofLine !== '') events.push({ ...base, kind: 'proved', ...(sent !== null ? { task: sent.taskId } : {}), text: `Proof${sent !== null ? ` of task ${sent.taskId}` : ''}: ${now.proofLine}` })
  if (now.verdictLine !== was.verdictLine && now.verdictLine !== '' && now.verdictLine !== 'reviewing') events.push({ ...base, kind: 'judged', ...(sent !== null ? { task: sent.taskId } : {}), text: `Reviewers${sent !== null ? ` on task ${sent.taskId}` : ''}: ${now.verdictLine}` })

  if (now.heldUntil !== undefined && now.heldUntil !== was.heldUntil) events.push({ ...base, kind: 'waiting', until: now.heldUntil, text: `Waiting until ${clockTime(now.heldUntil)}: ${now.heldWhy ?? 'the quota'}` })
  if (now.heldUntil === undefined && was.heldUntil !== undefined) events.push({ ...base, kind: 'resumed', text: 'Resumed after waiting for the quota' })

  if (now.pr !== '' && now.pr !== was.pr) events.push({ ...base, kind: 'opened', url: now.pr, text: `Opened ${now.pr}` })

  if (now.phase !== was.phase) events.push({ ...base, kind: 'moved', from: was.phase, to: now.phase, text: `${PHASE_SAID[was.phase].replace(/^./, first => first.toUpperCase())} → ${PHASE_SAID[now.phase]}` })

  return events
}

/** A log's text as its events; a line that does not read is left out, and counted. */
export const parseLog = (text: string): { events: RunEvent[]; unread: number } => {
  const events: RunEvent[] = []
  let unread = 0

  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      const event = JSON.parse(line) as RunEvent

      if (typeof event.at === 'number' && typeof event.kind === 'string' && typeof event.text === 'string') events.push(event)
      else unread += 1
    } catch {
      unread += 1
    }
  }

  return { events, unread }
}

/** Events as the lines of a log. */
export const logLines = (events: readonly RunEvent[]): string => events.map(event => `${JSON.stringify(event)}\n`).join('')

const CAUSE_SAID: Record<Cause, string> = { command: 'your command', tool: "Claude's call", clock: 'the clock', turn: "an agent's turn ending", press: 'a press on a pane', session: 'the session starting' }

/** A run's standing from its log, as /theseus says it: where it is, what moved it last and why, and its last events. */
export const standingText = (ref: string, phase: RunPhase, events: readonly RunEvent[], shown = 5, clock: (ms: number) => string = clockTime): string => {
  const own = events.filter(event => event.ref === ref)
  const last = own.at(-1)
  const moved = [...own].reverse().find(event => event.kind === 'moved')
  const waiting = [...own].reverse().find(event => event.kind === 'waiting' || event.kind === 'resumed')

  return [
    `${ref}: ${PHASE_SAID[phase]}${moved === undefined ? '' : ` since ${clock(moved.at)}, moved there by ${CAUSE_SAID[moved.cause]}`}.`,
    ...(waiting?.kind === 'waiting' && (waiting.until ?? 0) > (last?.at ?? 0) ? [`  ${waiting.text}.`] : []),
    ...own.slice(-shown).map(event => `  ${clock(event.at)} ${event.text}`),
  ].join('\n')
}
