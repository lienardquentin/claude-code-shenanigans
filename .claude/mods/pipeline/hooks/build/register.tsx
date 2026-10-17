import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, TurnUsage } from 'claude-code'

import type { SentAgent, SpentTurn, RunCommit, RunKind, RunPhase, RunWork, Run, RunTask, RunTaskState, RunAsk } from '../../types'
import {
  HOW_TO,
  MARK,
  BUILDERS,
  besideOf,
  branchOf,
  commitMessage,
  conflictPrompt,
  errandTask,
  handBackOf,
  isAllDone,
  issueRefOf,
  laneBranchOf,
  laneRefOf,
  nextTask,
  ownMinor,
  ownPlan,
  parsePlan,
  parseWorktrees,
  purposeOf,
  runLine,
  runText,
  readyTasks,
  requestOf,
  reviewTasks,
  spentOn,
  reviewerModelFor,
  tally,
  triesOf,
  unsettledOf,
  wardModelFor,
  wardPurpose,
} from '../../core/run'
import type { Retry } from '../../core/run'
import { canMove, restingPhase } from './phases'
import { forgeOfUrl } from '../../core/forge'
import type { Ran } from '../../core/forge'
import { UNMODDED, secretsIn } from '../../core/change'
import { applyAfresh, commitTask, gitRunsOf, landLane, leakOf } from '../../core/git'
import { WARDING, afterFailedTry, afterGaze, afterProof, afterVerdict, afterWard, briefFor, isTidyAsked, parseJudgement, proofVerdict, runFromStore, sendBackPrompt, tidyPrompt, whyNotSail } from '../../core/run'
import type { Judged, Seen, Why } from '../../core/run'
import { errorText, forgeIn, git, gitRootOf, inTurn, removeTree, isMergedFrom, openRequest, push, rootOf, run, sendBack, shellIn, toolFailed, treePathOf } from '../flow'
import type { Section, TurnEnded } from '../flow'
import { badge } from '../kit/badge'
import type { Tone } from '../kit/badge'
import { paneView } from '../kit/pane-text'
import { clip, clockOf, homePath, keyed, shortRef } from '../look'
import { askToPump, inFrame, remember, spawnIn, typeOf } from '../agents'
import { SPEND_FILE, costLine, costText, record, spendOf, spends } from '../spend'
import { markTask, planFor, readIssue, takeSetOut } from '../planner/register'
import { writeTestsFor, testsFirstIn } from '../tests-first/register'
import { judgementFor, proveFor, standardsText, targetsKnown } from '../verify/register'

type $ = EngineInterface
type On = Parameters<Register>[0]

const PANE = 'build'
const TITLE = 'Build'
// How often the clock looks for what a press, a command or a turn asked for
const TICK_MS = 500
// What is said while the reviewers judge a plan's whole branch
// Where a run is kept across sessions, by its ref
const STORE_KEY = (ref: string) => `run:${ref}`
// How long the forge is given to answer a fetch
const FETCH_TIMEOUT_MS = 120_000

const quests = atom({ plugin: 'pipeline', key: 'buildRuns' } as const, {} as Record<string, Run>)
const plans = atom({ plugin: 'pipeline', key: 'buildWork' } as const, {} as Record<string, RunWork>)
const notes = atom({ plugin: 'pipeline', key: 'buildNotes' } as const, {} as Record<string, string>)
const working = atom({ plugin: 'pipeline', key: 'buildWorking' } as const, {} as Record<string, string>)
const wanted = atom({ plugin: 'pipeline', key: 'buildWanted' } as const, [] as { ref: string; what: RunAsk; arg?: string }[])
const selected = atom({ plugin: 'pipeline', key: 'buildSelected' } as const, '')
const spent = atom({ plugin: 'pipeline', key: 'buildSpent' } as const, {} as Record<string, string>)

export const buildView = paneView({ id: PANE, title: TITLE, command: '/build' })
const view = buildView

// The project's folder, by the session's: the pane draws often, and git is asked once a folder. Where git could not
// say, the session's folder stands in, and git is asked again at the next drawing
const roots = new Map<string, string>()

async function paneRoot($: $): Promise<string> {
  const cwd = await $.session.cwd()
  const known = roots.get(cwd)

  if (known !== undefined) return known

  const found = await gitRootOf($)

  if (found === undefined) return cwd.replace(/\/+$/, '')

  roots.set(cwd, found)

  return found
}

const REF = { type: 'string', description: 'The run, by its ref; the one the pane shows when left out.' } as const

const TOOLS = [
  {
    name: 'start_run',
    description:
      "Implements the plan in force (or resumes it) in a git worktree of its own under .pipeline/trees/, leaving the person's checkout alone: a builder subagent builds each task in turn, verify checks that an integration test pins each behaviour it changed, reviewer subagents review the change, and it is committed once they pass it. When every task is committed, the person opens the pull request with /build submit, or it opens by itself with auto. It starts only once every question of the plan is answered and every risk decided; runs on other issues run beside it. Call it when the person asks to implement a planned issue.",
    inputSchema: {
      type: 'object',
      properties: {
        auto: { type: 'boolean', description: 'Go on by itself: send each task once the one before is committed, and open the pull request at the end. Only when the person asked for it in those words.' },
        ref: { type: 'string', description: "The plan of this issue, as the planner spells it (`github:owner/repo#12`); the plan in force when left out." },
      },
    },
  },
  {
    name: 'start_errand',
    description:
      "Implements a small issue without a plan, as an errand: in a git worktree of its own, a builder subagent builds the whole issue in one change, verify checks its integration tests, a reviewer subagent reviews it, and it is committed; the pull request then waits for the person's go (or opens by itself with auto). The builder hands back an issue that needs a decision or more than one change, for /planner to plan. Call it when the person asks for an issue to be done as an errand, or quickly without a plan.",
    inputSchema: { type: 'object', properties: { issue: { type: 'string', description: 'The issue: its URL, owner/repo#12, or #12 for this repository.' }, auto: { type: 'boolean', description: 'Open the pull request by itself once committed. Only when the person asked for it.' } }, required: ['issue'] },
  },
  {
    name: 'run',
    description: "Where each run the build is implementing stands: its phase, its worktree, the builder at work, the last test check and review, and each task with its commit.",
    inputSchema: { type: 'object', properties: { ref: { type: 'string', description: 'One run, by its ref; every run when left out.' } } },
  },
  {
    name: 'commit',
    description: "Checks and reviews the uncommitted change of a stuck task again, and commits it once the review passes it. Call it when the person has finished a stuck task by hand, in the run's worktree, and asks to commit it.",
    inputSchema: { type: 'object', properties: { ref: REF } },
  },
  {
    name: 'next',
    description:
      "Sends a builder on the run's next task, or on its stuck task again, from its first rung and on what its worktree holds, as /build next does. Only for a run that is ready or stuck. Call it when the person asks to go on with a run, or to try a stuck task again.",
    inputSchema: { type: 'object', properties: { ref: REF } },
  },
] as const

const PHASE_TONE: Record<RunPhase, Tone> = { ready: 'neutral', 'writing-tests': 'info', 'building': 'info', proving: 'info', 'reviewing': 'info', stuck: 'danger', 'built': 'accent', 'reviewing-branch': 'info', 'submitted': 'success' }

// The phases a run waits in on something that is out: a builder, the tests written first, the proof or the reviewers
const OUT: readonly RunPhase[] = ['writing-tests', 'building', 'proving', 'reviewing', 'reviewing-branch']

async function runAt($: $, ref: string): Promise<Run | null> {
  return (await read($, quests))[ref] ?? null
}

/** Changes a run, and keeps it across sessions. Answers it as it now stands; nothing when no run is on the ref. */
async function keep($: $, ref: string, change: (was: Run) => Run): Promise<Run | null> {
  // Set inside the update: typed wide, as the narrowing does not follow it there
  let made = null as Run | null
  let refused = ''

  // The change is made once, on the run as it stands when it is written, and what is kept across sessions is that;
  // a change that would move the run off its course is not made
  await update($, quests, held => {
    const was = held[ref]

    if (was === undefined) return held

    const next = change(was)

    if (!canMove(was.phase, next.phase)) {
      refused = `the run on ${ref} cannot go from ${was.phase} to ${next.phase}`

      return held
    }

    made = next

    return { ...held, [ref]: made }
  })

  if (refused !== '') throw new Error(refused)

  if (made !== null) {
    const kept: Run = made

    await $.store.set(STORE_KEY(ref), kept).catch(async (error: unknown) => {
      const why = `${ref} could not be kept for the next session: ${errorText(error)}`

      $.ui.toast(`Build: ${why}`)
      await update($, notes, all => ({ ...all, [ref]: why }))
    })
  }

  return made
}

/** Lays a run down: no longer under way here, and kept across sessions no more. */
async function drop($: $, ref: string): Promise<void> {
  await update($, quests, ({ [ref]: _gone, ...rest }) => rest)
  await update($, plans, ({ [ref]: _gone, ...rest }) => rest)
  await update($, working, ({ [ref]: _gone, ...rest }) => rest)
  await $.store.delete(STORE_KEY(ref)).catch(() => undefined)
  await update($, selected, was => (was === ref ? '' : was))
}

async function say($: $, ref: string, text: string): Promise<void> {
  await update($, notes, was => ({ ...was, [ref]: text }))
}

async function work($: $, ref: string, text: string): Promise<void> {
  await update($, working, was => ({ ...was, [ref]: text }))
}

async function want($: $, ref: string, what: RunAsk, arg?: string): Promise<void> {
  await update($, wanted, was => [...was, { ref, what, ...(arg !== undefined ? { arg } : {}) }])
}

async function tell($: $, text: string): Promise<void> {
  $.ui.toast(`Build: ${text}`)
  await $.ui.notify(text, { title: 'Build' }).catch(() => undefined)
}

/**
 * The work of a run, read afresh and kept for the pane: a plan's from the planner, by its issue; an errand's or a review's
 * from the tasks it keeps. A sentence when it could not be read.
 */
async function workOf($: $, held: Run): Promise<RunWork | string> {
  let made: RunWork | null | string

  made = held.kind === 'plan' ? parsePlan(await planFor($, issueRefOf(held))) : ownPlan(held)

  if (made === null) return `The planner keeps no plan of ${held.ref} any more.`
  if (typeof made === 'string') return made

  const kept = made

  await update($, plans, was => ({ ...was, [held.ref]: kept }))

  return kept
}

/** Marks a task of a run: in the planner for a plan, in the run itself for any other. */
async function mark($: $, held: Run, id: number, state: RunTaskState, note?: string): Promise<void> {
  // The planner keeps no `asked`: a plan's task is handed back as it stands
  if (held.kind === 'plan') {
    if (state !== 'asked') await markTask($, id, state, issueRefOf(held))

    return
  }

  await keep($, held.ref, was => ({ ...was, tasks: (was.tasks ?? []).map(task => (task.id === id ? { ...task, state, ...(note !== undefined ? { note } : {}) } : task)) }))
}

