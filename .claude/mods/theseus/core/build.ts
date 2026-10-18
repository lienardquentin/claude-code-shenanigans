import type { BuilderName, IssuePlan, PlanTaskState, Run, RunAsk, RunCommit, RunKind, RunPhase, RunTask, RunTaskState, RunWork, SentAgent } from '../types'
import { UNMODDED } from './change'
import { forgeOfUrl } from './forge'
import type { Forge, ForgeKind, Issue, NewRequest, Ran, Shell } from './forge'
import { applyAfresh, commitTask, git, gitRunsOf, landLane, leakOf } from './git'
import { budgetOf, clockTime, holdOf, isOverBudget, shareOf } from './budget'
import type { Budget, Quota } from './budget'
import { errorText, inTurn } from './kit'
import { checksVerdict, runCommands, setupOf, verificationOf } from './verification'
import { restingPhase } from './phases'
import {
  HOW_TO,
  BUILDERS,
  WARDING,
  afterFailedTry,
  afterGaze,
  afterProof,
  afterVerdict,
  afterWard,
  besideOf,
  branchOf,
  briefFor,
  commitMessage,
  conflictPrompt,
  errandTask,
  handBackOf,
  isAllDone,
  isTidyAsked,
  issueRefOf,
  laneBranchOf,
  laneRefOf,
  nextTask,
  ownMinor,
  ownPlan,
  parseJudgement,
  parsePlan,
  parseWorktrees,
  proofVerdict,
  purposeOf,
  readyTasks,
  requestOf,
  reviewerModelFor,
  sendBackPrompt,
  tally,
  tidyPrompt,
  triesOf,
  unsettledOf,
  wardModelFor,
  wardPurpose,
  whyNotSail,
} from './run'
import type { Judged, Retry, Seen, TargetFolders, Why } from './run'
import type { Shown } from './tests-first'

// The build's loop: a run set out in a worktree, each task's tests written first, a builder sent, the change proved,
// judged and committed, lanes landed, the branch judged whole and the pull request opened. It never touches the engine:
// it stands on the ports below, which the mod makes of `$`, and a test of plain fakes.

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
const budgetIn = (p: Ports): Budget => p.budget ?? budgetOf(undefined)

/** How a builder's turn ended, as the loop reads it. */
export type BuilderTurn = { answer?: string; isAborted: boolean; reason: string }

// How long the forge is given to answer a fetch, and to take a push
const FETCH_TIMEOUT_MS = 120_000
const PUSH_TIMEOUT_MS = 120_000

/** The phases a run waits in on something that is out: a builder, the tests written first, the proof or the reviewers. */
export const OUT: readonly RunPhase[] = ['writing-tests', 'building', 'proving', 'reviewing', 'reviewing-branch']

/** A git command in a folder, the project's own where none is named. */
const gitAt = (p: Ports, args: readonly string[], cwd?: string): Promise<{ ok: boolean; out: string }> => git(p.machine.shell(cwd), args)

/** A command in a folder: whether it ended well, and what it said (its error when it did not). */
const ranAt = async (p: Ports, argv: readonly string[], timeoutMs: number, cwd?: string): Promise<{ ok: boolean; out: string }> => {
  const ran = await p.machine.shell(cwd).run(argv, { timeoutMs })

  return { ok: ran.exitCode === 0, out: (ran.exitCode === 0 ? ran.stdout : ran.stderr || ran.stdout).trim() }
}

const pushAt = (p: Ports, branch: string, cwd?: string): Promise<{ ok: boolean; out: string }> => ranAt(p, ['git', 'push', '-u', 'origin', branch], PUSH_TIMEOUT_MS, cwd)

/** Pushes a branch and opens its pull request; why not, where it could not. */
const openAt = async (p: Ports, kind: ForgeKind, request: NewRequest, cwd?: string): Promise<{ url: string } | string> => {
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

/** The branch the person's checkout is on, else the remote's default, else main: what a run starts from. */
export async function baseOf(p: Ports, root: string, branch: string): Promise<string> {
  const current = await gitAt(p, ['rev-parse', '--abbrev-ref', 'HEAD'], root)

  if (current.ok && current.out !== '' && current.out !== 'HEAD' && current.out !== branch) return current.out

  const found = await gitAt(p, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], root)

  return found.ok && found.out !== '' ? found.out.replace(/^origin\//, '') : 'main'
}

/**
 * Where a run is built: the folder its branch is checked out in already (a worktree, or the person's own checkout),
 * else a worktree made for it under .fellowship/trees, its branch made from its base when there is none. A review's
 * branch is the pull request's, fetched from the forge. Answers why there is none where it could not be made.
 */
export async function placeTree(p: Ports, branch: string, base: string | undefined, isFetched: boolean): Promise<{ tree: string; base: string; isNew?: true } | string> {
  const root = await p.machine.root()
  const from = base ?? (await baseOf(p, root, branch))
  const at = parseWorktrees((await gitAt(p, ['worktree', 'list', '--porcelain'], root)).out).find(one => one.branch === branch)

  if (at !== undefined) return { tree: at.path, base: from }

  const tree = p.machine.treePath(root, branch)

  // The folder ignores itself: no run's worktree is part of the project's checkout
  await p.machine.write(`${root}/.theseus/.gitignore`, '*\n')

  const fetched = isFetched ? await ranAt(p, ['git', 'fetch', 'origin', branch], FETCH_TIMEOUT_MS, root) : undefined
  const exists = await gitAt(p, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], root)

  // A review's branch lives on origin; one that is not there is a fork's, which the build cannot push to
  if (fetched !== undefined && !fetched.ok && !exists.ok) return `${branch} could not be fetched from origin (${fetched.out || 'git said nothing'}): a pull request from a fork is not answered here, as its branch cannot be pushed to from this repository.`

  const added = await gitAt(p, exists.ok || isFetched ? ['worktree', 'add', tree, branch] : ['worktree', 'add', '-b', branch, tree, from], root)

  return added.ok ? { tree, base: from, isNew: true } : `The worktree of ${branch} could not be made at ${tree}: ${added.out}`
}

/**
 * Takes in what its base gained since the run left it, so the tasks still to come are built on it and its pull
 * request does not fall into conflict. A worktree with work in it is only said to be behind; a merge that conflicts is
 * taken back. Answers what stops the run, or undefined when it may go on.
 */
export async function followBase(p: Ports, held: Run): Promise<string | undefined> {
  // A review is built on the pull request's own branch, which its author keeps
  if (held.kind === 'review' || held.base === '') return undefined

  const fetched = await ranAt(p, ['git', 'fetch', 'origin', held.base], FETCH_TIMEOUT_MS, held.tree)
  const upstream = fetched.ok ? `origin/${held.base}` : held.base

  if ((await gitAt(p, ['merge-base', '--is-ancestor', upstream, 'HEAD'], held.tree)).ok) return undefined

  if ((await gitAt(p, ['status', '--porcelain'], held.tree)).out !== '') {
    await p.board.say(held.ref, `${held.branch} is behind ${upstream}, but its worktree holds a change: it is taken in once the change is committed.`)

    return undefined
  }

  const merged = await gitAt(p, ['merge', '--no-edit', upstream], held.tree)

  if (merged.ok) {
    // The merge is no builder's commit: a task sent again after it is judged against HEAD as it now stands
    await p.runs.keep(held.ref, was => ({ ...was, current: was.current === null ? null : { ...was.current, head: '' } }))
    await p.board.say(held.ref, `${held.branch} took in what ${upstream} gained since it left it.`)

    return undefined
  }

  const conflicted = (await gitAt(p, ['diff', '--name-only', '--diff-filter=U'], held.tree)).out.split('\n').filter(line => line !== '')

  await gitAt(p, ['merge', '--abort'], held.tree)

  return `${held.branch} cannot take in ${upstream}: it conflicts in ${conflicted.join(', ') || 'the tree'}. Merge it in ${held.tree} by hand, then go on.`
}

