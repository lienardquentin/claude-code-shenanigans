import type { Run } from '../../types'
import { errorText, inTurn } from '../kit'
import { checksVerdict, runCommands } from '../verification'
import { afterProof, issueRefOf, parseJudgement, proofVerdict, purposeOf, reviewerModelFor } from '../run'
import { workOf } from './ports'
import type { Ports } from './ports'
import { again, headMoved, stop } from './send'
import { settle } from './review'
import { commitNow } from './commit'

// A builder's change proved: verify's proof of it, or the commands the plan or the issue states, and what a builder
// changed of the tests written first.

// One proof at a time: lanes build beside one another, but a service's proof plays against one database kept warm
export const oneProof = inTurn()

/**
 * The proof of a run's change: verify's, of the targets the project names; where it names none, the run's
 * verification commands, run in its worktree.
 */
export async function proofOf(p: Ports, held: Run, written: readonly { file: string; name: string }[]): Promise<unknown> {
  if ((await p.parts.targetsKnown()).length > 0) return p.parts.proveFor(held.tree, written)

  const checks = held.checks ?? []

  if (checks.length === 0) return { verdict: 'unlooked', line: 'Verify knows no target here, and the run states no verification command' }

  return checksVerdict(await runCommands(p.machine.shell(held.tree), checks), checks)
}

/** What a builder's answer left unticked: each `- [ ]` item of a checklist it wrote. */
export const untickedOf = (answer: string): string[] =>
  answer
    .split('\n')
    .map(line => /^\s*[-*]\s+\[ \]\s+(.+)$/.exec(line)?.[1]?.trim() ?? '')
    .filter(item => item !== '')

/** Proves what a builder built: settled, the reviewers are sent to judge it; else the task goes up a rung. */
export async function prove(p: Ports, ref: string): Promise<void> {
  const held = await p.runs.at(ref)

  if (held === null || held.phase !== 'proving' || held.current === null) return

  const out = held.current
  const moved = await headMoved(p, held)

  if (moved !== undefined) return stop(p, held, moved)

  await p.board.working(ref, `Proving task ${out.taskId}…`)

  // The reviewers are sent here, on the change and what it is for: the proof owes none at the turn's end. the test writer's
  // tests, written from the task before it was built, must pass for the proof to settle, all but
  // those a builder has since said cannot run here
  const isSeen = held.testsToPass?.taskId === out.taskId
  const mirror = isSeen ? await mirrorOf(p, held) : { amendments: [], tampered: [], unrun: [] }
  const written = isSeen ? (held.testsToPass?.tests ?? []).filter(test => !mirror.unrun.some(one => one.file === test.file && one.name === test.name)) : []
  const verdict = proofVerdict(await oneProof(() => proofOf(p, held, written)).catch((error: unknown) => `Verify could not prove the change: ${errorText(error)}`))

  await p.runs.keep(ref, was => ({ ...was, proof: verdict.text, proofLine: verdict.line, unproven: verdict.unhandled }))

  const step = afterProof(verdict, out, mirror.tampered)

  if (step.kind === 'stop') return stop(p, held, step.why)
  if (step.kind === 'again') return again(p, ref, step.why, step.line)
  if (step.kind === 'commit') return void (await commitNow(p, ref, step.minor))

  await p.board.working(ref, `Reviewing task ${out.taskId}…`)

  const made = await workOf(p, held)
  const task = typeof made === 'string' ? undefined : made.tasks.find(one => one.id === out.taskId)
  const about = typeof made === 'string' || task === undefined ? '' : purposeOf(held, made, task, mirror.amendments)
  // Both reviewers judge every change: a task's weight is the planner's guess, and what a change lets in is known only
  // once it is made. Where nothing proves what it reached, they judge with their own model; else as the task's weight
  // and risks ask, a task that is not heavy on a lighter model
  const isBlind = typeof made === 'string' || task === undefined || verdict.unhandled.length > 0
  const model = isBlind ? undefined : reviewerModelFor(made, task)
  const judged = parseJudgement(await p.parts.judgementFor(held.tree, { start: true, about, reviewers: ['reviewer-correctness', 'reviewer-security'], ref: issueRefOf(held), ...(model !== undefined ? { model } : {}) }).catch((error: unknown) => errorText(error)))

  await p.runs.keep(ref, was => ({ ...was, phase: 'reviewing', verdictLine: judged.line }))
  await settle(p, ref, judged)
}

/**
 * What a builder changed of the test writer's tests and why, what was taken out of them with no reason, and which cannot run
 * here, as tests first keeps it. A test a builder said cannot run here is judged as a change is, its reason with it.
 */
export async function mirrorOf(p: Ports, held: Run): Promise<{ amendments: { file: string; why: string; by: string }[]; tampered: { file: string; lines: string[] }[]; unrun: { file: string; name: string }[] }> {
  const shown = await p.parts.testsFirstIn(held.tree)
  const unrun = shown?.unrun ?? []
  const said = unrun.flatMap(one => (one.by !== undefined ? [{ file: one.file, why: `${one.name} cannot run here, and is owed no passing: ${one.why}`, by: one.by }] : []))

  return { amendments: [...(shown?.amendments ?? []), ...said], tampered: shown?.tampered ?? [], unrun }
}