/** Every run kept, here or across sessions: what the cleanup watches. A lane is its run's, and is none of them. */
export async function runLeftovers($: $): Promise<{ ref: string; kind: RunKind; branch: string; base: string; tree: string; pr: string; phase: string }[]> {
  const kept = Object.values(await read($, quests)).filter(held => held.lane === undefined)

  for (const key of (await $.store.keys().catch(() => [])).filter(one => one.startsWith('run:'))) {
    const one = runFromStore(await $.store.get(key).catch(() => undefined))

    if (one !== undefined && one !== null && one.lane === undefined && !kept.some(was => was.ref === one.ref)) kept.push(one)
  }

  return kept.map(({ ref, kind, branch, base, tree, pr, phase }) => ({ ref, kind: kind ?? 'plan', branch, base, tree: tree ?? '', pr, phase }))
}

/** Forgets a run whose pull request is merged from its branch, here and across sessions. Its worktree is the cleanup's to clear. */
export async function forgetRun($: $, ref: string, pr: string): Promise<{ forgotten: boolean; text: string }> {
  const found = (await runLeftovers($)).find(one => one.ref === ref)

  if (found === undefined) return { forgotten: false, text: `No run on ${ref} is kept.` }
  if (!(await isMergedFrom($, pr, found.branch))) return { forgotten: false, text: `${pr} is not a merged pull request from ${found.branch}: the run on ${ref} is kept.` }

  await drop($, ref)

  return { forgotten: true, text: `The run on ${ref} is forgotten.` }
}

/** The branch the person's checkout is on, else the remote's default, else main: what a run starts from. */
async function baseOf($: $, root: string, branch: string): Promise<string> {
  const current = await git($, ['rev-parse', '--abbrev-ref', 'HEAD'], root)

  if (current.ok && current.out !== '' && current.out !== 'HEAD' && current.out !== branch) return current.out

  const found = await git($, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], root)

  return found.ok && found.out !== '' ? found.out.replace(/^origin\//, '') : 'main'
}

/**
 * Where a run is built: the folder its branch is checked out in already (a worktree, or the person's own checkout),
 * else a worktree made for it under .fellowship/trees, its branch made from its base when there is none. A review's
 * branch is the pull request's, fetched from the forge. Answers why there is none where it could not be made.
 */
async function placeTree($: $, branch: string, base: string | undefined, isFetched: boolean): Promise<{ tree: string; base: string } | string> {
  const root = await rootOf($)
  const from = base ?? (await baseOf($, root, branch))
  const at = parseWorktrees((await git($, ['worktree', 'list', '--porcelain'], root)).out).find(one => one.branch === branch)

  if (at !== undefined) return { tree: at.path, base: from }

  const tree = treePathOf(root, branch)

  // The folder ignores itself: no run's worktree is part of the project's checkout
  await $.fs.write(`${root}/.pipeline/.gitignore`, '*\n').catch(() => undefined)

  const fetched = isFetched ? await run($, ['git', 'fetch', 'origin', branch], FETCH_TIMEOUT_MS, root) : undefined
  const exists = await git($, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], root)

  // A review's branch lives on origin; one that is not there is a fork's, which the build cannot push to
  if (fetched !== undefined && !fetched.ok && !exists.ok) return `${branch} could not be fetched from origin (${fetched.out || 'git said nothing'}): a pull request from a fork is not answered here, as its branch cannot be pushed to from this repository.`

  const added = await git($, exists.ok || isFetched ? ['worktree', 'add', tree, branch] : ['worktree', 'add', '-b', branch, tree, from], root)

  return added.ok ? { tree, base: from } : `The worktree of ${branch} could not be made at ${tree}: ${added.out}`
}

/**
 * Takes in what its base gained since the run left it, so the tasks still to come are built on it and its pull
 * request does not fall into conflict. A worktree with work in it is only said to be behind; a merge that conflicts is
 * taken back. Answers what stops the run, or undefined when it may go on.
 */
async function followBase($: $, held: Run): Promise<string | undefined> {
  // A review is built on the pull request's own branch, which its author keeps
  if (held.kind === 'review' || held.base === '') return undefined

  const fetched = await run($, ['git', 'fetch', 'origin', held.base], FETCH_TIMEOUT_MS, held.tree)
  const upstream = fetched.ok ? `origin/${held.base}` : held.base

  if ((await git($, ['merge-base', '--is-ancestor', upstream, 'HEAD'], held.tree)).ok) return undefined

  if ((await git($, ['status', '--porcelain'], held.tree)).out !== '') {
    await say($, held.ref, `${held.branch} is behind ${upstream}, but its worktree holds a change: it is taken in once the change is committed.`)

    return undefined
  }

  const merged = await git($, ['merge', '--no-edit', upstream], held.tree)

  if (merged.ok) {
    // The merge is no builder's commit: a task sent again after it is judged against HEAD as it now stands
    await keep($, held.ref, was => ({ ...was, current: was.current === null ? null : { ...was.current, head: '' } }))
    await say($, held.ref, `${held.branch} took in what ${upstream} gained since it left it.`)

    return undefined
  }

  const conflicted = (await git($, ['diff', '--name-only', '--diff-filter=U'], held.tree)).out.split('\n').filter(line => line !== '')

  await git($, ['merge', '--abort'], held.tree)

  return `${held.branch} cannot take in ${upstream}: it conflicts in ${conflicted.join(', ') || 'the tree'}. Merge it in ${held.tree} by hand, then go on.`
}

/** What a run is start on: what it is, and the branch it is built on. */
type Spec ={ kind: RunKind; ref: string; url: string; title: string; branch: string; base?: string; isAuto: boolean; tasks?: RunTask[]; pr?: string }

/**
 * Sets a run out, or takes it up where it was left: in its worktree, its first task sent by the clock, outside the
 * call that asked. Answers what was done, in a sentence.
 */
async function begin($: $, spec: Spec, made: RunWork): Promise<string> {
  const held = (await runAt($, spec.ref)) ?? runFromStore(await $.store.get(STORE_KEY(spec.ref)).catch(() => undefined)) ?? null

  if (held !== null && held.phase !== 'submitted' && (held.kind ?? 'plan') !== spec.kind) return `The build is on ${spec.ref} already, as ${held.kind === 'errand' ? 'an errand' : `a ${held.kind}`} (${held.phase}): finish or abandon it first.`

  const resumed = held !== null && held.phase !== 'submitted' ? held : undefined
  const branch = resumed?.branch ?? spec.branch
  const placed = await placeTree($, branch, resumed?.base ?? spec.base, spec.kind === 'review')

  if (typeof placed === 'string') return placed

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
    gitRuns: resumed?.gitRuns ?? (await gitRunsOf(shellIn($, placed.tree))),
    at: resumed?.at ?? Date.now(),
  }

  await update($, quests, was => ({ ...was, [spec.ref]: quest }))
  await update($, plans, was => ({ ...was, [spec.ref]: work }))
  await $.store.set(STORE_KEY(spec.ref), quest).catch(() => undefined)
  await update($, selected, () => spec.ref)
  await say($, spec.ref, '')
  await $.ui.open({ id: PANE, title: TITLE }).catch(() => undefined)

  // A run taken up again first takes in what its base gained meanwhile: the tasks still to come are built on it
  const behind = resumed !== undefined ? await followBase($, quest) : undefined

  if (behind !== undefined) {
    await keep($, spec.ref, was => ({ ...was, phase: 'stuck' }))
    await say($, spec.ref, behind)

    return `The build takes up its run on ${spec.ref}, but stops: ${behind}`
  }

  if (quest.phase === 'ready') await want($, spec.ref, 'next')
  if (quest.phase === 'built' && quest.isAuto && quest.kind !== 'review') await want($, spec.ref, 'submit')

  const how =spec.isAuto ? 'going on by itself' : 'stopping after each commit for you'
  const where = placed.tree === (await rootOf($)) ? 'in your own checkout, where its branch is' : `in its worktree ${placed.tree}`

  return resumed !== undefined
    ? `The build takes up its run on ${spec.ref} (${tally(work)}, ${quest.phase}) on ${branch}, ${where}, ${how}.`
    : `The build starts on ${spec.ref}, "${spec.title}", on ${branch} from ${placed.base}, ${where}, ${how}: the first task is sent.`
}

/** Sets out on the plan in force, or the one of the issue named. */
async function setOut($: $, isAuto: boolean, ref = ''): Promise<string> {
  const made = parsePlan(await planFor($, ref))

  if (made === null) return HOW_TO
  if (typeof made === 'string') return made

  const open = unsettledOf(made)

  if (open.length > 0) return `The planner's work on ${made.ref} is not settled: ${open.join('; ')}. Settle them in the planner pane, then start the run.`

  return begin($, { kind: 'plan', ref: made.ref, url: made.url, title: made.title, branch: branchOf(made), isAuto }, made)
}

/**
 * Sets out on an issue as an errand: one task, the whole issue, read through the planner. One opened from outside the
 * repository is built only when the person asked for it themselves (`isPersons`): Claude's call may have been steered.
 */
async function errand($: $, input: string, isAuto: boolean, isPersons: boolean): Promise<string> {
  const issue = await readIssue($, input)

  if ('error' in issue) return issue.error
  if (issue.isOutside && !isPersons) return `${issue.ref} was opened by ${issue.author || 'someone'}, from outside the repository (or the forge could not say who can push to it): only the person starts on it, with /build errand ${issue.ref} or from the issues pane (/issues).`

  const task = errandTask(issue)
  const spec: Spec = { kind: 'errand', ref: issue.ref, url: issue.url ?? '', title: issue.title ?? '', branch: branchOf({ ref: issue.ref, title: issue.title ?? '' }), isAuto, tasks: [task] }

  return begin($, spec, ownPlan(spec))
}

/**
 * Sets out on an issue as an errand from a press of another part's pane: the press asks, and the clock sets it out,
 * as starting sends no agent; its first builder waits for a hook.
 */
export async function askErrand($: $, issue: string): Promise<void> {
  await want($, '', 'errand', issue)
  await $.ui.open({ id: PANE, title: TITLE }).catch(() => undefined)
}

/** Takes up the review comments the review follow-up handed over, on the pull request's own branch. Answers what was done, in a sentence. */
export async function takeReview($: $, given: unknown, isAuto: boolean): Promise<string> {
  const pr = (typeof given === 'object' && given !== null ? given : {}) as { ref?: unknown; url?: unknown; title?: unknown; branch?: unknown; base?: unknown; comments?: unknown }
  const tasks = reviewTasks(pr.comments)

  if (typeof pr.ref !== 'string' || typeof pr.branch !== 'string' || pr.branch === '') return 'A review is handed over with its pull request (ref, branch) and its comments.'
  if (tasks.length === 0) return `No comment of ${pr.ref} asks for a change: there is nothing to build.`

  const ref = pr.ref.startsWith('review:') ? pr.ref : `review:${pr.ref}`
  const spec: Spec = { kind: 'review', ref, url: typeof pr.url === 'string' ? pr.url : '', title: typeof pr.title === 'string' ? pr.title : '', branch: pr.branch, base: typeof pr.base === 'string' && pr.base !== '' ? pr.base : undefined, isAuto, tasks, pr: typeof pr.url === 'string' ? pr.url : '' }
  const said = await begin($, spec, ownPlan(spec))

  // The first comment's builder is sent here when the review follow-up hands it over from a hook; from the clock, at the next
  await pumpBuild($, ref)

  return said
}