/** What a run is start on: what it is, and the branch it is built on. */
export type Spec = { kind: RunKind; ref: string; url: string; title: string; branch: string; base?: string; isAuto: boolean; tasks?: RunTask[]; pr?: string; checks?: readonly string[]; setup?: readonly string[] }

/**
 * Sets a run out, or takes it up where it was left: in its worktree, its first task sent by the clock, outside the
 * call that asked. Answers what was done, in a sentence.
 */
export async function begin(p: Ports, spec: Spec, made: RunWork): Promise<string> {
  const held = (await p.runs.at(spec.ref)) ?? (await p.runs.stored(spec.ref)) ?? null

  if (held !== null && held.phase !== 'submitted' && (held.kind ?? 'plan') !== spec.kind) return `The build is on ${spec.ref} already, as ${held.kind === 'errand' ? 'an errand' : `a ${held.kind}`} (${held.phase}): finish or abandon it first.`

  const resumed = held !== null && held.phase !== 'submitted' ? held : undefined
  const branch = resumed?.branch ?? spec.branch
  // A review answers on the branch of a run that may be kept still: its commands prove the answers too
  const built = spec.kind === 'review' ? (await p.runs.all()).find(one => one.kind !== 'review' && one.branch === spec.branch) : undefined
  const checks = [...(resumed?.checks ?? spec.checks ?? built?.checks ?? [])]
  const setup = [...(resumed?.setup ?? spec.setup ?? built?.setup ?? [])]

  // Where the project names no target, the commands its plan or its issue states are the proof: with none, nothing
  // could prove a task. A review is the pull request's, which states none: it starts, and its proof says so
  if (spec.kind !== 'review' && checks.length === 0 && (await p.parts.targetsKnown()).length === 0) return noProofFor(spec)

  const placed = await placeTree(p, branch, resumed?.base ?? spec.base, spec.kind === 'review')

  if (typeof placed === 'string') return placed

  // A fresh worktree holds what git tracks alone: what it needs besides is put there first, as the plan or the issue says
  if (placed.isNew === true && setup.length > 0) {
    const ready = await runCommands(p.machine.shell(placed.tree), setup)

    if (!ready.ok) return `The worktree ${placed.tree} could not be set up: \`${ready.command}\` failed (exit ${ready.exitCode}).\n\n${ready.output}`
  }

  // A run left mid-march has no builder out any more, and the reviewers no longer judge its whole branch: the person
  // sends it again, or is submitted again
  const was = resumed?.phase
  const phase: RunPhase = was === undefined ? 'ready' : restingPhase(was)
  // A review handed over again brings the comments that came since: those already taken up keep where they stand. An
  // errand taken up again is the one task it was
  const tasks =
    spec.kind === 'plan'
      ? undefined
      : spec.kind === 'errand' && resumed?.tasks !== undefined && resumed.tasks.length > 0
        ? resumed.tasks
        : [
            // A comment taken up already keeps where it stands, and gains the thread it was handed over without
            ...(resumed?.tasks ?? []).map(task => ({ ...task, ...(task.thread === undefined ? { thread: (spec.tasks ?? []).find(one => one.url !== undefined && one.url === task.url)?.thread } : {}) })),
            ...(spec.tasks ?? []).filter(task => !(resumed?.tasks ?? []).some(one => one.url !== undefined && one.url === task.url)),
          ].map((task, at) => ({ ...task, id: at + 1 }))
  const work = tasks === undefined ? made : { ...made, tasks }
  const quest: Run = {
    kind: spec.kind,
    ref: spec.ref,
    url: spec.url,
    title: spec.title,
    branch,
    base: placed.base,
    tree: placed.tree,
    ...(tasks !== undefined ? { tasks } : {}),
    isAuto: spec.isAuto,
    // Every task behind it, it has built; a review handed over again with new comments has more to build
    phase: isAllDone(work) ? (phase === 'ready' || phase === 'stuck' ? 'built' : phase) : phase === 'built' ? 'ready' : phase,
    current: resumed?.current ?? null,
    proof: resumed?.proof ?? '',
    proofLine: resumed?.proofLine ?? '',
    verdictLine: resumed?.verdictLine ?? '',
    testsToPass: resumed?.testsToPass ?? null,
    testsFor: resumed?.testsFor,
    commits: resumed?.commits ?? [],
    pr: resumed?.pr ?? spec.pr ?? '',
    gitRuns: resumed?.gitRuns ?? (await gitRunsOf(p.machine.shell(placed.tree))),
    ...(checks.length > 0 ? { checks } : {}),
    ...(setup.length > 0 ? { setup } : {}),
    at: resumed?.at ?? p.clock.now(),
  }

  await p.runs.put(quest, work)
  await p.board.show(spec.ref)
  await p.board.say(spec.ref, '')

  // A run taken up again first takes in what its base gained meanwhile: the tasks still to come are built on it
  const behind = resumed !== undefined ? await followBase(p, quest) : undefined

  if (behind !== undefined) {
    await p.runs.keep(spec.ref, was => ({ ...was, phase: 'stuck' }))
    await p.board.say(spec.ref, behind)

    return `The build takes up its run on ${spec.ref}, but stops: ${behind}`
  }

  if (quest.phase === 'ready') await p.board.want(spec.ref, 'next')
  if (quest.phase === 'built' && quest.isAuto && quest.kind !== 'review') await p.board.want(spec.ref, 'submit')

  const how =spec.isAuto ? 'going on by itself' : 'stopping after each commit for you'
  const where = placed.tree === (await p.machine.root()) ? 'in your own checkout, where its branch is' : `in its worktree ${placed.tree}`

  return resumed !== undefined
    ? `The build takes up its run on ${spec.ref} (${tally(work)}, ${quest.phase}) on ${branch}, ${where}, ${how}.`
    : `The build starts on ${spec.ref}, "${spec.title}", on ${branch} from ${placed.base}, ${where}, ${how}: the first task is sent.`
}

/** Sets out on the plan in force, or the one of the issue named. */
export async function setOut(p: Ports, isAuto: boolean, ref = ''): Promise<string> {
  const made = parsePlan(await p.parts.planFor(ref))

  if (made === null) return HOW_TO
  if (typeof made === 'string') return made

  const open = unsettledOf(made)

  // An auto run settles what the planner left open itself, and lists it; a risk to cover asks for a revision, which it does not make
  if (open.length > 0 && isAuto && !made.risks.some(risk => risk.wantsTask)) {
    const settled = parsePlan(await p.parts.settleAlone(made.ref))

    if (settled === null || typeof settled === 'string') return `The planner's work on ${made.ref} could not be settled by the run: ${settled ?? 'no plan is kept any more'}.`

    const said = await begin(p, { kind: 'plan', ref: settled.ref, url: settled.url, title: settled.title, branch: branchOf(settled), isAuto, checks: settled.verification ?? [], setup: settled.setup ?? [] }, settled)

    return `${said} It settled alone what the plan left open (${open.join('; ')}): the plan and the pull request list it under "Decided without the person".`
  }

  if (open.length > 0) return `The planner's work on ${made.ref} is not settled: ${open.join('; ')}. Settle them in the planner pane, then start the run${made.risks.some(risk => risk.wantsTask) ? '' : ', or start it auto to have it settle them alone'}.`

  return begin(p, { kind: 'plan', ref: made.ref, url: made.url, title: made.title, branch: branchOf(made), isAuto, checks: made.verification ?? [], setup: made.setup ?? [] }, made)
}

