import type { BuilderName, IssuePlan, PlanTaskState, Run, RunAsk, RunKind, RunPhase, RunTask, RunTaskState, RunWork, SentAgent } from '../../types'
import type { Forge, ForgeKind, Issue, NewRequest, Ran, Shell } from '../forge'
import { git } from '../git'
import { budgetOf } from '../budget'
import type { Budget, Quota } from '../budget'
import { issueRefOf, ownPlan, parsePlan } from '../run'
import type { TargetFolders } from '../run'
import type { Shown } from '../tests-first'
import { stop } from './send'

// The ports the build's loop stands on, which the mod makes of `$` and a test of plain fakes, and the helpers every
// phase of a run uses: git and the forge through the machine's shell, a run's work, its tasks marked.

/** The runs, as the session holds them and as they are kept across sessions. */
export interface Runs {
  at(ref: string): Promise<Run | null>
  all(): Promise<Run[]>
  /** Changes a run and keeps it; answers it as it now stands, or nothing where no run is on the ref. Throws on a move its course refuses. */
  keep(ref: string, change: (was: Run) => Run): Promise<Run | null>
  /** Holds a run, and its work, set out afresh. */
  put(run: Run, work: RunWork): Promise<void>
  /** Holds the work of a run as it was last read, for the pane. */
  setWork(ref: string, work: RunWork): Promise<void>
  /** A run kept from another session, where the session holds none. */
  stored(ref: string): Promise<Run | null>
  /** Lays a run down, here and across sessions. */
  drop(ref: string): Promise<void>
}

/** What the person is told of the runs, and what is asked of them next. */
export interface Board {
  /** The line beside a run in the pane; '' clears it. */
  say(ref: string, text: string): Promise<void>
  /** What is being done for a run right now. */
  working(ref: string, text: string): Promise<void>
  /** Asks something of a run, done by the clock or in a hook. */
  want(ref: string, what: RunAsk, arg?: string): Promise<void>
  /** Forgets what was asked of a run. */
  unwant(ref: string): Promise<void>
  /** Says what the person should know of now, outside the pane. */
  tell(text: string): Promise<void>
  /** Shows a run in the pane. */
  show(ref: string): Promise<void>
  /** Forgets the line beside a run. */
  forget(ref: string): Promise<void>
}

/** The agents the loop sends: builders, sent and sent back. */
export interface Agents {
  send(asked: { builder: BuilderName; description: string; prompt: string; cwd: string }): Promise<{ agentId?: string; deny?: string }>
  /** Sends a builder whose turn has ended back to its work; whether it could be reached. */
  sendBack(agentId: string, builder: BuilderName, text: string): Promise<boolean>
  /** Records what an agent was sent as, so its turns are held to it. */
  remember(agentId: string, sent: SentAgent): Promise<void>
  /** Refuses every tool an agent calls from now on, saying why: how the loop stops one, as no call ends a turn. */
  stop(agentId: string, why: string): Promise<void>
}

/** How the reviewers are asked to judge a change. */
export type ReviewAsk = { start?: boolean; about?: string; reviewers?: readonly string[]; against?: string; model?: string; ref?: string }

/** The other parts, as the build calls on them: the planner, tests first and verify. */
export interface Parts {
  planFor(ref?: string): Promise<IssuePlan | null>
  markTask(id: number, state: PlanTaskState, ref?: string): Promise<string>
  readIssue(input: string): Promise<({ ref: string } & Issue) | { error: string }>
  writeTestsFor(purpose: string, ref: string, weight: string, tree: string): Promise<string>
  testsFirstIn(tree: string): Promise<Shown>
  proveFor(tree: string, mustPass: readonly { file: string; name: string }[]): Promise<unknown>
  judgementFor(tree: string, asked?: ReviewAsk): Promise<unknown>
  targetsKnown(): Promise<TargetFolders[]>
  standardsText(): Promise<string>
  isMergedFrom(url: string, branch?: string): Promise<boolean>
  /** What a run's agents have cost, in a few lines; empty where nothing was counted to it. */
  spentOn(held: Run): Promise<string>
  /** Settles a plan for an auto run: its questions answered and its risks accepted alone, each listed. */
  settleAlone(ref: string): Promise<IssuePlan | null>
}

