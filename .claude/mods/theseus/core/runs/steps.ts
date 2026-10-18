import type { Run } from '../../types'
import type { Shown } from '../tests-first'
import { strings, text, isSettled } from './work'
import type { Plan, Task, Vision } from './work'
import { ownMinor } from './fence'

// What each answer leads to: a proof, the reviewers' verdict, a failed try, the whole branch judged, the tests
// written first.

/** The the proof as a run reads it. */
export type ProofVerdict = { isSettled: boolean; isUnlooked: boolean; line: string; unhandled: string[]; unreached: string[]; text: string }

/** An answer as a part hands it, or as JSON text: the object it is, or why it is none. */
export const heldOf = (answer: unknown): Record<string, unknown> | string => {
  if (typeof answer === 'object' && answer !== null) return answer as Record<string, unknown>

  const said = String(answer)

  try {
    const held = JSON.parse(said) as unknown

    return typeof held === 'object' && held !== null ? (held as Record<string, unknown>) : said
  } catch {
    return said
  }
}

/**
 * The proof, as it answers a part: whether it settles the change (every changed run pinned, no test turned),
 * whether a target the change reached could not be looked at at all, which no builder can mend, the targets nothing
 * proves, the targets no kept run sees, and the proof as it reads. An answer that is not one is a proof that could not
 * be looked at.
 */
export const proofVerdict = (answer: unknown): ProofVerdict => {
  const held = heldOf(answer)

  if (typeof held === 'string' || typeof held.verdict !== 'string') {
    const said = typeof held === 'string' ? held : JSON.stringify(held)

    return { isSettled: false, isUnlooked: true, line: `Verify answered no proof that reads: ${said.trim().slice(0, 200)}`, unhandled: [], unreached: [], text: said }
  }

  return { isSettled: held.verdict === 'settled', isUnlooked: held.verdict === 'unlooked', line: text(held.line) || held.verdict, unhandled: strings(held.unhandled), unreached: strings(held.unreached), text: text(held.text) || JSON.stringify(held) }
}

/** The reviewers' judgement as a part reads it: the verdict, their findings a line each, where each minor one is, and the verdict in a line. */
export type Judged = { verdict: string; blocking: string[]; minor: string[]; minorAt: { where: string; line: string }[]; line: string }

/** The reviewers' judgement as verify answers it to a part. */
export const parseJudgement = (answer: unknown): Judged => {
  const held = heldOf(answer)

  if (typeof held === 'string') return { verdict: 'unreadable', blocking: [], minor: [], minorAt: [], line: `verify answered no judgement: ${held.trim().slice(0, 200)}` }

  const verdict = typeof held.verdict === 'string' ? held.verdict : 'unreadable'
  const seats = (Array.isArray(held.seats) ? held.seats : []) as { title?: unknown; state?: unknown; why?: unknown; findings?: { severity?: unknown; where?: unknown; text?: unknown }[] }[]
  const found = (severity: string) =>
    seats.flatMap(seat =>
      (Array.isArray(seat.findings) ? seat.findings : [])
        .filter(one => one.severity === severity)
        .map(one => {
          const where = typeof one.where === 'string' ? one.where : ''

          return { where, line: `- ${String(seat.title ?? '')}${where !== '' ? `, ${where}` : ''}: ${String(one.text ?? '')}` }
        }),
    )
  const blocking = found('blocking').map(one => one.line)
  const minorAt = found('minor')
  const minor = minorAt.map(one => one.line)
  const silent = seats.filter(seat => seat.state === 'silent').map(seat => `${String(seat.title ?? '')} ${String(seat.why ?? 'could not judge')}`)
  const many = (count: number, one: string) => `${count} ${one}${count === 1 ? '' : 's'}`
  const line =
    verdict === 'pass'
      ? `passed${minor.length > 0 ? `, ${many(minor.length, 'minor finding')}` : ''}`
      : verdict === 'fail'
        ? many(blocking.length, 'blocking finding')
        : verdict === 'silent'
          ? `not judged: ${silent.join('; ')}`
          : verdict === 'reviewing'
            ? 'reviewing'
            : verdict

  return { verdict, blocking, minor, minorAt, line }
}

/** What a builder is sent again with: what the proof found, or the findings that block its change. */
export type Why = { proof?: string; findings?: string[] }