/**
 * Sets out on an issue as an errand: one task, the whole issue, read through the planner. One opened from outside the
 * repository is built only when the person asked for it themselves (`isPersons`): Claude's call may have been steered.
 */
export async function errand(p: Ports, input: string, isAuto: boolean, isPersons: boolean): Promise<string> {
  const issue = await p.parts.readIssue(input)

  if ('error' in issue) return issue.error
  if (issue.isOutside && !isPersons) return `${issue.ref} was opened by ${issue.author || 'someone'}, from outside the repository (or the forge could not say who can push to it): only the person starts on it, with /theseus build errand ${issue.ref} or from the issues pane (/theseus issues).`

  const task = errandTask(issue)
  const spec: Spec = { kind: 'errand', ref: issue.ref, url: issue.url ?? '', title: issue.title ?? '', branch: branchOf({ ref: issue.ref, title: issue.title ?? '' }), isAuto, tasks: [task], checks: verificationOf(issue.body ?? ''), setup: setupOf(issue.body ?? '') }

  return begin(p, spec, ownPlan(spec))
}

/** Sends a builder on a task: marked doing, chosen by the try and the task, and spawned in the run's worktree. */
export async function sendBuilder(p: Ports, held: Run, made: RunWork, task: RunTask, attempt: number, retry?: Retry): Promise<void> {
  const brief = briefFor({ quest: held, plan: made, task, attempt, targets: await p.parts.targetsKnown(), ...(retry !== undefined ? { retry } : {}), testsToPass: held.testsToPass, standards: await p.parts.standardsText() })
  const member = brief.builder
  const last = held.current
  // A task sent again keeps HEAD as it was when it was first sent: a commit made past the proof since stays one
  const head = last !== null && last.taskId === task.id && last.head !== undefined && last.head !== '' ? last.head : (await gitAt(p, ['rev-parse', 'HEAD'], held.tree)).out

  await mark(p, held, task.id, 'doing')

  const started = await p.agents.send({ builder: member, description: brief.description, prompt: brief.prompt, cwd: held.tree })
    .catch((error: unknown) => ({ deny: errorText(error), agentId: undefined }))

  if (started.deny !== undefined) {
    await p.runs.keep(held.ref, was => ({ ...was, phase: 'stuck', current: null }))
    await p.board.say(held.ref, `${BUILDERS[member].title} could not be sent on task ${task.id}: ${started.deny}`)

    return
  }

  if (started.agentId !== undefined && started.agentId !== '') await p.agents.remember(started.agentId, { role: 'builder', root: await p.machine.root(), tree: held.tree, files: [...task.files], ref: issueRefOf(held) })

  await p.runs.keep(held.ref, was => ({ ...was, phase: 'building', verdictLine: '', heldUntil: undefined, heldWhy: undefined, current: { taskId: task.id, title: task.title, builder: member, agentId: started.agentId ?? '', attempt, at: p.clock.now(), answer: '', head, isResumed: false } }))
  await p.board.say(held.ref, '')
}

/** What a run comes to once every task is behind it: built, and on an auto run that is no review, submitting. */
export async function arrive(p: Ports, held: Run): Promise<void> {
  await p.runs.keep(held.ref, was => ({ ...was, phase: 'built', current: null }))

  if (held.isAuto && held.kind !== 'review') await p.board.want(held.ref, 'submit')
  else await p.board.tell(`every task of ${held.ref} is behind it: ${held.kind === 'review' ? 'push the answers' : 'open the pull request'} from the pane`)
}

/** The lanes out on a run's tasks, beside one another. */
export async function lanesOf(p: Ports, ref: string): Promise<Run[]> {
  return (await p.runs.all()).filter(held => held.lane?.of === ref)
}

/**
 * Sends the next task, or finds the run built. A stuck task is sent again from its first rung, on what the tree
 * holds. A plan's tasks that can be built beside one another are each sent in a lane of its own, and the run's own
 * worktree waits for them to land; one task alone is built there.
 */
export async function sendNext(p: Ports, ref: string): Promise<void> {
  const held = await p.runs.at(ref)

  if (held === null || (held.phase !== 'ready' && held.phase !== 'stuck')) return

  const made = await workOf(p, held)

  if (typeof made === 'string') return p.board.say(ref, made)
  if (held.lane === undefined && isAllDone(made)) return arrive(p, held)

  // A task the run's own worktree has begun is finished there first
  if (held.kind === 'plan' && held.lane === undefined && held.current === null) {
    const lanes = await lanesOf(p, ref)
    const out = made.tasks.filter(task => lanes.some(lane => lane.lane?.taskId === task.id))
    const beside = besideOf(readyTasks(made, out.map(task => task.id)), out)

    if (lanes.length > 0 || beside.length > 1) {
      if (beside.length === 0) return p.board.say(ref, `Task${out.length === 1 ? '' : 's'} ${out.map(task => task.id).join(', ')} ${out.length === 1 ? 'is' : 'are'} out in a lane: what is left waits for ${out.length === 1 ? 'it' : 'them'} to land.`)

      for (const task of beside) await openLane(p, held, made, task)

      return p.board.say(ref, `Task${beside.length === 1 ? '' : 's'} ${beside.map(task => task.id).join(', ')} ${beside.length === 1 ? 'is' : 'are'} sent out, each in a lane of its own, built beside the others and landed on ${held.branch} once passed.`)
    }
  }

  // A lane builds its one task
  const task = held.lane !== undefined ? made.tasks.find(one => one.id === held.lane?.taskId) : nextTask(made)

  if (task === undefined) {
    await p.runs.keep(ref, was => ({ ...was, phase: 'stuck' }))
    await p.board.say(ref, `No task of ${ref} is ready: what is left depends on a task that is not done.`)

    return
  }

  // No task starts while the quota is past where the person set the run to stop spending
  const hold = holdOf(await p.clock.quota(), budgetIn(p))

  if (hold !== undefined) return holdFor(p, held, task, hold)

  // A plan's task that is not light is shown first in the tests written first: the test writer writes its tests, red, before anyone builds it
  if (held.kind === 'plan' && task.weight !== 'light' && held.testsFor !== task.id) return gazeOn(p, held, made, task)

  const last = held.current?.taskId === task.id ? held.current : null
  const retry: Retry | undefined = last === null || held.proof === '' ? undefined : { attempt: 1, by: BUILDERS[last.builder].title, answer: last.answer, proof: held.proof }

  await p.board.working(ref, `Sending a builder on task ${task.id}…`)
  await sendBuilder(p, held, made, task, 1, retry)
}

/**
 * Holds a run for the quota: past the 5-hour window's threshold it waits, and goes on by itself once the window has
 * reset; past the weekly window's, which is days from resetting, it stops for the person.
 */
async function holdFor(p: Ports, held: Run, task: RunTask, hold: { why: string; until?: number; isOver?: true }): Promise<void> {
  if (hold.isOver === true || hold.until === undefined) return stop(p, held, `Task ${task.id} does not start: ${hold.why}, days from resetting. Send it again once the quota has room, or raise the threshold in Theseus's options.`)

  await p.runs.keep(held.ref, was => ({ ...was, heldUntil: hold.until, heldWhy: hold.why }))
  await p.board.say(held.ref, `Task ${task.id} waits: ${hold.why}. The run goes on by itself at ${clockTime(hold.until)}.`)
}