/** The machine the runs are built on: the project's folder, a shell in a folder, its forge, its files. */
export interface Machine {
  root(): Promise<string>
  /** A shell in a folder; the project's own where none is named. */
  shell(cwd?: string): Shell
  forge(kind: ForgeKind, cwd?: string): Forge
  /** Removes a worktree, with the worktrees the mods keep inside it. */
  removeTree(root: string, tree: string): Promise<{ ok: boolean; out: string }>
  write(path: string, text: string): Promise<void>
  /** Where a run's worktree of a branch is made. */
  treePath(root: string, branch: string): string
}

export interface Clock {
  now(): number
  /** The quota as the session last read it; nothing where it has no reading. */
  quota(): Promise<Quota | undefined>
}

export type Ports = { runs: Runs; board: Board; agents: Agents; parts: Parts; machine: Machine; clock: Clock; budget?: Budget }

/** Where the ports say a run stops spending; the defaults where they say nothing. */
export const budgetIn = (p: Ports): Budget => p.budget ?? budgetOf(undefined)

/** How a builder's turn ended, as the loop reads it. */
export type BuilderTurn = { answer?: string; isAborted: boolean; reason: string }

// How long the forge is given to answer a fetch, and to take a push
export const FETCH_TIMEOUT_MS = 120_000

export const PUSH_TIMEOUT_MS = 120_000

/** The phases a run waits in on something that is out: a builder, the tests written first, the proof or the reviewers. */
export const OUT: readonly RunPhase[] = ['writing-tests', 'building', 'proving', 'reviewing', 'reviewing-branch']

/** A git command in a folder, the project's own where none is named. */
export const gitAt = (p: Ports, args: readonly string[], cwd?: string): Promise<{ ok: boolean; out: string }> => git(p.machine.shell(cwd), args)

/** A command in a folder: whether it ended well, and what it said (its error when it did not). */
export const ranAt = async (p: Ports, argv: readonly string[], timeoutMs: number, cwd?: string): Promise<{ ok: boolean; out: string }> => {
  const ran = await p.machine.shell(cwd).run(argv, { timeoutMs })

  return { ok: ran.exitCode === 0, out: (ran.exitCode === 0 ? ran.stdout : ran.stderr || ran.stdout).trim() }
}

export const pushAt = (p: Ports, branch: string, cwd?: string): Promise<{ ok: boolean; out: string }> => ranAt(p, ['git', 'push', '-u', 'origin', branch], PUSH_TIMEOUT_MS, cwd)

/** Pushes a branch and opens its pull request; why not, where it could not. */
export const openAt = async (p: Ports, kind: ForgeKind, request: NewRequest, cwd?: string): Promise<{ url: string } | string> => {
  const pushed = await pushAt(p, request.branch, cwd)

  if (!pushed.ok) return `${request.branch} could not be pushed: ${pushed.out || 'git failed'}`

  return p.machine.forge(kind, cwd).openRequest(request)
}

/**
 * The work of a run, read afresh and kept for the pane: a plan's from the planner, by its issue; an errand's or a review's
 * from the tasks it keeps. A sentence when it could not be read.
 */
export async function workOf(p: Ports, held: Run): Promise<RunWork | string> {
  let made: RunWork | null | string

  made = held.kind === 'plan' ? parsePlan(await p.parts.planFor(issueRefOf(held))) : ownPlan(held)

  if (made === null) return `The planner keeps no plan of ${held.ref} any more.`
  if (typeof made === 'string') return made

  const kept = made

  await p.runs.setWork(held.ref, kept)

  return kept
}

/** Marks a task of a run: in the planner for a plan, in the run itself for any other. */
export async function mark(p: Ports, held: Run, id: number, state: RunTaskState, note?: string): Promise<void> {
  // The planner keeps no `asked`: a plan's task is handed back as it stands
  if (held.kind === 'plan') {
    if (state !== 'asked') await p.parts.markTask(id, state, issueRefOf(held))

    return
  }

  await p.runs.keep(held.ref, was => ({ ...was, tasks: (was.tasks ?? []).map(task => (task.id === id ? { ...task, state, ...(note !== undefined ? { note } : {}) } : task)) }))
}

/** What a run is start on: what it is, and the branch it is built on. */
export type Spec = { kind: RunKind; ref: string; url: string; title: string; branch: string; base?: string; isAuto: boolean; tasks?: RunTask[]; pr?: string; checks?: readonly string[]; setup?: readonly string[] }

/** The last line a forge's command said of its failure. */
export const lastLineOf = (ran: Ran): string => (ran.stderr || ran.stdout).trim().split('\n').slice(-1)[0] ?? ''