/** Sends a builder on a task: marked doing, chosen by the try and the task, and spawned in the run's worktree. */
async function sendBuilder($: $, held: Run, made: RunWork, task: RunTask, attempt: number, retry?: Retry): Promise<void> {
  const brief = briefFor({ quest: held, plan: made, task, attempt, targets: await targetsKnown($).catch(() => []), ...(retry !== undefined ? { retry } : {}), testsToPass: held.testsToPass, standards: await standardsText($) })
  const member = brief.builder
  const last = held.current
  // A task sent again keeps HEAD as it was when it was first sent: a commit made past the proof since stays one
  const head = last !== null && last.taskId === task.id && last.head !== undefined && last.head !== '' ? last.head : (await git($, ['rev-parse', 'HEAD'], held.tree)).out

  await mark($, held, task.id, 'doing')

  const started = await spawnIn($, { subagentType: typeOf(member), description: brief.description, prompt: brief.prompt, cwd: held.tree })
    .catch((error: unknown) => ({ deny: errorText(error), agentId: undefined }))

  if (started.deny !== undefined) {
    await keep($, held.ref, was => ({ ...was, phase: 'stuck', current: null }))
    await say($, held.ref, `${BUILDERS[member].title} could not be sent on task ${task.id}: ${started.deny}`)

    return
  }

  if (started.agentId !== undefined && started.agentId !== '') await remember($, started.agentId, { role: 'builder', root: await rootOf($), tree: held.tree, files: [...task.files], ref: issueRefOf(held) })

  await keep($, held.ref, was => ({ ...was, phase: 'building', verdictLine: '', current: { taskId: task.id, title: task.title, builder: member, agentId: started.agentId ?? '', attempt, at: Date.now(), answer: '', head, isResumed: false } }))
  await say($, held.ref, '')
}

/** What a run comes to once every task is behind it: built, and on an auto run that is no review, submitting. */
async function arrive($: $, held: Run): Promise<void> {
  await keep($, held.ref, was => ({ ...was, phase: 'built', current: null }))

  if (held.isAuto && held.kind !== 'review') await want($, held.ref, 'submit')
  else await tell($, `every task of ${held.ref} is behind it: ${held.kind === 'review' ? 'push the answers' : 'open the pull request'} from the pane`)
}

/** The lanes out on a run's tasks, beside one another. */
async function lanesOf($: $, ref: string): Promise<Run[]> {
  return Object.values(await read($, quests)).filter(held => held.lane?.of === ref)
}

/**
 * Sends the next task, or finds the run built. A stuck task is sent again from its first rung, on what the tree
 * holds. A plan's tasks that can be built beside one another are each sent in a lane of its own, and the run's own
 * worktree waits for them to land; one task alone is built there.
 */
async function sendNext($: $, ref: string): Promise<void> {
  const held = await runAt($, ref)

  if (held === null || (held.phase !== 'ready' && held.phase !== 'stuck')) return

  const made = await workOf($, held)

  if (typeof made === 'string') return say($, ref, made)
  if (held.lane === undefined && isAllDone(made)) return arrive($, held)

  // A task the run's own worktree has begun is finished there first
  if (held.kind === 'plan' && held.lane === undefined && held.current === null) {
    const lanes = await lanesOf($, ref)
    const out = made.tasks.filter(task => lanes.some(lane => lane.lane?.taskId === task.id))
    const beside = besideOf(readyTasks(made, out.map(task => task.id)), out)

    if (lanes.length > 0 || beside.length > 1) {
      if (beside.length === 0) return say($, ref, `Task${out.length === 1 ? '' : 's'} ${out.map(task => task.id).join(', ')} ${out.length === 1 ? 'is' : 'are'} out in a lane: what is left waits for ${out.length === 1 ? 'it' : 'them'} to land.`)

      for (const task of beside) await openLane($, held, made, task)

      return say($, ref, `Task${beside.length === 1 ? '' : 's'} ${beside.map(task => task.id).join(', ')} ${beside.length === 1 ? 'is' : 'are'} sent out, each in a lane of its own, built beside the others and landed on ${held.branch} once passed.`)
    }
  }

  // A lane builds its one task
  const task = held.lane !== undefined ? made.tasks.find(one => one.id === held.lane?.taskId) : nextTask(made)

  if (task === undefined) {
    await keep($, ref, was => ({ ...was, phase: 'stuck' }))
    await say($, ref, `No task of ${ref} is ready: what is left depends on a task that is not done.`)

    return
  }

  // A plan's task that is not light is shown first in the tests written first: the test writer writes its tests, red, before anyone builds it
  if (held.kind === 'plan' && task.weight !== 'light' && held.testsFor !== task.id) return gazeOn($, held, made, task)

  const last = held.current?.taskId === task.id ? held.current : null
  const retry: Retry | undefined = last === null || held.proof === '' ? undefined : { attempt: 1, by: BUILDERS[last.builder].title, answer: last.answer, proof: held.proof }

  await work($, ref, `Sending a builder on task ${task.id}…`)
  await sendBuilder($, held, made, task, 1, retry)
}

/** Opens a lane on a task of a run: its branch off the run's, in a worktree of its own, its task sent by the clock. */
async function openLane($: $, held: Run, made: RunWork, task: RunTask): Promise<void> {
  const ref = laneRefOf(held.ref, task.id)
  const branch = laneBranchOf(held.branch, task.id)
  const placed = await placeTree($, branch, held.branch, false)

  if (typeof placed === 'string') return say($, held.ref, `Task ${task.id} could not be sent out in a lane: ${placed}`)

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
    gitRuns: await gitRunsOf(shellIn($, placed.tree)),
    lane: { of: held.ref, taskId: task.id },
    at: Date.now(),
  }

  await update($, quests, was => ({ ...was, [ref]: lane }))
  await update($, plans, was => ({ ...was, [ref]: made }))
  await $.store.set(STORE_KEY(ref), lane).catch((error: unknown) => $.ui.toast(`Build: ${ref} could not be kept for the next session: ${errorText(error)}`))
  await want($, ref, 'next')
}

/** Has the test writer write a task's tests first, in the run's worktree. Where tests first does not answer, the task is built without them. */
async function gazeOn($: $, held: Run, made: RunWork, task: RunTask): Promise<void> {
  await work($, held.ref, `The test writer writes the tests of task ${task.id}…`)

  const sent = await writeTestsFor($, purposeOf(held, made, task), issueRefOf(held), task.weight, held.tree).catch((error: unknown) => errorText(error))

  if (!/writes the tests/.test(sent)) {
    const after = await keep($, held.ref, was => ({ ...was, testsFor: task.id, testsToPass: null }))

    await say($, held.ref, `The test writer did not answer (${sent.slice(0, 160)}): task ${task.id} is built without tests first.`)
    if (after !== null) await sendBuilder($, after, made, task, 1)

    return
  }

  await keep($, held.ref, was => ({ ...was, phase: 'writing-tests', testsFor: task.id, testsToPass: null, current: null }))
}

/** Looks into the tests written first while the test writer gazes: once it has shown the tests, or that there are none, the task is built. */
async function behold($: $, ref: string): Promise<void> {
  const held = await runAt($, ref)

  if (held === null || held.phase !== 'writing-tests') return

  const shown: Seen = await testsFirstIn($, held.tree).catch((error: unknown) => ({ state: 'unreadable' as const, why: errorText(error).slice(0, 200) }))
  const step = afterGaze(shown, await workOf($, held), held.testsFor, ref)

  if (step.kind === 'wait') return

  if (step.kind === 'lost') {
    await keep($, ref, was => ({ ...was, phase: 'stuck' }))
    await say($, ref, step.why)

    return
  }

  if (step.kind === 'clouded') {
    await keep($, ref, was => ({ ...was, phase: 'stuck', testsFor: undefined }))
    await say($, ref, step.why)
    await tell($, `the tests written first of task ${step.task.id} of ${ref} could not be read`)

    return
  }

  const after = await keep($, ref, was => ({ ...was, phase: 'ready', testsToPass: step.testsToPass }))

  if (step.said !== '') await say($, ref, step.said)
  await work($, ref, `Sending a builder on task ${step.task.id}…`)
  if (after !== null) await sendBuilder($, after, step.plan, step.task, 1)
}

/**
 * Sends the task up a rung after a try that did not pass, with what stopped it; or, when the last builder has tried it, stops
 * the run for the person.
 */
async function again($: $, ref: string, why: Why, line: string): Promise<void> {
  const held = await runAt($, ref)
  const out = held?.current

  if (held === null || out === null || out === undefined) return

  const made = await workOf($, held)
  const task = typeof made === 'string' ? undefined : made.tasks.find(one => one.id === out.taskId)
  const next = afterFailedTry({ ...out, by: BUILDERS[out.builder].title }, typeof made === 'string' || task === undefined ? undefined : triesOf(made, task), line, held.tree)

  // A proof that does not settle the change, or findings that block it, send its builder back once, before a fresh
  // builder a rung up starts over cold
  if (next.isSentBack && (await sendBack($, out.agentId, typeOf(out.builder), sendBackPrompt(why)))) {
    await keep($, ref, was => ({ ...was, phase: 'building', current: { ...out, isResumed: true, isRebased: false, answer: '' } }))
    await say($, ref, `${BUILDERS[out.builder].title} is sent back to task ${out.taskId} with ${why.findings !== undefined ? 'the findings' : 'the proof'}: ${line}`)

    return
  }

  if (next.otherwise.kind === 'climb' && typeof made !== 'string' && task !== undefined) return sendBuilder($, held, made, task, next.otherwise.attempt, { attempt: next.otherwise.attempt, by: BUILDERS[out.builder].title, answer: out.answer, ...why })
  if (next.otherwise.kind === 'stop') await stop($, held, next.otherwise.why)
}

/**
 * Why the change in the tree cannot be taken as the task's: HEAD moved since the task was first sent, so a commit was
 * made past the proof and the reviewers. Nothing when it did not.
 */
async function headMoved($: $, held: Run): Promise<string | undefined> {
  const out = held.current

  if (out === null || out.head === undefined || out.head === '') return undefined

  const now = (await git($, ['rev-parse', 'HEAD'], held.tree)).out

  return now === out.head
    ? undefined
    : `HEAD moved from ${out.head.slice(0, 7)} to ${now.slice(0, 7)} while task ${out.taskId} was out: a commit was made past the proof and its reviewers. Put it back as uncommitted work (git reset --soft ${out.head.slice(0, 7)} in ${held.tree}), then put it up for verification again.`
}

/** Stops a run for the person, saying why. */
async function stop($: $, held: Run, why: string): Promise<void> {
  await keep($, held.ref, was => ({ ...was, phase: 'stuck' }))
  await say($, held.ref, why)
  await tell($, `${held.ref} is stuck: ${why.split('\n')[0] ?? why}`)
}

// One proof at a time: lanes build beside one another, but a service's proof plays against one database kept warm
const oneProof = inTurn()