/** Sends on each run held for the quota whose time has come: in this session, or in the next one opened in the repo. */
export async function wakeHeld(p: Ports): Promise<void> {
  const now = p.clock.now()

  for (const held of await p.runs.all()) {
    if (held.heldUntil === undefined || held.heldUntil > now || (held.phase !== 'ready' && held.phase !== 'stuck')) continue

    await p.runs.keep(held.ref, was => ({ ...was, heldUntil: undefined, heldWhy: undefined }))
    await p.board.want(held.ref, 'next')
  }
}

/**
 * Counts how full a builder's context is, from a step of its turn: past its budget it is stopped, its every next call
 * refused, and the task is the person's to split once its turn ends. A fresh builder would only fill another window.
 */
export async function measure(p: Ports, held: Run, agentId: string, tokens: number): Promise<void> {
  const out = held.current

  if (out === null || out.tooLarge !== undefined || held.phase !== 'building' || !isOverBudget(tokens, budgetIn(p))) return

  await p.runs.keep(held.ref, was => ({ ...was, current: was.current === null ? null : { ...was.current, tooLarge: tokens } }))
  await p.agents.stop(agentId, `This task has outgrown its context budget (${shareOf(tokens)}% of a context window) and is stopped.`)
  await p.board.say(held.ref, `${BUILDERS[out.builder].title} on task ${out.taskId} is stopped at ${shareOf(tokens)}% of a context window: the task is too large for one builder.`)
}

/** Opens a lane on a task of a run: its branch off the run's, in a worktree of its own, its task sent by the clock. */
export async function openLane(p: Ports, held: Run, made: RunWork, task: RunTask): Promise<void> {
  const ref = laneRefOf(held.ref, task.id)
  const branch = laneBranchOf(held.branch, task.id)
  const placed = await placeTree(p, branch, held.branch, false)

  if (typeof placed === 'string') return p.board.say(held.ref, `Task ${task.id} could not be sent out in a lane: ${placed}`)

  const lane: Run = {
    kind: 'plan',
    ref,
    url: held.url,
    title: task.title,
    branch,
    base: held.branch,
    tree: placed.tree,
    isAuto: held.isAuto,
    phase: 'ready',
    current: null,
    proof: '',
    proofLine: '',
    verdictLine: '',
    testsToPass: null,
    commits: [],
    pr: '',
    gitRuns: await gitRunsOf(p.machine.shell(placed.tree)),
    lane: { of: held.ref, taskId: task.id },
    at: p.clock.now(),
  }

  await p.runs.put(lane, made)
  await p.board.want(ref, 'next')
}

/** Has the test writer write a task's tests first, in the run's worktree. Where tests first does not answer, the task is built without them. */
export async function gazeOn(p: Ports, held: Run, made: RunWork, task: RunTask): Promise<void> {
  await p.board.working(held.ref, `The test writer writes the tests of task ${task.id}…`)

  const sent = await p.parts.writeTestsFor(purposeOf(held, made, task), issueRefOf(held), task.weight, held.tree).catch((error: unknown) => errorText(error))

  if (!/writes the tests/.test(sent)) {
    const after = await p.runs.keep(held.ref, was => ({ ...was, testsFor: task.id, testsToPass: null }))

    await p.board.say(held.ref, `The test writer did not answer (${sent.slice(0, 160)}): task ${task.id} is built without tests first.`)
    if (after !== null) await sendBuilder(p, after, made, task, 1)

    return
  }

  await p.runs.keep(held.ref, was => ({ ...was, phase: 'writing-tests', testsFor: task.id, testsToPass: null, current: null }))
}

/** Looks into the tests written first while the test writer gazes: once it has shown the tests, or that there are none, the task is built. */
export async function behold(p: Ports, ref: string): Promise<void> {
  const held = await p.runs.at(ref)

  if (held === null || held.phase !== 'writing-tests') return

  const shown: Seen = await p.parts.testsFirstIn(held.tree).catch((error: unknown) => ({ state: 'unreadable' as const, why: errorText(error).slice(0, 200) }))
  const step = afterGaze(shown, await workOf(p, held), held.testsFor, ref)

  if (step.kind === 'wait') return

  if (step.kind === 'lost') {
    await p.runs.keep(ref, was => ({ ...was, phase: 'stuck' }))
    await p.board.say(ref, step.why)

    return
  }

  if (step.kind === 'clouded') {
    await p.runs.keep(ref, was => ({ ...was, phase: 'stuck', testsFor: undefined }))
    await p.board.say(ref, step.why)
    await p.board.tell(`the tests written first of task ${step.task.id} of ${ref} could not be read`)

    return
  }

  const after = await p.runs.keep(ref, was => ({ ...was, phase: 'ready', testsToPass: step.testsToPass }))

  if (step.said !== '') await p.board.say(ref, step.said)
  await p.board.working(ref, `Sending a builder on task ${step.task.id}…`)
  if (after !== null) await sendBuilder(p, after, step.plan, step.task, 1)
}

/**
 * Sends the task up a rung after a try that did not pass, with what stopped it; or, when the last builder has tried it, stops
 * the run for the person.
 */
export async function again(p: Ports, ref: string, why: Why, line: string): Promise<void> {
  const held = await p.runs.at(ref)
  const out = held?.current

  if (held === null || out === null || out === undefined) return

  const made = await workOf(p, held)
  const task = typeof made === 'string' ? undefined : made.tasks.find(one => one.id === out.taskId)
  const next = afterFailedTry({ ...out, by: BUILDERS[out.builder].title }, typeof made === 'string' || task === undefined ? undefined : triesOf(made, task), line, held.tree)

  // A proof that does not settle the change, or findings that block it, send its builder back once, before a fresh
  // builder a rung up starts over cold
  if (next.isSentBack && (await p.agents.sendBack(out.agentId, out.builder, sendBackPrompt(why)))) {
    await p.runs.keep(ref, was => ({ ...was, phase: 'building', current: { ...out, isResumed: true, isRebased: false, answer: '' } }))
    await p.board.say(ref, `${BUILDERS[out.builder].title} is sent back to task ${out.taskId} with ${why.findings !== undefined ? 'the findings' : 'the proof'}: ${line}`)

    return
  }

  if (next.otherwise.kind === 'climb' && typeof made !== 'string' && task !== undefined) return sendBuilder(p, held, made, task, next.otherwise.attempt, { attempt: next.otherwise.attempt, by: BUILDERS[out.builder].title, answer: out.answer, ...why })
  if (next.otherwise.kind === 'stop') await stop(p, held, next.otherwise.why)
}

/**
 * Why the change in the tree cannot be taken as the task's: HEAD moved since the task was first sent, so a commit was
 * made past the proof and the reviewers. Nothing when it did not.
 */
export async function headMoved(p: Ports, held: Run): Promise<string | undefined> {
  const out = held.current

  if (out === null || out.head === undefined || out.head === '') return undefined

  const now = (await gitAt(p, ['rev-parse', 'HEAD'], held.tree)).out

  return now === out.head
    ? undefined
    : `HEAD moved from ${out.head.slice(0, 7)} to ${now.slice(0, 7)} while task ${out.taskId} was out: a commit was made past the proof and its reviewers. Put it back as uncommitted work (git reset --soft ${out.head.slice(0, 7)} in ${held.tree}), then put it up for verification again.`
}

/** Stops a run for the person, saying why. */
export async function stop(p: Ports, held: Run, why: string): Promise<void> {
  await p.runs.keep(held.ref, was => ({ ...was, phase: 'stuck' }))
  await p.board.say(held.ref, why)
  await p.board.tell(`${held.ref} is stuck: ${why.split('\n')[0] ?? why}`)
}

// One proof at a time: lanes build beside one another, but a service's proof plays against one database kept warm
const oneProof = inTurn()

