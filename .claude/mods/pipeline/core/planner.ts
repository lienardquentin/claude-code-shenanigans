import type { IssuePlan, Planning, PlanTaskState, SentAgent } from '../types'
import { parseRemote, refText } from './forge'
import type { Forge, ForgeKind, Issue, IssueRef, Repo, Shell } from './forge'
import { inTurn } from './kit'
import { decidedOf, marked, parsePlan, parseRef, planOf, planPathOf, planText, plannerPrompt, ready, risksFor, tally, taskText, tidyPlan, withDecided, withUnproven } from './plan'
import type { TargetFolders } from './run'

// The planner's course: an issue read, a planner sent on it, the plan it lays kept and shown, its tasks marked as runs
// build them. It never touches the engine: it stands on the ports below, which the mod makes of `$`.

/** The plans: the one in force, those kept across sessions by their issue, and the planner at work. */
export interface Plans {
  inForce(): Promise<IssuePlan | null>
  setInForce(plan: IssuePlan | null): Promise<void>
  /** A plan kept across sessions, as it was kept. */
  kept(ref: string): Promise<unknown>
  keep(plan: IssuePlan): Promise<void>
  forget(ref: string): Promise<void>
  sitting(): Promise<Planning | null>
  sit(planning: Planning | null): Promise<void>
}

/** What the person, and a Claude that sent the planner, are told. */
export interface PlannerBoard {
  /** The pane's line; '' clears it. */
  note(text: string): Promise<void>
  /** Selects a task in the pane. */
  select(id: number): Promise<void>
  show(): Promise<void>
  toast(text: string): void
  notify(text: string): Promise<void>
  /** Hands Claude a message, as a prompt of its own. */
  hand(text: string): Promise<void>
}

export type PlannerPorts = {
  plans: Plans
  board: PlannerBoard
  agents: {
    send(asked: { description: string; prompt: string }): Promise<{ agentId?: string; deny?: string }>
    remember(agentId: string, sent: SentAgent): Promise<void>
  }
  parts: { targetsKnown(): Promise<TargetFolders[]>; isMergedFrom(url: string, branch?: string): Promise<boolean> }
  machine: { root(): Promise<string>; shell(cwd?: string): Shell; forge(kind: ForgeKind): Forge; read(path: string): Promise<unknown>; write(path: string, text: string): Promise<void> }
  clock: { now(): number }
}

/** The project's own repository, from its origin remote: what a bare `#12` names. */
export async function originOf(p: PlannerPorts): Promise<Repo | undefined> {
  const ran = await p.machine.shell().run(['git', 'remote', 'get-url', 'origin']).catch(() => undefined)

  return ran?.exitCode === 0 ? parseRemote(ran.stdout) : undefined
}

/** The issue, through the forge's CLI, else its REST API; why neither could read it, when neither could. */
export async function fetchIssue(p: PlannerPorts, ref: IssueRef, origin: Repo | undefined): Promise<Issue | string> {
  return p.machine.forge(ref.forge).readIssue(ref, origin)
}

/** The plan in force, read the way this build spells it: one kept before questions had answers reads as one that has them. */
export async function current(p: PlannerPorts): Promise<IssuePlan | null> {
  const held = await p.plans.inForce()

  return held === null ? null : tidyPlan(held)
}

/** Forgets the plan of an issue whose pull request is merged: kept across sessions, its file, and the plan in force. */
export async function forgetPlan(p: PlannerPorts, ref: string, pr: string): Promise<{ forgotten: boolean; text: string }> {
  if ((await kept(p, ref)) === undefined && (await current(p))?.ref !== ref) return { forgotten: false, text: `No plan of ${ref} is kept.` }
  if (!(await p.parts.isMergedFrom(pr))) return { forgotten: false, text: `${pr} is not a merged pull request: the plan of ${ref} is kept.` }

  const cwd = await p.machine.root()

  await p.plans.forget(ref)
  await p.machine.shell(cwd).run(['rm', '-f', planPathOf(cwd, ref)]).catch(() => undefined)
  if ((await current(p))?.ref === ref) await p.plans.setInForce(null)

  return { forgotten: true, text: `The plan of ${ref} is forgotten, its file with it.` }
}

/** Sets the plan in force, keeps it across sessions, and opens the pane on it. */
export async function keep(p: PlannerPorts, made: IssuePlan): Promise<void> {
  await p.plans.setInForce(made)
  await p.plans.keep(made)
}