/** Proves what a builder built: settled, the reviewers are sent to judge it; else the task goes up a rung. */
async function prove($: $, ref: string): Promise<void> {
  const held = await runAt($, ref)

  if (held === null || held.phase !== 'proving' || held.current === null) return

  const out = held.current
  const moved = await headMoved($, held)

  if (moved !== undefined) return stop($, held, moved)

  await work($, ref, `Verify proves task ${out.taskId}…`)

  // The reviewers are sent here, on the change and what it is for: the proof owes none at the turn's end. the test writer's
  // tests, written from the task before it was built, must pass for the proof to settle, all but
  // those a builder has since said cannot run here
  const isSeen = held.testsToPass?.taskId === out.taskId
  const mirror = isSeen ? await mirrorOf($, held) : { amendments: [], tampered: [], unrun: [] }
  const written = isSeen ? (held.testsToPass?.tests ?? []).filter(test => !mirror.unrun.some(one => one.file === test.file && one.name === test.name)) : []
  const verdict = proofVerdict(await oneProof(() => proveFor($, held.tree, written)).catch((error: unknown) => `Verify could not prove the change: ${errorText(error)}`))

  await keep($, ref, was => ({ ...was, proof: verdict.text, proofLine: verdict.line, unproven: verdict.unhandled }))

  const step = afterProof(verdict, out, mirror.tampered)

  if (step.kind === 'stop') return stop($, held, step.why)
  if (step.kind === 'again') return again($, ref, step.why, step.line)
  if (step.kind === 'commit') return void (await commitNow($, ref, step.minor))

  await work($, ref, `The reviewers are sent to judge task ${out.taskId}…`)

  const made = await workOf($, held)
  const task = typeof made === 'string' ? undefined : made.tasks.find(one => one.id === out.taskId)
  const about = typeof made === 'string' || task === undefined ? '' : purposeOf(held, made, task, mirror.amendments)
  // Both reviewers judge every change: a task's weight is the planner's guess, and what a change lets in is known only
  // once it is made. Where nothing proves what it reached, they judge with their own model; else as the task's weight
  // and risks ask, a task that is not heavy on a lighter model
  const isBlind = typeof made === 'string' || task === undefined || verdict.unhandled.length > 0
  const model = isBlind ? undefined : reviewerModelFor(made, task)
  const judged = parseJudgement(await judgementFor($, held.tree, { start: true, about, reviewers: ['reviewer-correctness', 'reviewer-security'], ref: issueRefOf(held), ...(model !== undefined ? { model } : {}) }).catch((error: unknown) => errorText(error)))

  await keep($, ref, was => ({ ...was, phase: 'reviewing', verdictLine: judged.line }))
  await settle($, ref, judged)
}

/**
 * What a builder changed of the test writer's tests and why, what was taken out of them with no reason, and which cannot run
 * here, as tests first keeps it. A test a builder said cannot run here is judged as a change is, its reason with it.
 */
async function mirrorOf($: $, held: Run): Promise<{ amendments: { file: string; why: string; by: string }[]; tampered: { file: string; lines: string[] }[]; unrun: { file: string; name: string }[] }> {
  const shown = await testsFirstIn($, held.tree).catch(() => undefined)
  const unrun = shown?.unrun ?? []
  const said = unrun.flatMap(one => (one.by !== undefined ? [{ file: one.file, why: `${one.name} cannot run here, and is owed no passing: ${one.why}`, by: one.by }] : []))

  return { amendments: [...(shown?.amendments ?? []), ...said], tampered: shown?.tampered ?? [], unrun }
}

/**
 * The minor findings of a judgement that are about what the change in a tree wrote. Where git cannot say what it wrote,
 * every one is, as none can be told apart.
 */
async function ownMinorIn($: $, tree: string, judged: Judged): Promise<string[]> {
  const tracked = await git($, ['diff', 'HEAD', '--name-only', ...UNMODDED], tree)
  const fresh = await git($, ['ls-files', '-o', '--exclude-standard', ...UNMODDED], tree)

  if (!tracked.ok || !fresh.ok) return judged.minor

  return ownMinor(judged.minorAt, tree, `${tracked.out}\n${fresh.out}`.split('\n').map(one => one.trim()).filter(one => one !== ''))
}

/** Looks at the reviewers' judgement of a run's change, while they review. */
async function judge($: $, ref: string): Promise<void> {
  const held = await runAt($, ref)

  if (held === null || held.phase !== 'reviewing') return

  await settle($, ref, parseJudgement(await judgementFor($, held.tree).catch((error: unknown) => errorText(error))))
}

/** What the reviewers' verdict comes to: committed when they pass the change, sent back up a rung when they find what blocks it. */
async function settle($: $, ref: string, judged: ReturnType<typeof parseJudgement>): Promise<void> {
  const held = await keep($, ref, was => (was.phase === 'reviewing' ? { ...was, verdictLine: judged.line } : was))

  if (held === null || held.phase !== 'reviewing' || held.current === null) return

  const out = held.current

  // Minor findings of a pass about what the change wrote send its builder back once to tidy them; those of the judgement
  // after, and those about files it left alone, are committed as they are, and a builder that cannot be reached spends no
  // try on them
  const step = afterVerdict(judged, out, isTidyAsked(judged, out) ? await ownMinorIn($, held.tree, judged) : [])

  if (step.kind === 'wait') return
  if (step.kind === 'tidy') {
    if (await sendBack($, out.agentId, typeOf(out.builder), tidyPrompt(step.minor))) {
      await keep($, ref, was => ({ ...was, phase: 'building', current: { ...out, isTidied: true, answer: '' } }))
      await say($, ref, `${BUILDERS[out.builder].title} is sent back to task ${out.taskId} to tidy the minor findings: ${judged.line}`)

      return
    }

    return void (await commitNow($, ref, step.otherwise.minor))
  }
  if (step.kind === 'commit') return void (await commitNow($, ref, step.minor))
  if (step.kind === 'again') return again($, ref, step.why, step.line)

  // The change moved while they sat, or they never reviewed it: it is proved and judged afresh
  if (step.kind === 'prove') {
    await keep($, ref, was => ({ ...was, phase: 'proving' }))
    await want($, ref, 'prove')

    return
  }

  if (step.kind === 'stop') await stop($, held, step.why)
}

/** Commits the change the reviewers passed as the task's own, and goes on. Answers what was done, in a sentence. */
async function commitNow($: $, ref: string, minor: readonly string[]): Promise<string> {
  const held = await runAt($, ref)

  if (held === null || held.current === null) return 'There is nothing to commit.'

  const out = held.current
  const made = await workOf($, held)
  const task = typeof made === 'string' ? undefined : made.tasks.find(one => one.id === out.taskId)

  if (task === undefined || typeof made === 'string') {
    await keep($, ref, was => ({ ...was, phase: 'stuck' }))

    return `Task ${out.taskId} is not in the work of ${ref} any more: ${typeof made === 'string' ? made : 'started again.'}`
  }

  // The reviewers judged the change against HEAD as it was sent: a commit made since was judged by no one
  const moved = await headMoved($, held)

  if (moved !== undefined) {
    await stop($, held, moved)

    return moved
  }

  await work($, ref, `Committing task ${task.id}…`)

  const by = BUILDERS[out.builder].title
  const unproven = held.unproven ?? []
  // What the mods keep in the tree (the recorder's builds, verify's trees) is none of the change
  const committed = await commitTask(shellIn($, held.tree), { tree: held.tree, taskId: task.id, message: commitMessage({ ...held, ref: issueRefOf(held) }, made, task, by, minor, unproven), gitRuns: held.gitRuns })

  // An errand is the whole issue in one change: none at all means it was built somewhere else, or not at all
  if (committed.kind === 'clean' && held.kind === 'errand') {
    const why = `${by} left no change in ${held.tree} for ${ref}: it is not done. Look at what it says it built, then send it again.`

    await stop($, held, why)

    return why
  }

  if (committed.kind === 'refused') {
    await stop($, held, committed.why)

    return committed.why
  }

  // A task that needed no change is done with no commit
  const sha = committed.kind === 'committed' ? committed.sha : ''

  // A lane's commit is its run's once it lands on the run's branch
  if (held.lane !== undefined) return land($, ref, { taskId: task.id, title: task.title, sha, by, minor: [...minor], unproven: [...unproven], answer: out.answer, proof: held.proofLine, ...(out.isPutBefore === true ? { isPutBefore: true } : {}) })

  await mark($, held, task.id, 'done')

  const after = await keep($, ref, was => ({ ...was, phase: 'ready', current: null, testsToPass: null, proof: '', proofLine: '', verdictLine: '', unproven: [], isBranchReviewed: false, commits: [...was.commits, { taskId: task.id, title: task.title, sha, by, minor: [...minor], unproven: [...unproven], answer: out.answer, proof: was.proofLine, ...(out.isPutBefore === true ? { isPutBefore: true } : {}) }] }))
  const left = after === null ? made : await workOf($, after)
  const isArrived = typeof left !== 'string' && isAllDone(left)
  const said = `Task ${task.id} of ${ref}, "${task.title}", built by ${by}, passed verification and is committed${sha === '' ? ' (it changed nothing, so it is marked done with no commit)' : ` as ${sha.slice(0, 7)}`}.`

  if (isArrived || after?.isAuto === true) await want($, ref, 'next')
  else await tell($, `${said} The next task waits for you.`)

  return said
}

// One landing at a time: each lane lands on its run's branch as the one before left it
const oneLanding = inTurn()

/**
 * Lands a lane's commit on its run's branch: as it is, where nothing landed there since the lane started; else taken
 * onto what landed, and proved there again before it lands, or, where it no longer applies, sent back to its builder to
 * resolve. Once the run's branch holds it, its task is done, and the lane is cleared. Answers what was done.
 */
function land($: $, ref: string, commit: RunCommit): Promise<string> {
  return oneLanding(() => landNow($, ref, commit))
}

async function landNow($: $, ref: string, commit: RunCommit): Promise<string> {
  const held = await runAt($, ref)
  const quest = held?.lane === undefined ? null : await runAt($, held.lane.of)

  if (held === null || held.current === null) return 'There is nothing to land.'

  if (quest === null) {
    const why = `The run ${issueRefOf(held)} this lane builds for is under way no more: abandon the lane.`

    await stop($, held, why)

    return why
  }

  const landing = await landLane(shellIn($, held.tree), shellIn($, quest.tree), { taskId: commit.taskId, sha: commit.sha, branch: quest.branch, laneTree: held.tree, questTree: quest.tree })

  if (landing.kind === 'stop') {
    await stop($, held, landing.why)

    return landing.why
  }
  if (landing.kind === 'conflicts') return conflicted($, held, quest, landing.onto, commit)
  if (landing.kind === 'rebased') return reproved($, held, quest, landing.onto, commit)

  const landed = { ...commit, sha: landing.sha }

  await mark($, quest, commit.taskId, 'done')

  const after = await keep($, quest.ref, was => ({ ...was, isBranchReviewed: false, commits: [...was.commits, landed] }))
  const left = after === null ? null : await workOf($, after)
  const uncleared = await clearLane($, held)
  const said = `Task ${commit.taskId} of ${quest.ref}, "${commit.title}", built by ${commit.by} in a lane, passed verification and landed on ${quest.branch}${landed.sha === '' ? ' (it changed nothing, so it is marked done with no commit)' : ` as ${landed.sha.slice(0, 7)}`}.${uncleared}`

  await say($, quest.ref, said)
  if ((left !== null && typeof left !== 'string' && isAllDone(left)) || quest.isAuto) await want($, quest.ref, 'next')
  else await tell($, `${said} The next task waits for you.`)

  return said
}