/**
 * The proof of a run's change: verify's, of the targets the project names; where it names none, the run's
 * verification commands, run in its worktree.
 */
async function proofOf(p: Ports, held: Run, written: readonly { file: string; name: string }[]): Promise<unknown> {
  if ((await p.parts.targetsKnown()).length > 0) return p.parts.proveFor(held.tree, written)

  const checks = held.checks ?? []

  if (checks.length === 0) return { verdict: 'unlooked', line: 'Verify knows no target here, and the run states no verification command' }

  return checksVerdict(await runCommands(p.machine.shell(held.tree), checks), checks)
}

/** Why a run is not started where nothing could prove its tasks. */
const noProofFor = (spec: Spec): string =>
  [
    `${spec.ref} is not started: the project names no target in .claude/theseus.toml, and ${spec.kind === 'plan' ? 'its plan states' : 'the issue states'} no verification command, so nothing could prove its tasks.`,
    spec.kind === 'plan'
      ? 'Have the planner plan it again: it names the commands that check the change (its tests, its linter). Or name what the project builds in .claude/theseus.toml (/theseus init proposes it).'
      : 'Add a `## Verification` section to the issue, a command a line (its tests, its linter), and `## Setup` for what a fresh worktree needs. Or name what the project builds in .claude/theseus.toml (/theseus init proposes it).',
  ].join(' ')

/** What a builder's answer left unticked: each `- [ ]` item of a checklist it wrote. */
const untickedOf = (answer: string): string[] =>
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

  await p.board.working(ref, `Verify proves task ${out.taskId}…`)

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

  await p.board.working(ref, `The reviewers are sent to judge task ${out.taskId}…`)

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

/**
 * The minor findings of a judgement that are about what the change in a tree wrote. Where git cannot say what it wrote,
 * every one is, as none can be told apart.
 */
export async function ownMinorIn(p: Ports, tree: string, judged: Judged): Promise<string[]> {
  const tracked = await gitAt(p, ['diff', 'HEAD', '--name-only', ...UNMODDED], tree)
  const fresh = await gitAt(p, ['ls-files', '-o', '--exclude-standard', ...UNMODDED], tree)

  if (!tracked.ok || !fresh.ok) return judged.minor

  return ownMinor(judged.minorAt, tree, `${tracked.out}\n${fresh.out}`.split('\n').map(one => one.trim()).filter(one => one !== ''))
}

/** Looks at the reviewers' judgement of a run's change, while they review. */
export async function judge(p: Ports, ref: string): Promise<void> {
  const held = await p.runs.at(ref)

  if (held === null || held.phase !== 'reviewing') return

  await settle(p, ref, parseJudgement(await p.parts.judgementFor(held.tree).catch((error: unknown) => errorText(error))))
}

/** What the reviewers' verdict comes to: committed when they pass the change, sent back up a rung when they find what blocks it. */
export async function settle(p: Ports, ref: string, judged: ReturnType<typeof parseJudgement>): Promise<void> {
  const held = await p.runs.keep(ref, was => (was.phase === 'reviewing' ? { ...was, verdictLine: judged.line } : was))

  if (held === null || held.phase !== 'reviewing' || held.current === null) return

  const out = held.current

  // Minor findings of a pass about what the change wrote send its builder back once to tidy them; those of the judgement
  // after, and those about files it left alone, are committed as they are, and a builder that cannot be reached spends no
  // try on them
  const step = afterVerdict(judged, out, isTidyAsked(judged, out) ? await ownMinorIn(p, held.tree, judged) : [])

  if (step.kind === 'wait') return
  if (step.kind === 'tidy') {
    if (await p.agents.sendBack(out.agentId, out.builder, tidyPrompt(step.minor))) {
      await p.runs.keep(ref, was => ({ ...was, phase: 'building', current: { ...out, isTidied: true, answer: '' } }))
      await p.board.say(ref, `${BUILDERS[out.builder].title} is sent back to task ${out.taskId} to tidy the minor findings: ${judged.line}`)

      return
    }

    return void (await commitNow(p, ref, step.otherwise.minor))
  }
  if (step.kind === 'commit') return void (await commitNow(p, ref, step.minor))
  if (step.kind === 'again') return again(p, ref, step.why, step.line)

  // The change moved while they sat, or they never reviewed it: it is proved and judged afresh
  if (step.kind === 'prove') {
    await p.runs.keep(ref, was => ({ ...was, phase: 'proving' }))
    await p.board.want(ref, 'prove')

    return
  }

  if (step.kind === 'stop') await stop(p, held, step.why)
}

/** Commits the change the reviewers passed as the task's own, and goes on. Answers what was done, in a sentence. */
export async function commitNow(p: Ports, ref: string, minor: readonly string[]): Promise<string> {
  const held = await p.runs.at(ref)

  if (held === null || held.current === null) return 'There is nothing to commit.'

  const out = held.current
  const made = await workOf(p, held)
  const task = typeof made === 'string' ? undefined : made.tasks.find(one => one.id === out.taskId)

  if (task === undefined || typeof made === 'string') {
    await p.runs.keep(ref, was => ({ ...was, phase: 'stuck' }))

    return `Task ${out.taskId} is not in the work of ${ref} any more: ${typeof made === 'string' ? made : 'started again.'}`
  }

  // The reviewers judged the change against HEAD as it was sent: a commit made since was judged by no one
  const moved = await headMoved(p, held)

  if (moved !== undefined) {
    await stop(p, held, moved)

    return moved
  }

  await p.board.working(ref, `Committing task ${task.id}…`)

  const by = BUILDERS[out.builder].title
  const unproven = held.unproven ?? []
  // What the mods keep in the tree (the recorder's builds, verify's trees) is none of the change
  const committed = await commitTask(p.machine.shell(held.tree), { tree: held.tree, taskId: task.id, message: commitMessage({ ...held, ref: issueRefOf(held) }, made, task, by, minor, unproven), gitRuns: held.gitRuns })

  // An errand is the whole issue in one change: none at all means it was built somewhere else, or not at all
  if (committed.kind === 'clean' && held.kind === 'errand') {
    const why = `${by} left no change in ${held.tree} for ${ref}: it is not done. Look at what it says it built, then send it again.`

    await stop(p, held, why)

    return why
  }

  if (committed.kind === 'refused') {
    await stop(p, held, committed.why)

    return committed.why
  }

  // A task that needed no change is done with no commit
  const sha = committed.kind === 'committed' ? committed.sha : ''
  // What the pull request says of the task: how long it took, what it changed beyond its files, what its builder left undone
  const written = sha === '' ? [] : (await gitAt(p, ['show', '--name-only', '--format=', sha], held.tree)).out.split('\n').map(one => one.trim()).filter(one => one !== '')
  const outside = written.filter(file => !task.files.includes(file))
  const unticked = untickedOf(out.answer)
  const told = { took: Math.max(p.clock.now() - out.at, 0), ...(outside.length > 0 ? { outside } : {}), ...(unticked.length > 0 ? { unticked } : {}) }

  // A lane's commit is its run's once it lands on the run's branch
  if (held.lane !== undefined) return land(p, ref, { taskId: task.id, title: task.title, sha, by, minor: [...minor], unproven: [...unproven], answer: out.answer, proof: held.proofLine, ...told, ...(out.isPutBefore === true ? { isPutBefore: true } : {}) })

  await mark(p, held, task.id, 'done')

  const after = await p.runs.keep(ref, was => ({ ...was, phase: 'ready', current: null, testsToPass: null, proof: '', proofLine: '', verdictLine: '', unproven: [], isBranchReviewed: false, commits: [...was.commits, { taskId: task.id, title: task.title, sha, by, ...told, minor: [...minor], unproven: [...unproven], answer: out.answer, proof: was.proofLine, ...(out.isPutBefore === true ? { isPutBefore: true } : {}) }] }))
  const left = after === null ? made : await workOf(p, after)
  const isArrived = typeof left !== 'string' && isAllDone(left)
  const said = `Task ${task.id} of ${ref}, "${task.title}", built by ${by}, passed verification and is committed${sha === '' ? ' (it changed nothing, so it is marked done with no commit)' : ` as ${sha.slice(0, 7)}`}.`

  if (isArrived || after?.isAuto === true) await p.board.want(ref, 'next')
  else await p.board.tell(`${said} The next task waits for you.`)

  return said
}