export async function kept(p: PlannerPorts, ref: string): Promise<IssuePlan | undefined> {
  const held = (await p.plans.kept(ref)) as IssuePlan | undefined

  return held !== undefined && held !== null && Array.isArray(held.tasks) ? tidyPlan(held) : undefined
}

/**
 * Convenes the planner on an issue: reads it, and starts the planner in the background. Answers what was done, in a
 * sentence; the plan itself lands when the planner's turn ends.
 */
export async function makePlan(p: PlannerPorts, input: string, by: Planning['by'], isAgain: boolean): Promise<{ text: string; plan?: IssuePlan }> {
  const origin = await originOf(p)
  const ref = parseRef(input, origin)

  if (typeof ref === 'string') return { text: ref }

  const key = refText(ref)
  const sitting = await p.plans.sitting()

  if (sitting !== null) return { text: `The planner is already on ${sitting.ref}; wait for its plan before starting another.` }

  const prior = await kept(p, key)
  const before = isAgain ? undefined : prior
  // What the person decided of the issue in every plan of it so far: the planner plans with it, and asks it no more
  const decided = prior === undefined ? [] : decidedOf(prior)
  // And what they chose of its risks: the accepted are raised no more, the ones to cover become tasks
  const accepted = prior?.accepted ?? []
  const covered = prior?.risks.filter(risk => risk.wantsTask) ?? []

  if (before !== undefined) {
    await keep(p, before)

    return { text: `A plan of ${key} is kept from ${new Date(before.at).toISOString().slice(0, 10)} (${tally(before)}): shown in the pane. Plan it again to plan afresh.`, plan: before }
  }

  await p.board.note(`Reading ${key}…`)

  const cwd = await p.machine.root()
  const planPath = planPathOf(cwd, key)
  // The folder ignores itself, and a plan an earlier planner wrote is not read as this one's
  await p.machine.write(`${cwd}/.pipeline/.gitignore`, '*\n').catch(() => undefined)
  await p.machine.write(planPath, '').catch(() => undefined)

  const issue = await fetchIssue(p, ref, origin)

  if (typeof issue === 'string') {
    await p.board.note(issue)

    return { text: issue }
  }

  const started = await p.agents.send({ description: `Plan ${key}`, prompt: plannerPrompt(key, issue, decided, planPath, { accepted, covered }) }).catch((error: unknown) => ({ deny: error instanceof Error ? error.message : String(error), agentId: undefined }))

  if (started.agentId !== undefined && started.agentId !== '') await p.agents.remember(started.agentId, { role: 'planner', root: cwd, tree: cwd, files: [planPath], ref: key })

  if (started.deny !== undefined) {
    const why = `The planner could not be sent on ${key}: ${started.deny}`

    await p.board.note(why)

    return { text: why }
  }

  await p.plans.sit(({ ref: key, url: issue.url, title: issue.title, agentId: started.agentId ?? '', by, at: p.clock.now(), decided, accepted, planPath }))
  await p.board.note('')

  return { text: `The planner is on ${key}, "${issue.title}": a planner is studying it against the codebase. The plan lands in the planner pane${by === 'tool' ? ' and as a message to you' : ''} when it is done.` }
}

/**
 * A plan the planner made: kept and shown, and the person told when they sent it. The planner is on until its
 * turn ends, which wakes a Claude that sent it: a prompt cannot be queued from within the planner's own tool call.
 */
export async function land(p: PlannerPorts, sitting: Planning, laid: IssuePlan): Promise<void> {
  // A task verify cannot prove is a risk the person decides, and one they accepted before stays accepted
  const made = withDecided(withUnproven(laid, await p.parts.targetsKnown().catch(() => [])), sitting.decided ?? [], sitting.accepted ?? [])

  await p.plans.sit(({ ...sitting, isLaid: true }))
  await keep(p, made)
  await p.board.select(ready(made)[0]?.id ?? 0)
  await p.board.note('')
  await p.board.show()

  if (sitting.by === 'tool') return

  const asked = made.questions.length > 0 ? `, ${made.questions.length} ${made.questions.length === 1 ? 'question' : 'questions'} for you` : ''

  p.board.toast(`Plan: ${made.tasks.length} tasks planned for ${made.ref}${asked}`)
  await p.board.notify(`${made.tasks.length} tasks planned for ${made.title}${asked}`)
}