/**
 * Where a lane's change no longer applies on its run's branch: the lane is put on that branch as it stands, the change
 * applied on it with git's conflict markers where the two meet, and its builder sent back to resolve them; where it
 * cannot be reached, the lane stops for the person. Answers what was done.
 */
async function conflicted($: $, held: Run, quest: Run, onto: string, commit: RunCommit): Promise<string> {
  const sha = commit.sha
  const applied = await applyAfresh(shellIn($, held.tree), onto, sha)
  const out = held.current

  if (out === null) return 'There is nothing to land.'

  const after = await keep($, held.ref, was => ({ ...was, proof: '', proofLine: '', verdictLine: '', current: { ...out, head: onto, isRebased: false, answer: '' } }))

  if (after === null) return 'There is nothing to land.'

  if (applied.kind === 'applies') return reproved($, held, quest, onto, commit)

  if (applied.kind === 'failed') {
    const why = `Task ${out.taskId} could not be taken onto ${quest.branch}, which moved while it was built: ${applied.why}. Its change is ${sha.slice(0, 7)}: apply it in ${held.tree} by hand, then put it up for verification.`

    await stop($, after, why)

    return why
  }

  const files = applied.files

  if (await sendBack($, out.agentId, typeOf(out.builder), conflictPrompt(quest.branch, files))) {
    await keep($, held.ref, was => ({ ...was, phase: 'building', current: was.current === null ? null : { ...was.current, isResumed: true } }))

    const said = `Task ${out.taskId} conflicts with what landed on ${quest.branch} (${files.join(', ')}): ${BUILDERS[out.builder].title} is sent back to resolve it.`

    await say($, held.ref, said)

    return said
  }

  const why = `Task ${out.taskId} conflicts with what landed on ${quest.branch} (${files.join(', ')}), and ${BUILDERS[out.builder].title} could not be sent back: its change is in ${held.tree} with git's conflict markers. Resolve them there, then put it up for verification.`

  await stop($, after, why)

  return why
}

/** A lane's change standing uncommitted on what landed on its run's branch: proved there again, and landed as it passed. */
async function reproved($: $, held: Run, quest: Run, onto: string, commit: RunCommit): Promise<string> {
  const out = held.current

  if (out === null) return 'There is nothing to land.'

  await keep($, held.ref, was => ({ ...was, phase: 'proving', proof: '', proofLine: '', current: { ...out, head: onto, isRebased: true, minor: commit.minor } }))
  await want($, held.ref, 'prove')

  const said = `${quest.branch} moved while task ${commit.taskId} was built: its change is taken onto it, and proved there again before it lands.`

  await say($, held.ref, said)

  return said
}

/** Clears a lane once it landed: its worktree removed, its branch deleted, and the lane forgotten. Says what could not be cleared. */
async function clearLane($: $, held: Run): Promise<string> {
  const root = await rootOf($)
  // What is left in it is what the mods kept there (the recorder's runs, verify's trees): its change is landed
  const left = (await git($, ['status', '--porcelain', ...UNMODDED], held.tree)).out
  const removed = left === '' ? await removeTree($, root, held.tree) : { ok: false, out: `it holds changes that did not land (${left.split('\n')[0] ?? ''})` }
  const deleted = removed.ok ? await git($, ['branch', '-D', held.branch], root) : { ok: true, out: '' }

  await drop($, held.ref)
  await update($, notes, ({ [held.ref]: _gone, ...rest }) => rest)

  return removed.ok && deleted.ok ? '' : ` Its lane is not cleared: ${removed.ok ? `${held.branch} could not be deleted: ${deleted.out}` : `${held.tree} is left: ${removed.out}`}.`
}

/** Puts a stuck task's change up for verification again: proved, judged, and committed once the reviewers pass it. */
async function resubmit($: $, ref: string): Promise<string> {
  const held = await runAt($, ref)

  if (held === null) return HOW_TO
  if (held.current === null || held.phase !== 'stuck') return `There is nothing to put up for verification: the run on ${ref} is ${held.phase}.`

  // The person puts it there having looked: git's config as it now stands is theirs
  const gitRuns = await gitRunsOf(shellIn($, held.tree))

  await keep($, ref, was => ({ ...was, phase: 'proving', gitRuns, current: was.current === null ? null : { ...was.current, isPutBefore: true } }))
  await want($, ref, 'prove')

  return `Task ${held.current.taskId}'s change goes up for verification: it is proved, judged by the reviewers, and committed once they pass it.`
}

/** What a run that is out waits on before it may be abandoned; nothing when it waits on nothing. */
const waitBeforeAbandon = (held: Run): string | undefined =>
  OUT.includes(held.phase)
    ? `The run on ${held.ref} is ${held.phase}: wait until ${held.phase === 'writing-tests' ? 'the test writer has shown the tests' : held.phase === 'reviewing' || held.phase === 'reviewing-branch' ? 'the reviewers have judged' : held.phase === 'proving' ? 'the proof is made' : `${held.current === null ? 'the builder' : BUILDERS[held.current.builder].title} is back`}, then abandon it.`
    : undefined

/** What a run, or a lane of it, that is out waits on before the run may be abandoned; nothing when none waits. */
async function abandonWait($: $, held: Run): Promise<string | undefined> {
  const lanes = held.lane === undefined ? await lanesOf($, held.ref) : []

  return [held, ...lanes].map(waitBeforeAbandon).find(one => one !== undefined)
}

/**
 * Gives a run up: its worktree removed, its own branch deleted (a review's is the pull request's, and is left), a
 * plan's tasks reopened in the planner, and the run forgotten here and across sessions. Nothing on the forge is touched.
 */
async function abandon($: $, ref: string): Promise<string> {
  const held = (await runAt($, ref)) ?? runFromStore(await $.store.get(STORE_KEY(ref)).catch(() => undefined)) ?? null

  if (held === null) return `No run on ${ref} is kept: there is nothing to abandon.`

  const lanes = held.lane === undefined ? await lanesOf($, ref) : []
  const waiting = await abandonWait($, held)

  if (waiting !== undefined) return waiting

  // Its lanes are given up first: each is a task of it, in a worktree of its own
  for (const lane of lanes) {
    const said = await abandon($, lane.ref)

    if ((await runAt($, lane.ref)) !== null) return `The run on ${ref} is not abandoned, as its lane on task ${lane.lane?.taskId ?? ''} is not: ${said}`
  }

  const root = await rootOf($)
  const isOwnTree = held.tree !== undefined && held.tree !== '' && held.tree !== root
  const said: string[] = [`The run on ${ref} is abandoned.`]

  if (isOwnTree) {
    // A worktree with work in it is the person's to keep or drop first
    if ((await git($, ['status', '--porcelain'], held.tree)).out !== '') return `${held.tree} holds uncommitted changes: commit, stash or drop them there, then abandon the run.`

    const removed = await git($, ['worktree', 'remove', held.tree], root)

    if (!removed.ok) return `The worktree ${held.tree} could not be removed: ${removed.out}`
    said.push(`Its worktree is removed.`)
  }

  if (held.kind !== 'review' && isOwnTree) {
    const exists = await git($, ['rev-parse', '--verify', '--quiet', `refs/heads/${held.branch}`], root)
    const deleted = exists.ok ? await git($, ['branch', '-D', held.branch], root) : { ok: true, out: '' }

    said.push(deleted.ok ? (exists.ok ? `${held.branch} is deleted, with its ${held.commits.length} ${held.commits.length === 1 ? 'commit' : 'commits'}.` : `${held.branch} was already gone.`) : `${held.branch} could not be deleted: ${deleted.out}.`)
  } else if (held.commits.length > 0) said.push(`${held.branch} is left as it is, with its ${held.commits.length} ${held.commits.length === 1 ? 'commit' : 'commits'}.`)

  // The tasks a plan's run took up are open again in the plan, which can be started on as it is; a lane's one task alone
  if (held.kind === 'plan') {
    const made = await workOf($, held)
    const reopened = typeof made === 'string' ? [] : made.tasks.filter(task => task.state !== 'todo' && (held.lane === undefined || task.id === held.lane.taskId))

    for (const task of reopened) await markTask($, task.id, 'todo', issueRefOf(held))
    if (reopened.length > 0) said.push(`${reopened.length} ${reopened.length === 1 ? 'task is' : 'tasks are'} open again in the plan.`)
  }

  if (held.pr !== '' && held.kind !== 'review') said.push(`Its pull request, ${held.pr}, is left as it is on the forge.`)

  await drop($, ref)
  await update($, wanted, was => was.filter(one => one.ref !== ref))
  await update($, notes, ({ [ref]: _gone, ...rest }) => rest)

  return said.join(' ')
}

/**
 * A commit as its branch holds it: the one recorded, while the branch holds it, else, where it was rewritten since (an
 * amended commit lives on outside its branch), the one that names its comment.
 */
async function landedSha($: $, tree: string, sha: string, task: RunTask): Promise<string> {
  if (sha !== '' && (await git($, ['merge-base', '--is-ancestor', sha, 'HEAD'], tree)).ok) return sha
  if (task.url === undefined || task.url === '') return sha

  const found = (await git($, ['log', '-n', '1', '--format=%H', '--fixed-strings', `--grep=${task.url}`], tree)).out.split('\n')[0] ?? ''

  return found !== '' ? found : sha
}

/** The last line a forge's command said of its failure. */
const lastLineOf = (ran: Ran): string => (ran.stderr || ran.stdout).trim().split('\n').slice(-1)[0] ?? ''

/**
 * Answers each review thread whose comment the run took up, once its answers are pushed: one built is told its commit
 * and resolved; one handed back is told why, and left open for the person. A thread is answered once. Says what was done.
 */