// One landing at a time: each lane lands on its run's branch as the one before left it
const oneLanding = inTurn()

/**
 * Lands a lane's commit on its run's branch: as it is, where nothing landed there since the lane started; else taken
 * onto what landed, and proved there again before it lands, or, where it no longer applies, sent back to its builder to
 * resolve. Once the run's branch holds it, its task is done, and the lane is cleared. Answers what was done.
 */
export function land(p: Ports, ref: string, commit: RunCommit): Promise<string> {
  return oneLanding(() => landNow(p, ref, commit))
}

export async function landNow(p: Ports, ref: string, commit: RunCommit): Promise<string> {
  const held = await p.runs.at(ref)
  const quest = held?.lane === undefined ? null : await p.runs.at(held.lane.of)

  if (held === null || held.current === null) return 'There is nothing to land.'

  if (quest === null) {
    const why = `The run ${issueRefOf(held)} this lane builds for is under way no more: abandon the lane.`

    await stop(p, held, why)

    return why
  }

  const landing = await landLane(p.machine.shell(held.tree), p.machine.shell(quest.tree), { taskId: commit.taskId, sha: commit.sha, branch: quest.branch, laneTree: held.tree, questTree: quest.tree })

  if (landing.kind === 'stop') {
    await stop(p, held, landing.why)

    return landing.why
  }
  if (landing.kind === 'conflicts') return conflicted(p, held, quest, landing.onto, commit)
  if (landing.kind === 'rebased') return reproved(p, held, quest, landing.onto, commit)

  const landed = { ...commit, sha: landing.sha }

  await mark(p, quest, commit.taskId, 'done')

  const after = await p.runs.keep(quest.ref, was => ({ ...was, isBranchReviewed: false, commits: [...was.commits, landed] }))
  const left = after === null ? null : await workOf(p, after)
  const uncleared = await clearLane(p, held)
  const said = `Task ${commit.taskId} of ${quest.ref}, "${commit.title}", built by ${commit.by} in a lane, passed verification and landed on ${quest.branch}${landed.sha === '' ? ' (it changed nothing, so it is marked done with no commit)' : ` as ${landed.sha.slice(0, 7)}`}.${uncleared}`

  await p.board.say(quest.ref, said)
  if ((left !== null && typeof left !== 'string' && isAllDone(left)) || quest.isAuto) await p.board.want(quest.ref, 'next')
  else await p.board.tell(`${said} The next task waits for you.`)

  return said
}

/**
 * Where a lane's change no longer applies on its run's branch: the lane is put on that branch as it stands, the change
 * applied on it with git's conflict markers where the two meet, and its builder sent back to resolve them; where it
 * cannot be reached, the lane stops for the person. Answers what was done.
 */
export async function conflicted(p: Ports, held: Run, quest: Run, onto: string, commit: RunCommit): Promise<string> {
  const sha = commit.sha
  const applied = await applyAfresh(p.machine.shell(held.tree), onto, sha)
  const out = held.current

  if (out === null) return 'There is nothing to land.'

  const after = await p.runs.keep(held.ref, was => ({ ...was, proof: '', proofLine: '', verdictLine: '', current: { ...out, head: onto, isRebased: false, answer: '' } }))

  if (after === null) return 'There is nothing to land.'

  if (applied.kind === 'applies') return reproved(p, held, quest, onto, commit)

  if (applied.kind === 'failed') {
    const why = `Task ${out.taskId} could not be taken onto ${quest.branch}, which moved while it was built: ${applied.why}. Its change is ${sha.slice(0, 7)}: apply it in ${held.tree} by hand, then put it up for verification.`

    await stop(p, after, why)

    return why
  }

  const files = applied.files

  if (await p.agents.sendBack(out.agentId, out.builder, conflictPrompt(quest.branch, files))) {
    await p.runs.keep(held.ref, was => ({ ...was, phase: 'building', current: was.current === null ? null : { ...was.current, isResumed: true } }))

    const said = `Task ${out.taskId} conflicts with what landed on ${quest.branch} (${files.join(', ')}): ${BUILDERS[out.builder].title} is sent back to resolve it.`

    await p.board.say(held.ref, said)

    return said
  }

  const why = `Task ${out.taskId} conflicts with what landed on ${quest.branch} (${files.join(', ')}), and ${BUILDERS[out.builder].title} could not be sent back: its change is in ${held.tree} with git's conflict markers. Resolve them there, then put it up for verification.`

  await stop(p, after, why)

  return why
}

/** A lane's change standing uncommitted on what landed on its run's branch: proved there again, and landed as it passed. */
export async function reproved(p: Ports, held: Run, quest: Run, onto: string, commit: RunCommit): Promise<string> {
  const out = held.current

  if (out === null) return 'There is nothing to land.'

  await p.runs.keep(held.ref, was => ({ ...was, phase: 'proving', proof: '', proofLine: '', current: { ...out, head: onto, isRebased: true, minor: commit.minor } }))
  await p.board.want(held.ref, 'prove')

  const said = `${quest.branch} moved while task ${commit.taskId} was built: its change is taken onto it, and proved there again before it lands.`

  await p.board.say(held.ref, said)

  return said
}

/** Clears a lane once it landed: its worktree removed, its branch deleted, and the lane forgotten. Says what could not be cleared. */
export async function clearLane(p: Ports, held: Run): Promise<string> {
  const root = await p.machine.root()
  // What is left in it is what the mods kept there (the recorder's runs, verify's trees): its change is landed
  const left = (await gitAt(p, ['status', '--porcelain', ...UNMODDED], held.tree)).out
  const removed = left === '' ? await p.machine.removeTree(root, held.tree) : { ok: false, out: `it holds changes that did not land (${left.split('\n')[0] ?? ''})` }
  const deleted = removed.ok ? await gitAt(p, ['branch', '-D', held.branch], root) : { ok: true, out: '' }

  await p.runs.drop(held.ref)
  await p.board.forget(held.ref)

  return removed.ok && deleted.ok ? '' : ` Its lane is not cleared: ${removed.ok ? `${held.branch} could not be deleted: ${deleted.out}` : `${held.tree} is left: ${removed.out}`}.`
}

/** Puts a stuck task's change up for verification again: proved, judged, and committed once the reviewers pass it. */
export async function resubmit(p: Ports, ref: string): Promise<string> {
  const held = await p.runs.at(ref)

  if (held === null) return HOW_TO
  if (held.current === null || held.phase !== 'stuck') return `There is nothing to put up for verification: the run on ${ref} is ${held.phase}.`

  // The person puts it there having looked: git's config as it now stands is theirs
  const gitRuns = await gitRunsOf(p.machine.shell(held.tree))

  await p.runs.keep(ref, was => ({ ...was, phase: 'proving', gitRuns, current: was.current === null ? null : { ...was.current, isPutBefore: true } }))
  await p.board.want(ref, 'prove')

  return `Task ${held.current.taskId}'s change goes up for verification: it is proved, judged by the reviewers, and committed once they pass it.`
}