/** What comes next of a task's try, once its change is proved or judged. */
export type Step =
  | { kind: 'judge' }
  | { kind: 'commit'; minor: readonly string[] }
  | { kind: 'again'; why: Why; line: string }
  | { kind: 'tidy'; minor: readonly string[]; otherwise: { kind: 'commit'; minor: readonly string[] } }
  | { kind: 'prove' }
  | { kind: 'wait' }
  | { kind: 'stop'; why: string }

/**
 * What a proof of a task's change comes to: stopped where verify could not look (no builder mends that, and no
 * try is spent on it), tried again where it does not settle or the tests first were tampered with, committed as it
 * passed where the change was only rebased since, else judged.
 */
export const afterProof = (verdict: ProofVerdict, out: { taskId: number; isRebased?: boolean; minor?: readonly string[] }, tampered: readonly { file: string; lines: readonly string[] }[]): Step => {
  if (verdict.isUnlooked) return { kind: 'stop', why: `${verdict.line}. No builder can mend that: set the target right in .claude/theseus.toml, then put task ${out.taskId} up for verification again.` }
  if (!verdict.isSettled) return { kind: 'again', why: { proof: verdict.text }, line: verdict.line }

  // What was taken out of the tests written first without a reason blocks the change, as a finding would
  if (tampered.length > 0) {
    const findings = tampered.map(one => `- Tests first, ${one.file}: locked lines of the tests written first were taken out with no reason given (${one.lines.slice(0, 2).map(line => `\`${line.trim()}\``).join(', ')}). Put them back, or call mcp__theseus__amend_test with the file and why before changing them.`)

    return { kind: 'again', why: { findings }, line: `${findings.length} ${findings.length === 1 ? 'file' : 'files'} of the tests written first changed with no reason` }
  }

  // A lane's change the reviewers passed, rebased since onto its run's branch, lands as it passed
  if (out.isRebased === true) return { kind: 'commit', minor: out.minor ?? [] }

  return { kind: 'judge' }
}

/** Whether a judgement's minor findings would send the builder back to tidy them: a pass's, once only. */
export const isTidyAsked = (judged: Judged, out: { isTidied?: boolean }): boolean => judged.verdict === 'pass' && judged.minor.length > 0 && out.isTidied !== true

/**
 * What the reviewers' judgement of a task's change comes to: waited on while they review; tidied by its builder where it
 * passed with minor findings about what the change wrote (`ownMinor`), committed as it is where the builder cannot be
 * reached; committed where it passed; tried again on blocking findings; proved and judged afresh where the change moved
 * or they never reviewed it; else stopped.
 */
export const afterVerdict = (judged: Judged, out: { taskId: number; isTidied?: boolean }, ownMinor: readonly string[]): Step => {
  if (judged.verdict === 'reviewing') return { kind: 'wait' }
  if (isTidyAsked(judged, out) && ownMinor.length > 0) return { kind: 'tidy', minor: ownMinor, otherwise: { kind: 'commit', minor: judged.minor } }
  if (judged.verdict === 'pass') return { kind: 'commit', minor: judged.minor }
  if (judged.verdict === 'fail') return { kind: 'again', why: { findings: judged.blocking }, line: judged.line }
  if (judged.verdict === 'stale' || judged.verdict === 'unsettled' || judged.verdict === 'none') return { kind: 'prove' }

  return { kind: 'stop', why: `The reviewers could not judge task ${out.taskId}: ${judged.line}. Commit it once they can, or send it again.` }
}

/**
 * What follows a try that did not pass: its builder sent back once, with all it read and did still in its context,
 * where it was not already; else, or where it cannot be reached, a fresh builder a rung up while tries are left, or the
 * run stopped for the person. `tries` is how many the task is given; none where the task is no longer in the work.
 */
export const afterFailedTry = (out: { taskId: number; attempt: number; by: string; isResumed?: boolean }, tries: number | undefined, line: string, tree: string): { isSentBack: boolean; otherwise: { kind: 'climb'; attempt: number } | { kind: 'stop'; why: string } } => ({
  isSentBack: out.isResumed !== true,
  otherwise:
    tries !== undefined && out.attempt < tries
      ? { kind: 'climb', attempt: out.attempt + 1 }
      : { kind: 'stop', why: `Task ${out.taskId} did not pass after ${out.attempt} ${out.attempt === 1 ? 'try' : 'tries'}, the last ${out.by}'s: ${line}. Finish it by hand in ${tree} and commit it from the pane, or send it again.` },
})