async function answerThreads($: $, ref: string): Promise<string> {
  const held = await runAt($, ref)
  const number = Number(/#(\d+)$/.exec(ref)?.[1] ?? NaN)

  if (held === null || !Number.isFinite(number)) return ''

  const forge = forgeIn($, forgeOfUrl(held.pr !== '' ? held.pr : held.url), held.tree)
  let answered = 0
  let resolved = 0
  const failed: string[] = []

  for (const task of (held.tasks ?? []).filter(one => one.thread !== undefined && one.thread !== '' && one.isAnswered !== true)) {
    const commit = held.commits.find(one => one.taskId === task.id && one.sha !== '')
    const reply = commit !== undefined ? `Answered in ${(await landedSha($, held.tree, commit.sha, task)).slice(0, 7)} by ${commit.by}.` : task.state === 'asked' ? `Handed back to the author: ${task.note ?? ''}` : undefined

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
    await keep($, ref, was => ({ ...was, tasks: (was.tasks ?? []).map(one => (one.id === task.id ? { ...one, isAnswered: true } : one)) }))
  }

  return [
    answered === 0 ? '' : ` ${answered} ${answered === 1 ? 'thread is' : 'threads are'} answered on the pull request, ${resolved} resolved.`,
    failed.length === 0 ? '' : ` Not answered on the forge: ${failed.join('; ')}.`,
  ].join('')
}

/** Pushes the branch and opens the pull request that closes the issue; a review's answers are pushed onto its pull request. */
async function sail($: $, ref: string): Promise<string> {
  const held = await runAt($, ref)

  if (held === null) return HOW_TO
  const unready = whyNotSail(held)

  if (unready !== undefined) return unready

  const made = await workOf($, held)

  if (typeof made === 'string') return made

  // Nothing that looks like a secret leaves the machine, whoever committed it
  const leak = await leakOf(shellIn($, held.tree), held)

  if (leak !== undefined) {
    await say($, ref, leak)

    return leak
  }

  if (held.kind === 'review') {
    await work($, ref, `Pushing ${held.branch}…`)

    const pushed = await push($, held.branch, held.tree)

    if (!pushed.ok) return `${held.branch} could not be pushed: it may be behind its remote. ${pushed.out.split('\n').slice(-1)[0] ?? ''}`

    await keep($, ref, was => ({ ...was, phase: was.phase === 'built' ? 'submitted' : was.phase }))

    const told = await answerThreads($, ref)

    return `${held.branch} is pushed: ${held.commits.length} answered ${held.commits.length === 1 ? 'comment is' : 'comments are'} on ${held.pr}.${told}`
  }

  // What the base gained since is taken in before the branch is judged whole and leaves the machine, so its pull request
  // does not open in conflict. A conflict leaves the run built: once it is merged by hand, it is submitted again
  if (held.isBranchReviewed !== true) {
    const behind = await followBase($, held)

    if (behind !== undefined) return behind
  }

  // Each task of a plan was judged alone: both reviewers judge what the tasks do and let in together, once, before the
  // branch leaves the machine
  if (held.kind === 'plan' && held.isBranchReviewed !== true) {
    // The branch took in origin's base, just fetched: judged against a local base behind it, the reviewers would judge
    // the commits it took in as the branch's own
    const upstream = (await git($, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${held.base}`], held.tree)).ok ? `origin/${held.base}` : held.base
    const model = wardModelFor(made, held.commits)
    const judged = parseJudgement(await judgementFor($, held.tree, { start: true, reviewers: ['reviewer-correctness', 'reviewer-security'], against: upstream, about: wardPurpose(made), ref, ...(model !== undefined ? { model } : {}) }).catch((error: unknown) => errorText(error)))

    await keep($, ref, was => ({ ...was, phase: 'reviewing-branch', verdictLine: judged.line }))

    return ward($, ref, judged)
  }

  await work($, ref, `Pushing ${held.branch} and opening the pull request…`)

  const { forge, request } = requestOf(held, made)
  const opened = await openRequest($, forge, request, held.tree)

  if (typeof opened !== 'object') return opened

  const url = opened.url

  await keep($, ref, was => ({ ...was, phase: 'submitted', pr: url }))
  await tell($, `the pull request for ${ref} is open${url === '' ? '' : `: ${url}`}`)

  return `The run is submitted: ${held.branch} is pushed and the pull request that closes ${ref} is open${url === '' ? '' : ` at ${url}`}.`
}

/**
 * What the reviewers' judgement of a plan's whole branch comes to: it is submitted once they pass it; what they find blocking,
 * or a reviewer's silence, stops it for the person. Answers what was done, in a sentence.
 */
async function ward($: $, ref: string, judged: ReturnType<typeof parseJudgement>): Promise<string> {
  const held = await runAt($, ref)

  if (held === null || held.phase !== 'reviewing-branch') return ''
  const step = afterWard(judged, held)

  if (step.kind === 'wait') return step.said

  if (step.kind === 'submit') {
    await keep($, ref, was => ({ ...was, phase: 'built', isBranchReviewed: true, verdictLine: step.line }))

    return sail($, ref)
  }

  await keep($, ref, was => ({ ...was, phase: 'built', isBranchReviewed: false, verdictLine: step.line }))
  await say($, ref, step.why)
  await tell($, step.why.split('\n')[0] ?? step.why)

  return step.why
}

/** Looks at the reviewers' judgement of a plan's whole branch, while they review. */
async function watchWard($: $, ref: string): Promise<void> {
  const held = await runAt($, ref)

  if (held === null) return

  const said = await ward($, ref, parseJudgement(await judgementFor($, held.tree).catch((error: unknown) => errorText(error))))

  if (said !== '' && !said.startsWith(WARDING)) await say($, ref, said)
}

// The runs the clock is doing something for now: a proof takes minutes, and that run's next ask waits for it while
// the others go on. '' stands for setting a new run out
const busy = new Set<string>()

/** Does one thing asked of a run, alone for that run: what came of it is told as well as kept in the pane. */
async function act($: $, asked: { ref: string; what: RunAsk | 'look'; arg?: string }): Promise<void> {
  const { ref, what } = asked

  busy.add(ref)

  try {
    if (what === 'look') {
      const phase = (await runAt($, ref))?.phase

      await (phase === 'writing-tests' ? behold($, ref) : phase === 'reviewing-branch' ? watchWard($, ref) : judge($, ref))
    } else if (what === 'next') await sendNext($, ref)
    else if (what === 'prove') await prove($, ref)
    else {
      const said =
        what === 'start' || what === 'start auto'
          ? await setOut($, what === 'start auto', asked.arg ?? '')
          : what === 'errand' || what === 'errand auto'
            ? await errand($, asked.arg ?? '', what === 'errand auto', true)
            : what === 'abandon'
              ? await abandon($, ref)
              : await sail($, ref)

      // A command typed answers before it is done: what came of it is told as well as kept in the pane, beside its
      // run, or for the build as a whole where it set none out or there is none any more
      $.ui.toast(`Build: ${said.split('\n')[0] ?? said}`)
      await say($, ref !== '' && (await runAt($, ref)) !== null ? ref : '', said)
    }
  } catch (error) {
    await say($, ref, `The build stumbled: ${errorText(error)}`)
  } finally {
    busy.delete(ref)
    await update($, working, ({ [ref]: _done, ...rest }) => rest)
  }
}

// What may be done where the mod stands in none of its hooks (the clock): what sends no agent. Starting places the
// worktree and asks for the first task, which waits for a hook
const UNHELD: readonly RunAsk[] = ['start', 'start auto', 'errand', 'errand auto', 'abandon']

/**
 * Does what was asked of the runs, the first ask of each at a time, and answers how many it took: in a hook every
 * one, as an agent sent there is held; from the clock only what sends none. `only` keeps to one run's asks (and to
 * starting); `isLooking` also looks at each run waiting on the reviewers or the tests written first, whose answer is in.
 */
async function drain($: $, isFramed: boolean, only?: string, isLooking = false): Promise<number> {
  // A press of the planner's pane asks to start on the plan it shows
  const fromPlanner = await takeSetOut($)

  if (fromPlanner !== undefined) await want($, '', fromPlanner.isAuto ? 'start auto' : 'start', fromPlanner.ref)

  const queue = await read($, wanted)
  const firsts = queue.filter((one, at) => queue.findIndex(other => other.ref === one.ref) === at)
  const taken = firsts.filter(one => !busy.has(one.ref) && (isFramed || UNHELD.includes(one.what)) && (only === undefined || one.ref === only || one.ref === ''))
  const isSame = (one: (typeof queue)[number], other: (typeof queue)[number]) => one.ref === other.ref && one.what === other.what && one.arg === other.arg

  if (taken.length > 0) await update($, wanted, was => was.filter((one, at) => !taken.some(other => isSame(one, other) && was.findIndex(first => isSame(first, other)) === at)))

  const looked = isFramed && isLooking ? Object.values(await read($, quests)).filter(held => !busy.has(held.ref) && (only === undefined || held.ref === only) && (held.phase === 'reviewing' || held.phase === 'writing-tests' || held.phase === 'reviewing-branch')) : []

  await Promise.all([...taken.map(one => act($, one)), ...looked.map(held => act($, { ref: held.ref, what: 'look' }))])

  return taken.length
}

/** The clock does what sends no agent: the rest waits for a hook. */
async function tick($: $): Promise<void> {
  await drain($, false)

  if ((await read($, wanted)).length > 0) await askToPump($, 'a build run waits to send its next agent.')
}

/**
 * Does what was asked of the runs, in the hook that calls it: where it stands in one, a builder, the reviewers or the
 * test writer it sends are held. Each ask may ask the next (starting asks for the first task, a commit for the next), so
 * it goes on until none is left; a run waiting on the reviewers or the tests written first is looked at first.
 */
export async function pumpBuild($: $, only?: string): Promise<void> {
  const isFramed = await inFrame($)

  for (let round = 0; round < 8; round += 1) {
    if ((await drain($, isFramed, only, round === 0)) === 0 && round > 0) break
  }

  // Outside a hook (a press, the clock), what would send an agent waits: Claude is asked to call for it
  if (!isFramed && (await read($, wanted)).length > 0) await askToPump($, 'a build run waits to send its next agent.')
}

/** Runs a call that is not the clock's for a run, holding the clock off that run. */
async function alone<T>($: $, ref: string, act: () => Promise<T>): Promise<T> {
  busy.add(ref)

  try {
    return await act()
  } finally {
    busy.delete(ref)
    await update($, working, ({ [ref]: _done, ...rest }) => rest)
  }
}

/** The run whose builder an agent is: by the id its spawn answered, else, where it answered none, by its type. */
async function runOfAgent($: $, agentId: string, phase?: RunPhase): Promise<Run | undefined> {
  const all = Object.values(await read($, quests)).filter(held => held.current !== null && (phase === undefined || held.phase === phase))
  const byId = all.find(held => held.current?.agentId !== '' && held.current?.agentId === agentId)

  if (byId !== undefined) return byId

  const agent = (await $.agent.list().catch(() => [])).find(one => one.id === agentId && one.status === 'running')

  return agent === undefined ? undefined : all.find(held => held.current?.agentId === '' && agent.type === typeOf(held.current.builder))
}

/** The run a command or a call names, by its ref or its branch; else the one the pane shows, else the only one. */
async function namedQuest($: $, named = ''): Promise<Run | null> {
  const all = await read($, quests)

  // A run by its ref, its branch, or its number (`12`, `#12`), matched whole: `2` is never #12. Two runs a number
  // names alike (#12 of two repositories) name none
  if (named !== '') {
    const number = /^#?(\d+)$/.exec(named)?.[1]
    const found = all[named] !== undefined ? [all[named]] : Object.values(all).filter(one => one.branch === named || (number !== undefined && new RegExp(`[#!]${number}$`).test(one.ref)))

    return found.length === 1 ? (found[0] ?? null) : null
  }

  const shown = await read($, selected)

  return all[shown] ?? (Object.values(all).length === 1 ? (Object.values(all)[0] ?? null) : null)
}

const sectionText = (all: readonly Run[]): string =>
  [
    `The build mod is implementing ${all.length === 1 ? 'an issue' : `${all.length} issues`}, each task by task in a git worktree of its own by builder subagents, each change test-checked, reviewed and committed alone:`,
    ...all.map(held => `- ${held.ref} (${held.kind}): ${held.phase}, in ${held.tree}`),
    "Leave those worktrees to the builders; mcp__pipeline__run says where each run stands.",
  ].join('\n')

/** The line the pane shows of what each run's agents cost, from the record as it stands. */
async function spentLines($: $, root: string, turns: readonly SpentTurn[]): Promise<void> {
  const all = Object.values(await read($, quests))

  await update($, spent, () =>
    Object.fromEntries(
      all.flatMap(held => {
        const own = spentOn(held, root, turns)

        return own.length === 0 ? [] : [[held.ref, costLine(own)] as const]
      }),
    ),
  )
}

/** What the runs kept across sessions have cost, from the record, for the pane. */
async function recallSpent($: $): Promise<void> {
  const root = await rootOf($)

  await spentLines($, root, await spends($, root))
}

/** Counts a turn of an agent the mod sent to the record, and to the pane's line of each run it was for. */
export async function spentBuild($: $, agent: SentAgent, e: { durationMs: number; usage?: TurnUsage }): Promise<void> {
  const spend = spendOf(agent, e, Date.now())

  if (spend === undefined) return

  const root = await rootOf($)

  await spentLines($, root, await record($, root, spend))
}

/** The build at the session's start: its command, its tools, and the clock that does what was asked of a run. */
export async function startBuild($: $): Promise<void> {
  await $.command.register({ name: 'build', description: 'Build a plan, an errand or a review task by task in a worktree: /build starts (--auto goes on by itself); errand <issue>; next, commit, submit, halt, abandon [run]' })

  // A host that registers no tools still starts the session
  for (const tool of TOOLS) await $.tool.register(tool).catch(() => undefined)

  await recallQuests($).catch(() => undefined)
  await recallSpent($).catch((error: unknown) => $.ui.toast(`Build: what the runs cost could not be read from ${SPEND_FILE}: ${errorText(error)}`))

  $.clock.every(TICK_MS, () => void tick($).catch(() => undefined))
}

/**
 * The runs kept across sessions, back as they stood: what was out when the session ended (a builder, the proof, the
 * reviewers, the tests written first) is out no more, and its run stuck, as taking it up again leaves it; nothing is sent. A run
 * the session holds already (a reload keeps them) is left as it is.
 */
async function recallQuests($: $): Promise<void> {
  const held = await read($, quests)

  for (const key of (await $.store.keys().catch(() => [])).filter(one => one.startsWith('run:'))) {
    const kept = runFromStore(await $.store.get(key).catch(() => undefined))

    if (kept === undefined || kept === null || typeof kept.ref !== 'string' || held[kept.ref] !== undefined) continue

    const was = kept.phase
    const phase = restingPhase(was)
    const quest: Run = { ...kept, kind: kept.kind ?? 'plan', phase }

    await update($, quests, all => ({ ...all, [quest.ref]: quest }))
    await workOf($, quest).catch(() => undefined)
  }
}

/** A turn has ended: what a builder built is proven, outside the hook; a task it hands back goes to the person. */
export async function endedBuild($: $, e: TurnEnded): Promise<void> {
  const held = e.agentId === undefined ? undefined : await runOfAgent($, e.agentId, 'building')

  if (held === undefined || held.current === null) return

  const out = { ...held.current, answer: e.answer ?? '' }
  const title = BUILDERS[out.builder].title
  const handed = e.isAborted || e.reason !== 'answer' ? undefined : handBackOf(out.answer)

  if (e.isAborted || e.reason !== 'answer') {
    await keep($, held.ref, was => ({ ...was, phase: 'stuck', current: out }))
    await say($, held.ref, `${title} on task ${out.taskId} ${e.isAborted ? 'was interrupted' : e.reason === 'refusal' ? 'refused' : 'ended on an API error'}: send it again from the pane.`)
  } else if (handed !== undefined && held.kind === 'review') {
    // A comment that asks something only the person can answer is theirs, and the run goes on to the next
    const isClean = (await git($, ['status', '--porcelain', ...UNMODDED], held.tree)).out === ''

    await keep($, held.ref, was => ({ ...was, phase: isClean ? 'ready' : 'stuck', current: isClean ? null : out }))
    await mark($, held, out.taskId, isClean ? 'asked' : 'doing', handed)
    if (isClean) await want($, held.ref, 'next')
    else await say($, held.ref, `${title} hands the comment back (${handed}), but left changes in ${held.tree}: drop them, or commit them from the pane.`)
  } else if (handed !== undefined) {
    await keep($, held.ref, was => ({ ...was, phase: 'stuck', current: out }))
    await say($, held.ref, held.kind === 'errand' ? `${title} hands ${held.ref} back: it is no errand. ${handed} Abandon it, then plan it with /planner ${held.ref}.` : `${title} stops on task ${out.taskId}: the plan must be revised. ${handed} Revise it in the planner pane, then send the task again.`)
    await tell($, `${title} hands ${held.ref} back: ${handed}`)
  } else {
    await keep($, held.ref, was => ({ ...was, phase: 'proving', current: out }))
    await want($, held.ref, 'prove')
  }
}

/** What Claude is told of the runs while they are under way. */
export async function sectionOfBuild($: $): Promise<Section | undefined> {
  const all = Object.values(await read($, quests)).filter(held => held.phase !== 'submitted')

  return all.length === 0 ? undefined : { id: 'fellowship:run', text: sectionText(all) }
}

/** A builder the record lost (sent where its spawn answered no id), found by the run it is out on, and held to its task's files. */
export async function builderFound($: $, agentId: string): Promise<SentAgent | undefined> {
  const held = await runOfAgent($, agentId)

  if (held === undefined || held.current === null) return undefined

  const task = (await read($, plans))[held.ref]?.tasks.find(one => one.id === held.current?.taskId)

  return { role: 'builder', root: await rootOf($), tree: held.tree, files: [...(task?.files ?? [])], ref: issueRefOf(held) }
}

export function registerBuild(on: On): void {

  on('tool.call', { tool: 'mcp__pipeline__start_run' }, async ($, e) => {
    const given = e as unknown as { auto?: unknown; ref?: unknown }

    const said = await alone($, '', () => setOut($, given.auto === true, typeof given.ref === 'string' ? given.ref : ''))

    // The first task is sent here, where its builder is held
    await pumpBuild($)

    return { result: said }
  }).catch((_$, _e, next) => toolFailed('start_run', next.error))

  on('tool.call', { tool: 'mcp__pipeline__start_errand' }, async ($, e) => {
    const given = e as unknown as { issue?: unknown; auto?: unknown }

    const said = await alone($, '', () => errand($, String(given.issue ?? ''), given.auto === true, false))

    // The errand's builder is sent here, where it is held
    await pumpBuild($)

    return { result: said }
  }).catch((_$, _e, next) => toolFailed('start_errand', next.error))

  on('tool.call', { tool: 'mcp__pipeline__run' }, async ($, e) => {
    const named = String((e as unknown as { ref?: unknown }).ref ?? '')
    const all = Object.values(await read($, quests)).filter(held => named === '' || held.ref === named || held.branch === named)

    if (all.length === 0) return { result: named === '' ? HOW_TO : `No run on ${named} is under way.` }

    const texts: string[] = []
    const root = await rootOf($)
    const turns = await spends($, root)

    for (const held of all) {
      const made = await workOf($, held)

      texts.push(runText(held, typeof made === 'string' ? ((await read($, plans))[held.ref] ?? null) : made, costText(spentOn(held, root, turns))))
    }

    return { result: texts.join('\n\n―――\n\n') }
  }).catch((_$, _e, next) => toolFailed('run', next.error))

  on('tool.call', { tool: 'mcp__pipeline__commit' }, async ($, e) => {
    const held = await namedQuest($, String((e as unknown as { ref?: unknown }).ref ?? ''))

    if (held === null) return { result: 'Name the run, by its ref: more than one is under way, or none.' }

    const said = await resubmit($, held.ref)

    // The proof, and the reviewers it leads to, are done here, where the reviewers are held
    await pumpBuild($, held.ref)

    return { result: said }
  }).catch((_$, _e, next) => toolFailed('commit', next.error))

  on('tool.call', { tool: 'mcp__pipeline__next' }, async ($, e) => {
    const held = await namedQuest($, String((e as unknown as { ref?: unknown }).ref ?? ''))

    if (held === null) return { result: 'Name the run, by its ref: more than one is under way, or none.' }
    if (held.phase !== 'ready' && held.phase !== 'stuck') return { result: `The run on ${held.ref} is ${held.phase}: no task is sent now.` }

    await want($, held.ref, 'next')
    // The builder is sent here, inside the tool's own hook, where it is held
    await pumpBuild($, held.ref)

    return { result: `A builder is sent on the next task of ${held.ref}: mcp__pipeline__run says how it goes.` }
  }).catch((_$, _e, next) => toolFailed('next', next.error))

  // Pushing and opening the pull request reach outside the machine: no tool offers them to Claude. The person is submitted with
  // /build submit or the pane, or opted into it up front with --auto. What sends an agent is done in the command,
  // where the agent is held: it answers once the agent is out (submitting, once the pull request is open)
  on('command.run', { command: 'build' }, async ($, e) => {
    const words = e.args.trim().split(/\s+/).filter(word => word !== '')
    // `auto` is taken as --auto: no issue is named so, and /build start auto once started on an issue "auto"
    const isAuto = words.includes('--auto') || words.includes('auto')
    const plain = words.filter(word => !word.startsWith('--') && word !== 'auto')
    const verb = plain[0] ?? ''
    const named = plain[1] ?? ''

    await $.ui.open({ id: PANE, title: TITLE })

    if (verb === 'errand') {
      if (named === '') return { text: 'Name the issue: /build errand <issue> (--auto opens its pull request by itself).' }
      await want($, '', isAuto ? 'errand auto' : 'errand', plain.slice(1).join(' '))
      await pumpBuild($)

      return { text: `The build starts on ${named} as an errand: the pane says how it went.` }
    }

    if (verb === '' || verb === 'start') {
      // Every run under way is shown, unless the person asks to start: /build start [issue]
      const all = Object.values(await read($, quests))
      const shown = await read($, plans)

      if (all.length > 0 && !isAuto && verb === '') return { text: all.map(held => runLine(held, shown[held.ref] ?? null)).join('\n') }

      await want($, '', isAuto ? 'start auto' : 'start', verb === 'start' ? named : '')
      await pumpBuild($)

      return { text: `The build starts on the plan${isAuto ? ', going on by itself' : ''}: the pane says how it went.` }
    }

    const held = await namedQuest($, named)

    if (held === null) return { text: named === '' ? 'Name the run, by its ref or its branch: more than one is under way, or none.' : `No run on ${named} is under way.` }

    if (verb === 'abandon') {
      const waiting = await abandonWait($, held)

      if (waiting !== undefined) return { text: waiting }
      await want($, held.ref, 'abandon')

      return { text: `The run on ${held.ref} is being abandoned: the pane says how it went.` }
    }

    if (verb === 'halt') {
      await keep($, held.ref, was => ({ ...was, isAuto: false }))

      return { text: `The run on ${held.ref} stops after the task it is on: send the next from the pane, or /build next.` }
    }

    if (verb === 'next') {
      if (held.phase !== 'ready' && held.phase !== 'stuck') return { text: `The run on ${held.ref} is ${held.phase}: no task is sent now.` }
      await want($, held.ref, 'next')
      await pumpBuild($, held.ref)

      return { text: `A builder is sent on the next task of ${held.ref}.` }
    }

    if (verb === 'commit') {
      const said = await resubmit($, held.ref)

      await pumpBuild($, held.ref)

      return { text: said }
    }

    if (verb === 'submit') {
      await want($, held.ref, 'submit')
      await pumpBuild($, held.ref)

      return { text: `The run on ${held.ref} makes ready to submit: the pane says how it went.` }
    }

    return { text: `/build knows start (no word, or --auto), errand <issue>, next, commit, submit, halt and abandon, each with a run's ref or branch; not ${verb}.` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const all = Object.values(await read($, quests)).sort((one, other) => other.at - one.at)
    const shown = await read($, selected)
    const held = all.find(one => one.ref === shown) ?? all[0] ?? null
    const said = await read($, notes)
    const doing = await read($, working)
    const queue = await read($, wanted)
    const cost = await read($, spent)
    // A press asks, then does it where it stands in a hook: where it does not, Claude is asked to call for it
    const press = async (ref: string, what: RunAsk) => {
      await want($, ref, what)
      await pumpBuild($, ref === '' ? undefined : ref)
    }
    const general = said[''] ?? ''
    const width = e.props.bodyColumns ?? 80

    if (held === null) {
      return view.keep(
        <Box flexDirection="column" gap={1}>
          {badge({ label: 'no run', tone: 'neutral' })}
          {queue.length > 0 && <Text dimColor>{`${queue[0]?.what ?? ''}…`}</Text>}
          {general !== '' && <Text color="warning">{general}</Text>}
          <Text dimColor>{HOW_TO}</Text>
          <Button key="start" hotkey="s" variant="primary" onPress={() => press('', 'start')}>
            {keyed('s', 'Start on the plan')}
          </Button>
        </Box>,
        width,
      )
    }

    const made = (await read($, plans))[held.ref] ?? null
    const out = held.current
    const laneOf = (id: number) => all.find(one => one.lane?.of === held.ref && one.lane.taskId === id)
    const commitOf = (id: number) => held.commits.find(one => one.taskId === id)
    const outTask = out === null || made === null ? undefined : made.tasks.find(task => task.id === out.taskId)
    const problem = said[held.ref] ?? ''
    const busyLine = doing[held.ref] ?? ''
    const asked = queue.find(one => one.ref === held.ref)
    const root = await paneRoot($)
    // A task's mark and number keep a column of their own: its title wraps under itself, and its last words are never cut
    const markWidth = String(Math.max(0, ...(made?.tasks ?? []).map(task => task.id))).length + 4
    const toneOf = (task: RunTask): string | undefined => {
      // A task out, here or in a lane, is drawn as where it stands
      const phase = out?.taskId === task.id ? held.phase : laneOf(task.id)?.phase

      return phase !== undefined ? (phase === 'stuck' ? 'error' : 'suggestion') : task.state === 'done' ? 'success' : task.state === 'asked' ? 'warning' : undefined
    }
    // What is said of a task after its title: its weight, and who built it, or who is on it
    const metaOf = (task: RunTask): string => {
      const commit = commitOf(task.id)

      const lane = laneOf(task.id)

      return [
        task.weight,
        commit !== undefined ? `${commit.by} ${commit.sha.slice(0, 7) || 'no change'}` : '',
        out?.taskId === task.id ? `${BUILDERS[out.builder].title}, ${held.phase}` : '',
        lane !== undefined ? `in a lane${lane.current !== null ? `: ${BUILDERS[lane.current.builder].title}` : ''}, ${lane.phase}` : '',
      ]
        .filter(part => part !== '')
        .join(' · ')
    }
    const isSailable = held.phase === 'built' || (held.kind === 'review' && held.phase !== 'submitted' && !OUT.includes(held.phase) && held.commits.length > 0)

    return view.keep(
      <Box flexDirection="column" gap={1}>
        {all.length > 1 && (
          <Box flexDirection="column">
            {all.map(one => {
              // A run kept by a session from before errands and reviews has no kind: it is a plan's, as runLeftovers takes it
              const kind = `${one.lane !== undefined ? 'lane' : (one.kind ?? 'plan')}${one.isAuto ? ' · auto' : ''}`

              return (
                <Button key={`run-${one.ref}`} plain onPress={() => update($, selected, () => one.ref)}>
                  {/* A plain Button draws its label alone: its mark and ref (3 more), the badge's dot (2 more), its kind between spaces, the title */}
                  {`${one.ref === held.ref ? '▸' : ' '} ${shortRef(one.ref)} `}
                  {badge({ label: one.phase, tone: PHASE_TONE[one.phase] })}
                  <Text dimColor>{` ${kind} `}</Text>
                  <Text>{clip(one.title, width - shortRef(one.ref).length - one.phase.length - kind.length - 7)}</Text>
                </Button>
              )
            })}
          </Box>
        )}
        <Box flexDirection="column">
          <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
            {badge({ label: held.phase, tone: PHASE_TONE[held.phase] })}
            {made !== null && badge({ label: tally(made), tone: isAllDone(made) ? 'success' : 'info' })}
            {held.isAuto && badge({ label: 'auto', tone: 'accent' })}
          </Box>
          <Text bold>{`${shortRef(held.ref)} ${held.title}`}</Text>
          <Text dimColor>{`${held.kind ?? 'plan'} · ${held.branch} ← ${held.base}`}</Text>
          {held.tree !== root && <Text dimColor wrap="truncate-start">{homePath(held.tree, root)}</Text>}
        </Box>
        {(busyLine !== '' || asked !== undefined || problem !== '' || general !== '') && (
          <Box flexDirection="column">
            {busyLine !== '' && <Text color="suggestion">{busyLine}</Text>}
            {asked !== undefined && busyLine === '' && <Text dimColor>{`${asked.what}…`}</Text>}
            {problem !== '' && <Text color="warning">{problem}</Text>}
            {general !== '' && <Text dimColor>{general}</Text>}
          </Box>
        )}
        {made !== null && (
          <Box flexDirection="column" borderStyle="round" paddingX={1}>
            {made.tasks.map(task => (
              <Box key={`task-${task.id}`} flexDirection="row">
                <Box width={markWidth} flexShrink={0}>
                  <Text color={toneOf(task)} dimColor={task.state === 'todo' && out?.taskId !== task.id}>{`${MARK[task.state]} ${task.id}.`}</Text>
                </Box>
                <Box flexDirection="column" flexGrow={1} flexShrink={1}>
                  <Text color={toneOf(task)} dimColor={task.state === 'todo' && out?.taskId !== task.id}>
                    {task.title}
                    <Text dimColor>{`  ${metaOf(task)}`}</Text>
                  </Text>
                  {task.note !== undefined && task.note !== '' && <Text color="warning">{task.note}</Text>}
                </Box>
              </Box>
            ))}
          </Box>
        )}
        {held.phase === 'writing-tests' && <Text color="suggestion">{`The test writer writes task ${held.testsFor ?? ''}'s tests first, red`}</Text>}
        {held.phase === 'reviewing-branch' && <Text color="suggestion">{`${WARDING} before it is submitted`}</Text>}
        {out === null && held.verdictLine.startsWith('the whole branch') && <Text color={held.isBranchReviewed === true ? 'success' : 'warning'}>{`The reviewers: ${held.verdictLine}`}</Text>}
        {out !== null && (
          <Box flexDirection="column" borderStyle="round" borderColor={held.phase === 'stuck' ? 'error' : undefined} paddingX={1}>
            <Text bold>{`${BUILDERS[out.builder].title} ${held.phase === 'stuck' ? 'is back from' : 'is on'} task ${out.taskId}: ${out.title}`}</Text>
            <Text dimColor>{`try ${out.attempt}${made !== null && outTask !== undefined ? ` of ${triesOf(made, outTask)}` : ''} · since ${clockOf(out.at)}`}</Text>
            {held.testsToPass !== undefined && held.testsToPass !== null && held.testsToPass.taskId === out.taskId && held.testsToPass.tests.length > 0 && <Text dimColor>{`The tests written first: ${held.testsToPass.tests.length} red ${held.testsToPass.tests.length === 1 ? 'test' : 'tests'} to make pass`}</Text>}
            {held.proofLine !== '' && <Text color={held.phase === 'reviewing' ? 'success' : 'warning'}>{`The proof: ${held.proofLine}`}</Text>}
            {held.verdictLine !== '' && <Text color={held.verdictLine.startsWith('passed') ? 'success' : held.verdictLine === 'reviewing' ? 'suggestion' : 'warning'}>{`The reviewers: ${held.verdictLine}`}</Text>}
          </Box>
        )}
        {(out === null || held.testsToPass?.taskId !== out.taskId) && held.testsToPass !== undefined && held.testsToPass !== null && held.testsToPass.tests.length > 0 && <Text dimColor>{`The tests written first: ${held.testsToPass.tests.length} red ${held.testsToPass.tests.length === 1 ? 'test' : 'tests'} for task ${held.testsToPass.taskId} to make pass`}</Text>}
        {held.pr !== '' && <Text color="success">{`Pull request: ${held.pr}`}</Text>}
        {cost[held.ref] !== undefined && <Text dimColor>{`Spent: ${cost[held.ref] ?? ''}`}</Text>}
        <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
          {(held.phase === 'ready' || held.phase === 'stuck') && (
            <Button key="next" hotkey="n" variant="primary" onPress={() => press(held.ref, 'next')}>
              {keyed('n', held.phase === 'stuck' ? 'Send again' : 'Send the next task')}
            </Button>
          )}
          {held.phase === 'stuck' && out !== null && (
            <Button key="commit" hotkey="c" onPress={() => resubmit($, held.ref).then(text => say($, held.ref, text)).then(() => pumpBuild($, held.ref))}>
              {keyed('c', 'Put it up for verification')}
            </Button>
          )}
          {isSailable && (
            <Button key="submit" hotkey="p" variant={held.phase === 'built' ? 'primary' : 'secondary'} onPress={() => press(held.ref, 'submit')}>
              {keyed('p', held.kind === 'review' ? 'Push the answers' : 'Push and open the pull request')}
            </Button>
          )}
          {held.phase !== 'submitted' && (
            <Button key="auto" hotkey="a" onPress={() => keep($, held.ref, was => ({ ...was, isAuto: !was.isAuto })).then(() => undefined)}>
              {keyed('a', held.isAuto ? '✓ Going on by itself' : 'Go on by itself')}
            </Button>
          )}
          {/* Runs on other issues run beside this one: the plan in force starts from here too */}
          <Button key="start" hotkey="s" onPress={() => press('', 'start')}>
            {keyed('s', 'Start on the plan')}
          </Button>
        </Box>
      </Box>,
      width,
    )
  })
}