/** What a run that is out waits on before it may be abandoned; nothing when it waits on nothing. */
export const waitBeforeAbandon = (held: Run): string | undefined =>
  OUT.includes(held.phase)
    ? `The run on ${held.ref} is ${held.phase}: wait until ${held.phase === 'writing-tests' ? 'the test writer has shown the tests' : held.phase === 'reviewing' || held.phase === 'reviewing-branch' ? 'the reviewers have judged' : held.phase === 'proving' ? 'the proof is made' : `${held.current === null ? 'the builder' : BUILDERS[held.current.builder].title} is back`}, then abandon it.`
    : undefined

/** A worktree of the run's own, not the person's checkout; nothing for a run built where the person works. */
const ownTreeOf = (held: Run, root: string): string | undefined => (held.tree !== undefined && held.tree !== '' && held.tree !== root ? held.tree : undefined)

/**
 * Why a run may not be abandoned yet: it, or a lane of it, is out, or a worktree of theirs holds work that is the
 * person's to keep or drop first. Nothing when it may: what the command says at once, before the clock gives it up.
 */
export async function abandonRefusal(p: Ports, held: Run): Promise<string | undefined> {
  const lanes = held.lane === undefined ? await lanesOf(p, held.ref) : []
  const waiting = [held, ...lanes].map(waitBeforeAbandon).find(one => one !== undefined)

  if (waiting !== undefined) return waiting

  const root = await p.machine.root()

  for (const one of [...lanes, held]) {
    const tree = ownTreeOf(one, root)

    if (tree !== undefined && (await gitAt(p, ['status', '--porcelain'], tree)).out !== '') return `${tree} holds uncommitted changes: commit, stash or drop them there, then abandon the run.`
  }

  return undefined
}

/**
 * Gives a run up: its worktree removed, its own branch deleted (a review's is the pull request's, and is left), a
 * plan's tasks reopened in the planner, and the run forgotten here and across sessions. Nothing on the forge is touched.
 */
export async function abandon(p: Ports, ref: string): Promise<string> {
  const held = (await p.runs.at(ref)) ?? (await p.runs.stored(ref)) ?? null

  if (held === null) return `No run on ${ref} is kept: there is nothing to abandon.`

  const lanes = held.lane === undefined ? await lanesOf(p, ref) : []
  const refused = await abandonRefusal(p, held)

  if (refused !== undefined) return refused

  // Its lanes are given up first: each is a task of it, in a worktree of its own
  for (const lane of lanes) {
    const said = await abandon(p, lane.ref)

    if ((await p.runs.at(lane.ref)) !== null) return `The run on ${ref} is not abandoned, as its lane on task ${lane.lane?.taskId ?? ''} is not: ${said}`
  }

  const root = await p.machine.root()
  const isOwnTree = ownTreeOf(held, root) !== undefined
  const said: string[] = [`The run on ${ref} is abandoned.`]

  if (isOwnTree) {
    const removed = await gitAt(p, ['worktree', 'remove', held.tree], root)

    if (!removed.ok) return `The worktree ${held.tree} could not be removed: ${removed.out}`
    said.push(`Its worktree is removed.`)
  }

  if (held.kind !== 'review' && isOwnTree) {
    const exists = await gitAt(p, ['rev-parse', '--verify', '--quiet', `refs/heads/${held.branch}`], root)
    const deleted = exists.ok ? await gitAt(p, ['branch', '-D', held.branch], root) : { ok: true, out: '' }

    said.push(deleted.ok ? (exists.ok ? `${held.branch} is deleted, with its ${held.commits.length} ${held.commits.length === 1 ? 'commit' : 'commits'}.` : `${held.branch} was already gone.`) : `${held.branch} could not be deleted: ${deleted.out}.`)
  } else if (held.commits.length > 0) said.push(`${held.branch} is left as it is, with its ${held.commits.length} ${held.commits.length === 1 ? 'commit' : 'commits'}.`)

  // The tasks a plan's run took up are open again in the plan, which can be started on as it is; a lane's one task alone
  if (held.kind === 'plan') {
    const made = await workOf(p, held)
    const reopened = typeof made === 'string' ? [] : made.tasks.filter(task => task.state !== 'todo' && (held.lane === undefined || task.id === held.lane.taskId))

    for (const task of reopened) await p.parts.markTask(task.id, 'todo', issueRefOf(held))
    if (reopened.length > 0) said.push(`${reopened.length} ${reopened.length === 1 ? 'task is' : 'tasks are'} open again in the plan.`)
  }

  if (held.pr !== '' && held.kind !== 'review') said.push(`Its pull request, ${held.pr}, is left as it is on the forge.`)

  await p.runs.drop(ref)
  await p.board.unwant(ref)
  await p.board.forget(ref)

  return said.join(' ')
}

/**
 * A commit as its branch holds it: the one recorded, while the branch holds it, else, where it was rewritten since (an
 * amended commit lives on outside its branch), the one that names its comment.
 */
export async function landedSha(p: Ports, tree: string, sha: string, task: RunTask): Promise<string> {
  if (sha !== '' && (await gitAt(p, ['merge-base', '--is-ancestor', sha, 'HEAD'], tree)).ok) return sha
  if (task.url === undefined || task.url === '') return sha

  const found = (await gitAt(p, ['log', '-n', '1', '--format=%H', '--fixed-strings', `--grep=${task.url}`], tree)).out.split('\n')[0] ?? ''

  return found !== '' ? found : sha
}

/** The last line a forge's command said of its failure. */
export const lastLineOf = (ran: Ran): string => (ran.stderr || ran.stdout).trim().split('\n').slice(-1)[0] ?? ''

/**
 * Answers each review thread whose comment the run took up, once its answers are pushed: one built is told its commit
 * and resolved; one handed back is told why, and left open for the person. A thread is answered once. Says what was done.
 */