/** What the reviewers do while they judge a plan's whole branch. */
export const WARDING = 'The reviewers judge the whole branch'

/**
 * Why a run cannot submit yet: a lane lands by itself, a run is submitted once, and every task is committed first (a review
 * may push the answers it has); nothing when it may.
 */
export const whyNotSail = (quest: Pick<Run, 'ref' | 'kind' | 'phase' | 'pr' | 'lane' | 'commits'>): string | undefined => {
  if (quest.lane !== undefined) return `A lane lands on its run's branch by itself: it is ${quest.lane.of} that is submitted.`
  if (quest.phase === 'submitted') return quest.kind === 'review' ? `The answers on ${quest.ref} are pushed.` : `The pull request is open: ${quest.pr}`
  if (quest.phase === 'reviewing-branch') return `${WARDING} of ${quest.ref}: the pull request opens once they pass it.`
  if (quest.phase !== 'built' && !(quest.kind === 'review' && (quest.phase === 'ready' || quest.phase === 'stuck') && quest.commits.length > 0)) return `The run on ${quest.ref} is not built: it is ${quest.phase}. Every task is committed first.`

  return undefined
}

/**
 * What the reviewers' judgement of a plan's whole branch comes to: waited on while they review, submitting once they pass it,
 * else stopped for the person with what blocks it or why they could not judge.
 */
export const afterWard = (judged: Judged, quest: Pick<Run, 'ref' | 'tree'>): { kind: 'wait'; said: string } | { kind: 'submit'; line: string } | { kind: 'stop'; why: string; line: string } => {
  if (judged.verdict === 'reviewing') return { kind: 'wait', said: `${WARDING} of ${quest.ref} before it is submitted: the pull request opens once they pass it.` }
  if (judged.verdict === 'pass') return { kind: 'submit', line: `the whole branch ${judged.line}` }

  return {
    kind: 'stop',
    why:
      judged.verdict === 'fail'
        ? `The reviewers found what blocks the whole branch of ${quest.ref}:\n${judged.blocking.join('\n')}\nFix it in ${quest.tree} and commit, then submit again: they judge the branch as it then stands.`
        : `The reviewers could not judge the whole branch of ${quest.ref} (${judged.line}): submit again to have them judge it.`,
    line: `the whole branch: ${judged.line}`,
  }
}

/** What the tests written first showed of a task, or why they could not be read at all. */
export type Seen = Shown | { state: 'unreadable'; why: string }

/**
 * What a task comes to once the test writer has shown its tests, or shown that there are none: still waited on while
 * it writes; lost where the task is no longer in the work; clouded, to be sent again, where its tests could not be
 * read; else built, with the tests to pass where it wrote any. `gazed` is the task it was sent on.
 */
export const afterGaze = (shown: Seen, made: Plan | string, testsFor: number | undefined, ref: string): { kind: 'wait' } | { kind: 'lost'; why: string } | { kind: 'clouded'; task: Task; why: string } | { kind: 'build'; plan: Plan; task: Task; testsToPass: Vision | null; said: string } => {
  if (shown.state === 'gazing') return { kind: 'wait' }

  const task = typeof made === 'string' ? undefined : made.tasks.find(one => one.id === testsFor)

  if (typeof made === 'string' || task === undefined) return { kind: 'lost', why: `The task its tests were written for is not in the plan of ${ref} any more.` }
  if (shown.state === 'clouded' || shown.state === 'unreadable') return { kind: 'clouded', task, why: `The tests written first of task ${task.id} could not be read: ${shown.why ?? ''}. Send it again, and the test writer writes them anew.` }

  return {
    kind: 'build',
    plan: made,
    task,
    testsToPass: shown.state === 'shown' ? { taskId: task.id, tests: shown.tests ?? [], unrun: shown.unrun ?? [], red: shown.red ?? '' } : null,
    said: shown.state === 'empty' ? `Nothing to test first in task ${task.id}: ${shown.why ?? ''}` : '',
  }
}