/**
 * The planner's turn has ended. A plan it did not lay through the tool is read from its answer; then the planner rises,
 * and a Claude that sent it is handed the plan, or told why there is none.
 */
export async function adjourn(p: PlannerPorts, sitting: Planning, answer: string, ended: string): Promise<void> {
  const about = { ref: sitting.ref, url: sitting.url, title: sitting.title, at: p.clock.now() }
  // The plan the planner wrote to its file; its answer is read only where the file holds none
  const written = sitting.planPath === undefined ? '' : await p.machine.read(sitting.planPath).catch(() => '')
  const fromFile = typeof written === 'string' && written.trim() !== '' ? planOf(written, about) : undefined
  const made = sitting.isLaid
    ? undefined
    : typeof fromFile === 'object'
      ? fromFile
      : ended === 'answer'
      ? parsePlan(answer, about)
      : `The planner on ${sitting.ref} ended without an answer: ${ended === 'aborted' ? 'it was interrupted (an Esc, or the mod reloading while it sat)' : ended === 'refusal' ? 'the model refused' : 'an API error ended it'}. Plan it again.`

  if (typeof made === 'object') await land(p, sitting, made)

  await p.plans.sit(null)

  if (typeof made === 'string') {
    await p.board.note(made)
    p.board.toast(`Plan: no plan for ${sitting.ref}`)
  }

  const held = await current(p)

  if (sitting.by !== 'tool') return

  const text = typeof made === 'string' || held === null ? `The planner made no plan of ${sitting.ref}: ${typeof made === 'string' ? made : 'none was laid.'}` : `The planner has planned ${held.ref}. Present the plan to the person; begin no task until they say so.\n\n${planText(held)}`

  await p.board.hand(text)
}


/**
 * The plan of an issue: the one in force when it is of that issue, else the one kept across sessions. The plan in force
 * when none is named. Runs built side by side each work from their own.
 */
export async function planFor(p: PlannerPorts, ref = ''): Promise<IssuePlan | null> {
  const held = await current(p)

  return ref === '' || held?.ref === ref ? held : ((await kept(p, ref)) ?? null)
}

/** Keeps a plan: in force, and shown, when it is the plan in force; across sessions alone when it is another issue's. */
export async function keepPlan(p: PlannerPorts, made: IssuePlan): Promise<void> {
  if ((await current(p))?.ref === made.ref) await keep(p, made)
  else await p.plans.keep(made)
}

// One mark at a time: a run's lanes mark their tasks beside one another, each writing the plan as it read it
const oneMark = inTurn()

/** Marks a task of a plan, the one in force when none is named, keeps it, and says where the run stands. */
export function markTask(p: PlannerPorts, id: number, state: PlanTaskState, ref = ''): Promise<string> {
  return oneMark(() => markNow(p, id, state, ref))
}

export async function markNow(p: PlannerPorts, id: number, state: PlanTaskState, ref: string): Promise<string> {
  const held = await planFor(p, ref)

  if (held === null) return ref === '' ? 'No plan is in force: have the planner plan an issue first.' : `No plan of ${ref} is kept.`

  const next = marked(held, id, state)

  if (typeof next === 'string') return next

  await keepPlan(p, next)

  const open = ready(next).filter(task => task.state === 'todo')
  const task = next.tasks.find(one => one.id === id)

  return [
    task === undefined ? '' : taskText(task, risksFor(next, task.id)),
    '',
    next.tasks.every(one => one.state === 'done') ? `Every task of ${next.ref} is done.` : open.length > 0 ? `Ready next: ${open.map(one => `${one.id}. ${one.title}`).join('; ')}.` : `${tally(next)}; what is left waits on a task in progress.`,
  ].join('\n')
}

/** An issue as the planner reads it, for a part that works from one: its short ref and what the forge says, or why it could not be read. */
export async function readIssue(p: PlannerPorts, input: string): Promise<({ ref: string } & Issue) | { error: string }> {
  const origin = await originOf(p)
  const ref = parseRef(input, origin)

  if (typeof ref === 'string') return { error: ref }

  const issue = await fetchIssue(p, ref, origin)

  return typeof issue === 'string' ? { error: issue } : { ref: refText(ref), ...issue }
}