export async function answerThreads(p: Ports, ref: string): Promise<string> {
  const held = await p.runs.at(ref)
  const number = Number(/#(\d+)$/.exec(ref)?.[1] ?? NaN)

  if (held === null || !Number.isFinite(number)) return ''

  const forge = p.machine.forge(forgeOfUrl(held.pr !== '' ? held.pr : held.url), held.tree)
  let answered = 0
  let resolved = 0
  const failed: string[] = []

  for (const task of (held.tasks ?? []).filter(one => one.thread !== undefined && one.thread !== '' && one.isAnswered !== true)) {
    const commit = held.commits.find(one => one.taskId === task.id && one.sha !== '')
    const reply = commit !== undefined ? `Answered in ${(await landedSha(p, held.tree, commit.sha, task)).slice(0, 7)} by ${commit.by}.` : task.state === 'asked' ? `Handed back to the author: ${task.note ?? ''}` : undefined

    if (reply === undefined) continue

    const replied = await forge.replyToThread(number, task.thread ?? '', reply)

    // A thread left unanswered is said, and tried again at the next push
    if (replied.exitCode !== 0) {
      failed.push(`task ${task.id} (${lastLineOf(replied) || 'the forge said nothing'})`)
      continue
    }

    answered += 1
    if (commit !== undefined) {
      const done = await forge.resolveThread(number, task.thread ?? '')

      if (done.exitCode === 0) resolved += 1
      else failed.push(`task ${task.id}'s thread is answered but not resolved (${lastLineOf(done) || 'the forge said nothing'})`)
    }
    await p.runs.keep(ref, was => ({ ...was, tasks: (was.tasks ?? []).map(one => (one.id === task.id ? { ...one, isAnswered: true } : one)) }))
  }

  return [
    answered === 0 ? '' : ` ${answered} ${answered === 1 ? 'thread is' : 'threads are'} answered on the pull request, ${resolved} resolved.`,
    failed.length === 0 ? '' : ` Not answered on the forge: ${failed.join('; ')}.`,
  ].join('')
}

/** Pushes the branch and opens the pull request that closes the issue; a review's answers are pushed onto its pull request. */
export async function sail(p: Ports, ref: string): Promise<string> {
  const held = await p.runs.at(ref)

  if (held === null) return HOW_TO
  const unready = whyNotSail(held)

  if (unready !== undefined) return unready

  const made = await workOf(p, held)

  if (typeof made === 'string') return made

  // Nothing that looks like a secret leaves the machine, whoever committed it
  const leak = await leakOf(p.machine.shell(held.tree), held)

  if (leak !== undefined) {
    await p.board.say(ref, leak)

    return leak
  }

  if (held.kind === 'review') {
    await p.board.working(ref, `Pushing ${held.branch}…`)

    const pushed = await pushAt(p, held.branch, held.tree)

    if (!pushed.ok) return `${held.branch} could not be pushed: it may be behind its remote. ${pushed.out.split('\n').slice(-1)[0] ?? ''}`

    await p.runs.keep(ref, was => ({ ...was, phase: was.phase === 'built' ? 'submitted' : was.phase }))

    const told = await answerThreads(p, ref)

    return `${held.branch} is pushed: ${held.commits.length} answered ${held.commits.length === 1 ? 'comment is' : 'comments are'} on ${held.pr}.${told}`
  }

  // What the base gained since is taken in before the branch is judged whole and leaves the machine, so its pull request
  // does not open in conflict. A conflict leaves the run built: once it is merged by hand, it is submitted again
  if (held.isBranchReviewed !== true) {
    const behind = await followBase(p, held)

    if (behind !== undefined) return behind
  }

  // Each task of a plan was judged alone: both reviewers judge what the tasks do and let in together, once, before the
  // branch leaves the machine
  if (held.kind === 'plan' && held.isBranchReviewed !== true) {
    // The branch took in origin's base, just fetched: judged against a local base behind it, the reviewers would judge
    // the commits it took in as the branch's own
    const upstream = (await gitAt(p, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${held.base}`], held.tree)).ok ? `origin/${held.base}` : held.base
    const model = wardModelFor(made, held.commits)
    const judged = parseJudgement(await p.parts.judgementFor(held.tree, { start: true, reviewers: ['reviewer-correctness', 'reviewer-security'], against: upstream, about: wardPurpose(made), ref, ...(model !== undefined ? { model } : {}) }).catch((error: unknown) => errorText(error)))

    await p.runs.keep(ref, was => ({ ...was, phase: 'reviewing-branch', verdictLine: judged.line }))

    return ward(p, ref, judged)
  }

  await p.board.working(ref, `Pushing ${held.branch} and opening the pull request…`)

  // What the run spent is a line of the pull request's body, never a reason to open none
  const { forge, request } = requestOf(held, made, await p.parts.spentOn(held).catch(() => ''))
  const opened = await openAt(p, forge, request, held.tree)

  if (typeof opened !== 'object') return opened

  const url = opened.url

  await p.runs.keep(ref, was => ({ ...was, phase: 'submitted', pr: url }))
  await p.board.tell(`the pull request for ${ref} is open${url === '' ? '' : `: ${url}`}`)

  return `The run is submitted: ${held.branch} is pushed and the pull request that closes ${ref} is open${url === '' ? '' : ` at ${url}`}.`
}

/**
 * What the reviewers' judgement of a plan's whole branch comes to: it is submitted once they pass it; what they find blocking,
 * or a reviewer's silence, stops it for the person. Answers what was done, in a sentence.
 */
export async function ward(p: Ports, ref: string, judged: ReturnType<typeof parseJudgement>): Promise<string> {
  const held = await p.runs.at(ref)

  if (held === null || held.phase !== 'reviewing-branch') return ''
  const step = afterWard(judged, held)

  if (step.kind === 'wait') return step.said

  if (step.kind === 'submit') {
    await p.runs.keep(ref, was => ({ ...was, phase: 'built', isBranchReviewed: true, verdictLine: step.line }))

    return sail(p, ref)
  }

  await p.runs.keep(ref, was => ({ ...was, phase: 'built', isBranchReviewed: false, verdictLine: step.line }))
  await p.board.say(ref, step.why)
  await p.board.tell(step.why.split('\n')[0] ?? step.why)

  return step.why
}

/** Looks at the reviewers' judgement of a plan's whole branch, while they review. */
export async function watchWard(p: Ports, ref: string): Promise<void> {
  const held = await p.runs.at(ref)

  if (held === null) return

  const said = await ward(p, ref, parseJudgement(await p.parts.judgementFor(held.tree).catch((error: unknown) => errorText(error))))

  if (said !== '' && !said.startsWith(WARDING)) await p.board.say(ref, said)
}

/** A builder's turn has ended: what it built is proven, outside the hook; a task it hands back goes to the person. */
export async function builderEnded(p: Ports, held: Run, e: BuilderTurn): Promise<void> {
  if (held.current === null) return

  const out = { ...held.current, answer: e.answer ?? '' }
  const title = BUILDERS[out.builder].title

  // Stopped for its size: another builder would only fill another window, so the task is the person's to split
  if (out.tooLarge !== undefined) {
    await p.runs.keep(held.ref, was => ({ ...was, current: out }))

    return stop(p, held, `Task ${out.taskId} was stopped at ${shareOf(out.tooLarge)}% of a context window: it is too large for one builder. Split it ${held.kind === 'plan' ? 'in the plan (the planner pane)' : 'into smaller issues'}, then send it again; what the builder left is in ${held.tree}.`)
  }
  const handed = e.isAborted || e.reason !== 'answer' ? undefined : handBackOf(out.answer)

  if (e.isAborted || e.reason !== 'answer') {
    await p.runs.keep(held.ref, was => ({ ...was, phase: 'stuck', current: out }))
    await p.board.say(held.ref, `${title} on task ${out.taskId} ${e.isAborted ? 'was interrupted' : e.reason === 'refusal' ? 'refused' : 'ended on an API error'}: send it again from the pane.`)
  } else if (handed !== undefined && held.kind === 'review') {
    // A comment that asks something only the person can answer is theirs, and the run goes on to the next
    const isClean = (await gitAt(p, ['status', '--porcelain', ...UNMODDED], held.tree)).out === ''

    await p.runs.keep(held.ref, was => ({ ...was, phase: isClean ? 'ready' : 'stuck', current: isClean ? null : out }))
    await mark(p, held, out.taskId, isClean ? 'asked' : 'doing', handed)
    if (isClean) await p.board.want(held.ref, 'next')
    else await p.board.say(held.ref, `${title} hands the comment back (${handed}), but left changes in ${held.tree}: drop them, or commit them from the pane.`)
  } else if (handed !== undefined) {
    await p.runs.keep(held.ref, was => ({ ...was, phase: 'stuck', current: out }))
    await p.board.say(held.ref, held.kind === 'errand' ? `${title} hands ${held.ref} back: it is no errand. ${handed} Abandon it, then plan it with /theseus plan ${held.ref}.` : `${title} stops on task ${out.taskId}: the plan must be revised. ${handed} Revise it in the planner pane, then send the task again.`)
    await p.board.tell(`${title} hands ${held.ref} back: ${handed}`)
  } else {
    await p.runs.keep(held.ref, was => ({ ...was, phase: 'proving', current: out }))
    await p.board.want(held.ref, 'prove')
  }
}