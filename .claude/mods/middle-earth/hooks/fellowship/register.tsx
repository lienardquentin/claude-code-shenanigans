import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { MiddleEarthAgent, FellowshipKind, FellowshipPhase, FellowshipPlan, FellowshipQuest, FellowshipTask, FellowshipTaskState, FellowshipWanted } from '../../types'
import {
  HOW_TO,
  MARK,
  MEMBERS,
  branchOf,
  commitMessage,
  companionPrompt,
  errandTask,
  forgeOf,
  handBackOf,
  isAllDone,
  memberFor,
  nextTask,
  ownPlan,
  parsePlan,
  parseWorktrees,
  prArgv,
  purposeOf,
  questLine,
  questText,
  reviewTasks,
  statueModelFor,
  tally,
  threadArgv,
  treePathOf,
  triesOf,
  unsettledOf,
  wardPurpose,
} from './quest'
import type { Retry } from './quest'
import { UNMODDED, errorText, git, isMergedFrom, openRequest, parseJudgement, proofVerdict, push, rootOf, run, secretsIn, sendBack, sendBackPrompt, toolFailed } from '../flow'
import type { Section, TurnEnded } from '../flow'
import { badge } from '../kit/badge'
import type { Tone } from '../kit/badge'
import { paneView } from '../kit/pane-text'
import { askToPump, inFrame, remember, spawnIn, typeOf } from '../agents'
import { markTask, planFor, readIssue, takeSetOut } from '../elrond/register'
import { gazeFor, mirrorIn } from '../lothlorien/register'
import { judgementFor, proveFor, standardsText, targetsKnown } from '../argonath/register'

type $ = EngineInterface
type On = Parameters<Register>[0]

const PANE = 'fellowship'
const TITLE = 'Fellowship'
// How often the clock looks for what a press, a command or a turn asked for
const TICK_MS = 500
// What is said while the statues judge a plan's whole branch
const WARDING = 'The statues judge the whole branch'
// Where a quest is kept across sessions, by its ref
const STORE_KEY = (ref: string) => `quest:${ref}`
// How long the forge is given to answer a fetch
const FETCH_TIMEOUT_MS = 120_000

const quests = atom({ plugin: 'middle-earth', key: 'fellowshipQuests' } as const, {} as Record<string, FellowshipQuest>)
const plans = atom({ plugin: 'middle-earth', key: 'fellowshipPlans' } as const, {} as Record<string, FellowshipPlan>)
const notes = atom({ plugin: 'middle-earth', key: 'fellowshipNotes' } as const, {} as Record<string, string>)
const working = atom({ plugin: 'middle-earth', key: 'fellowshipWorking' } as const, {} as Record<string, string>)
const wanted = atom({ plugin: 'middle-earth', key: 'fellowshipWanted' } as const, [] as { ref: string; what: FellowshipWanted; arg?: string }[])
const selected = atom({ plugin: 'middle-earth', key: 'fellowshipSelected' } as const, '')

export const fellowshipView = paneView({ id: PANE, title: TITLE, command: '/fellowship' })
const view = fellowshipView

const REF = { type: 'string', description: 'The quest, by its ref; the one the pane shows when left out.' } as const

const TOOLS = [
  {
    name: 'set_out',
    description:
      "Implements the Elrond plan in force (or resumes it) in a git worktree of its own under .fellowship/trees/, leaving the person's checkout alone: a builder subagent builds each task in turn, Argonath checks that an integration test pins each behaviour it changed, reviewer subagents review the change, and it is committed once they pass it. When every task is committed, the person opens the pull request with /fellowship sail, or it opens by itself with auto. It starts only once every question of the plan is answered and every risk decided; quests on other issues run beside it. Call it when the person asks to implement a planned issue.",
    inputSchema: {
      type: 'object',
      properties: {
        auto: { type: 'boolean', description: 'Go on by itself: send each task once the one before is committed, and open the pull request at the end. Only when the person asked for it in those words.' },
        ref: { type: 'string', description: "The plan of this issue, as Elrond spells it (`github:owner/repo#12`); the plan in force when left out." },
      },
    },
  },
  {
    name: 'errand',
    description:
      "Implements a small issue without a plan, as an errand: in a git worktree of its own, a builder subagent builds the whole issue in one change, Argonath checks its integration tests, a reviewer subagent reviews it, and it is committed; the pull request then waits for the person's go (or opens by itself with auto). The builder hands back an issue that needs a decision or more than one change, for /elrond to plan. Call it when the person asks for an issue to be done as an errand, or quickly without a plan.",
    inputSchema: { type: 'object', properties: { issue: { type: 'string', description: 'The issue: its URL, owner/repo#12, or #12 for this repository.' }, auto: { type: 'boolean', description: 'Open the pull request by itself once committed. Only when the person asked for it.' } }, required: ['issue'] },
  },
  {
    name: 'quest',
    description: "Where each quest the Fellowship is implementing stands: its phase, its worktree, the builder at work, the last test check and review, and each task with its commit.",
    inputSchema: { type: 'object', properties: { ref: { type: 'string', description: 'One quest, by its ref; every quest when left out.' } } },
  },
  {
    name: 'commit',
    description: "Checks and reviews the uncommitted change of a stuck task again, and commits it once the review passes it. Call it when the person has finished a stuck task by hand, in the quest's worktree, and asks to commit it.",
    inputSchema: { type: 'object', properties: { ref: REF } },
  },
  {
    name: 'next',
    description:
      "Sends a builder on the quest's next task, or on its stuck task again, from its first rung and on what its worktree holds, as /fellowship next does. Only for a quest that is ready or stuck. Call it when the person asks to go on with a quest, or to try a stuck task again.",
    inputSchema: { type: 'object', properties: { ref: REF } },
  },
] as const

const PHASE_TONE: Record<FellowshipPhase, Tone> = { ready: 'neutral', gazing: 'info', marching: 'info', proving: 'info', judging: 'info', stuck: 'danger', arrived: 'accent', warding: 'info', sailed: 'success' }

// The phases a quest waits in on something that is out: a member, the Mirror, the proof or the statues
const OUT: readonly FellowshipPhase[] = ['gazing', 'marching', 'proving', 'judging', 'warding']

async function questOf($: $, ref: string): Promise<FellowshipQuest | null> {
  return (await read($, quests))[ref] ?? null
}

/** Changes a quest, and keeps it across sessions. Answers it as it now stands; nothing when no quest is on the ref. */
async function keep($: $, ref: string, change: (was: FellowshipQuest) => FellowshipQuest): Promise<FellowshipQuest | null> {
  // Set inside the update: typed wide, as the narrowing does not follow it there
  let made = null as FellowshipQuest | null

  // The change is made once, on the quest as it stands when it is written, and what is kept across sessions is that
  await update($, quests, held => {
    const was = held[ref]

    if (was === undefined) return held

    made = change(was)

    return { ...held, [ref]: made }
  })

  if (made !== null) {
    const kept: FellowshipQuest = made

    await $.store.set(STORE_KEY(ref), kept).catch(async (error: unknown) => {
      const why = `${ref} could not be kept for the next session: ${errorText(error)}`

      $.ui.toast(`Fellowship: ${why}`)
      await update($, notes, all => ({ ...all, [ref]: why }))
    })
  }

  return made
}

/** Lays a quest down: no longer under way here, and kept across sessions no more. */
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

async function want($: $, ref: string, what: FellowshipWanted, arg?: string): Promise<void> {
  await update($, wanted, was => [...was, { ref, what, ...(arg !== undefined ? { arg } : {}) }])
}

async function tell($: $, text: string): Promise<void> {
  $.ui.toast(`Fellowship: ${text}`)
  await $.ui.notify(text, { title: 'Fellowship' }).catch(() => undefined)
}

/**
 * The work of a quest, read afresh and kept for the pane: a plan's from Elrond, by its issue; an errand's or a review's
 * from the tasks it keeps. A sentence when it could not be read.
 */
async function workOf($: $, held: FellowshipQuest): Promise<FellowshipPlan | string> {
  let made: FellowshipPlan | null | string

  made = held.kind === 'plan' ? parsePlan(await planFor($, held.ref)) : ownPlan(held)

  if (made === null) return `Elrond keeps no plan of ${held.ref} any more.`
  if (typeof made === 'string') return made

  const kept = made

  await update($, plans, was => ({ ...was, [held.ref]: kept }))

  return kept
}

/** Marks a task of a quest: in Elrond for a plan, in the quest itself for any other. */
async function mark($: $, held: FellowshipQuest, id: number, state: FellowshipTaskState, note?: string): Promise<void> {
  // Elrond keeps no `asked`: a plan's task is handed back as it stands
  if (held.kind === 'plan') {
    if (state !== 'asked') await markTask($, id, state, held.ref)

    return
  }

  await keep($, held.ref, was => ({ ...was, tasks: (was.tasks ?? []).map(task => (task.id === id ? { ...task, state, ...(note !== undefined ? { note } : {}) } : task)) }))
}

/** Every quest kept, here or across sessions: what Mount Doom watches. */
export async function questRelics($: $): Promise<{ ref: string; kind: FellowshipKind; branch: string; base: string; tree: string; pr: string; phase: string }[]> {
  const kept = Object.values(await read($, quests))

  for (const key of (await $.store.keys().catch(() => [])).filter(one => one.startsWith('quest:'))) {
    const one = (await $.store.get(key).catch(() => undefined)) as FellowshipQuest | undefined

    if (one !== undefined && one !== null && !kept.some(was => was.ref === one.ref)) kept.push(one)
  }

  return kept.map(({ ref, kind, branch, base, tree, pr, phase }) => ({ ref, kind: kind ?? 'plan', branch, base, tree: tree ?? '', pr, phase }))
}

/** Forgets a quest whose pull request is merged from its branch, here and across sessions. Its worktree is Mount Doom's to clear. */
export async function forgetQuest($: $, ref: string, pr: string): Promise<{ forgotten: boolean; text: string }> {
  const found = (await questRelics($)).find(one => one.ref === ref)

  if (found === undefined) return { forgotten: false, text: `No quest on ${ref} is kept.` }
  if (!(await isMergedFrom($, pr, found.branch))) return { forgotten: false, text: `${pr} is not a merged pull request from ${found.branch}: the quest on ${ref} is kept.` }

  await drop($, ref)

  return { forgotten: true, text: `The quest on ${ref} is forgotten.` }
}

/** The branch the person's checkout is on, else the remote's default, else main: what a quest sets out from. */
async function baseOf($: $, root: string, branch: string): Promise<string> {
  const current = await git($, ['rev-parse', '--abbrev-ref', 'HEAD'], root)

  if (current.ok && current.out !== '' && current.out !== 'HEAD' && current.out !== branch) return current.out

  const found = await git($, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], root)

  return found.ok && found.out !== '' ? found.out.replace(/^origin\//, '') : 'main'
}

/**
 * Where a quest is built: the folder its branch is checked out in already (a worktree, or the person's own checkout),
 * else a worktree made for it under .fellowship/trees, its branch made from its base when there is none. A review's
 * branch is the pull request's, fetched from the forge. Answers why there is none where it could not be made.
 */
async function placeTree($: $, branch: string, base: string | undefined, isFetched: boolean): Promise<{ tree: string; base: string } | string> {
  const root = await rootOf($)
  const from = base ?? (await baseOf($, root, branch))
  const at = parseWorktrees((await git($, ['worktree', 'list', '--porcelain'], root)).out).find(one => one.branch === branch)

  if (at !== undefined) return { tree: at.path, base: from }

  const tree = treePathOf(root, branch)

  // The folder ignores itself: no quest's worktree is part of the project's checkout
  await $.fs.write(`${root}/.fellowship/.gitignore`, '*\n').catch(() => undefined)

  const fetched = isFetched ? await run($, ['git', 'fetch', 'origin', branch], FETCH_TIMEOUT_MS, root) : undefined
  const exists = await git($, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], root)

  // A review's branch lives on origin; one that is not there is a fork's, which the Fellowship cannot push to
  if (fetched !== undefined && !fetched.ok && !exists.ok) return `${branch} could not be fetched from origin (${fetched.out || 'git said nothing'}): a pull request from a fork is not answered here, as its branch cannot be pushed to from this repository.`

  const added = await git($, exists.ok || isFetched ? ['worktree', 'add', tree, branch] : ['worktree', 'add', '-b', branch, tree, from], root)

  return added.ok ? { tree, base: from } : `The worktree of ${branch} could not be made at ${tree}: ${added.out}`
}

/**
 * Takes in what its base gained since the quest left it, so the tasks still to come are built on it and its pull
 * request does not fall into conflict. A worktree with work in it is only said to be behind; a merge that conflicts is
 * taken back. Answers what stops the quest, or undefined when it may go on.
 */
async function followBase($: $, held: FellowshipQuest): Promise<string | undefined> {
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
    // The merge is no member's commit: a task sent again after it is judged against HEAD as it now stands
    await keep($, held.ref, was => ({ ...was, march: was.march === null ? null : { ...was.march, head: '' } }))
    await say($, held.ref, `${held.branch} took in what ${upstream} gained since it left it.`)

    return undefined
  }

  const conflicted = (await git($, ['diff', '--name-only', '--diff-filter=U'], held.tree)).out.split('\n').filter(line => line !== '')

  await git($, ['merge', '--abort'], held.tree)

  return `${held.branch} cannot take in ${upstream}: it conflicts in ${conflicted.join(', ') || 'the tree'}. Merge it in ${held.tree} by hand, then go on.`
}

// The config by which a git command runs code of the repository's: its hooks, its filters, what it includes, what it
// watches the tree with. A builder's change can set none of it (the config is outside its worktree, `git config` is
// refused it), so a commit made after it changed was not the person's to make
const GIT_RUNS = '^(core\\.(hookspath|fsmonitor|sshcommand|attributesfile)|include(if)?\\..*|filter\\..*|diff\\..*\\.(command|textconv))$'

/** What git's config says of the code a git command run in a folder would run. */
async function gitRunsIn($: $, tree: string): Promise<string> {
  // None of it set is no error: git answers 1, and nothing
  return (await git($, ['config', '--show-origin', '--get-regexp', GIT_RUNS], tree)).out
}

/**
 * Why the mod may not commit in a quest's worktree: git's config of the code a commit runs changed since the quest set
 * out, or the change touches the hooks the commit would run; nothing when it may. A builder's code is run by the mod's
 * own commit, outside the guard, only through these.
 */
async function commitRefusal($: $, held: FellowshipQuest): Promise<string | undefined> {
  const runs = await gitRunsIn($, held.tree)

  if (held.gitRuns !== undefined && runs !== held.gitRuns) return `git's config of what a commit runs (hooks, filters, includes) changed in ${held.tree} since the quest set out, so its commit is not made: look at \`git config --show-origin --get-regexp '${GIT_RUNS}'\` there, and once it is as it should be, put the task before the Argonath again.`

  const hooks = (await git($, ['rev-parse', '--path-format=absolute', '--git-path', 'hooks'], held.tree)).out
  const touched = hooks.startsWith(`${held.tree}/`) ? (await git($, ['status', '--porcelain', '--', hooks], held.tree)).out : ''

  return touched === '' ? undefined : `The change touches the git hooks its own commit would run (${hooks}), so it is not committed by the mod: look at them, and commit it by hand if they are as they should be.`
}

/** What a quest is set out on: what it is, and the branch it is built on. */
type Spec ={ kind: FellowshipKind; ref: string; url: string; title: string; branch: string; base?: string; isAuto: boolean; tasks?: FellowshipTask[]; pr?: string }

/**
 * Sets a quest out, or takes it up where it was left: in its worktree, its first task sent by the clock, outside the
 * call that asked. Answers what was done, in a sentence.
 */
async function begin($: $, spec: Spec, made: FellowshipPlan): Promise<string> {
  const held = (await questOf($, spec.ref)) ?? ((await $.store.get(STORE_KEY(spec.ref)).catch(() => undefined)) as FellowshipQuest | undefined) ?? null

  if (held !== null && held.phase !== 'sailed' && (held.kind ?? 'plan') !== spec.kind) return `The Fellowship is on ${spec.ref} already, as ${held.kind === 'errand' ? 'an errand' : `a ${held.kind}`} (${held.phase}): finish or abandon it first.`

  const resumed = held !== null && held.phase !== 'sailed' ? held : undefined
  const branch = resumed?.branch ?? spec.branch
  const placed = await placeTree($, branch, resumed?.base ?? spec.base, spec.kind === 'review')

  if (typeof placed === 'string') return placed

  // A quest left mid-march has no member out any more, and the statues no longer judge its whole branch: the person
  // sends it again, or sails again
  const was = resumed?.phase
  const phase: FellowshipPhase = was === undefined ? 'ready' : was === 'gazing' || was === 'marching' || was === 'proving' || was === 'judging' ? 'stuck' : was === 'warding' ? 'arrived' : was
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
  const quest: FellowshipQuest = {
    kind: spec.kind,
    ref: spec.ref,
    url: spec.url,
    title: spec.title,
    branch,
    base: placed.base,
    tree: placed.tree,
    ...(tasks !== undefined ? { tasks } : {}),
    isAuto: spec.isAuto,
    // Every task behind it, it has arrived; a review handed over again with new comments has more to build
    phase: isAllDone(work) ? (phase === 'ready' || phase === 'stuck' ? 'arrived' : phase) : phase === 'arrived' ? 'ready' : phase,
    march: resumed?.march ?? null,
    proof: resumed?.proof ?? '',
    proofLine: resumed?.proofLine ?? '',
    verdictLine: resumed?.verdictLine ?? '',
    vision: resumed?.vision ?? null,
    gazed: resumed?.gazed,
    commits: resumed?.commits ?? [],
    pr: resumed?.pr ?? spec.pr ?? '',
    gitRuns: resumed?.gitRuns ?? (await gitRunsIn($, placed.tree)),
    at: resumed?.at ?? Date.now(),
  }

  await update($, quests, was => ({ ...was, [spec.ref]: quest }))
  await update($, plans, was => ({ ...was, [spec.ref]: work }))
  await $.store.set(STORE_KEY(spec.ref), quest).catch(() => undefined)
  await update($, selected, () => spec.ref)
  await say($, spec.ref, '')
  await $.ui.open({ id: PANE, title: TITLE }).catch(() => undefined)

  // A quest taken up again first takes in what its base gained meanwhile: the tasks still to come are built on it
  const behind = resumed !== undefined ? await followBase($, quest) : undefined

  if (behind !== undefined) {
    await keep($, spec.ref, was => ({ ...was, phase: 'stuck' }))
    await say($, spec.ref, behind)

    return `The Fellowship takes up its quest on ${spec.ref}, but stops: ${behind}`
  }

  if (quest.phase === 'ready') await want($, spec.ref, 'next')
  if (quest.phase === 'arrived' && quest.isAuto && quest.kind !== 'review') await want($, spec.ref, 'sail')

  const how =spec.isAuto ? 'going on by itself' : 'stopping after each commit for you'
  const where = placed.tree === (await rootOf($)) ? 'in your own checkout, where its branch is' : `in its worktree ${placed.tree}`

  return resumed !== undefined
    ? `The Fellowship takes up its quest on ${spec.ref} (${tally(work)}, ${quest.phase}) on ${branch}, ${where}, ${how}.`
    : `The Fellowship sets out on ${spec.ref}, "${spec.title}", on ${branch} from ${placed.base}, ${where}, ${how}: the first task is sent.`
}

/** Sets out on the Elrond plan in force, or the one of the issue named. */
async function setOut($: $, isAuto: boolean, ref = ''): Promise<string> {
  const made = parsePlan(await planFor($, ref))

  if (made === null) return HOW_TO
  if (typeof made === 'string') return made

  const open = unsettledOf(made)

  if (open.length > 0) return `The council's work on ${made.ref} is not settled: ${open.join('; ')}. Settle them in the Elrond pane, then set out.`

  return begin($, { kind: 'plan', ref: made.ref, url: made.url, title: made.title, branch: branchOf(made), isAuto }, made)
}

/**
 * Sets out on an issue as an errand: one task, the whole issue, read through Elrond. One opened from outside the
 * repository is built only when the person asked for it themselves (`isPersons`): Claude's call may have been steered.
 */
async function errand($: $, input: string, isAuto: boolean, isPersons: boolean): Promise<string> {
  const issue = await readIssue($, input)

  if ('error' in issue) return issue.error
  if (issue.isOutside && !isPersons) return `${issue.ref} was opened by ${issue.author || 'someone'}, from outside the repository (or the forge could not say who can push to it): only the person sets out on it, with /fellowship errand ${issue.ref} or from the Rings.`

  const task = errandTask(issue)
  const spec: Spec = { kind: 'errand', ref: issue.ref, url: issue.url ?? '', title: issue.title ?? '', branch: branchOf({ ref: issue.ref, title: issue.title ?? '' }), isAuto, tasks: [task] }

  return begin($, spec, ownPlan(spec))
}

/**
 * Sets out on an issue as an errand from a press of another part's pane: the press asks, and the clock sets it out,
 * as setting out sends no agent; its first member waits for a hook.
 */
export async function askErrand($: $, issue: string): Promise<void> {
  await want($, '', 'errand', issue)
  await $.ui.open({ id: PANE, title: TITLE }).catch(() => undefined)
}

/** Takes up the review comments the Black Gate handed over, on the pull request's own branch. Answers what was done, in a sentence. */
export async function takeReview($: $, given: unknown, isAuto: boolean): Promise<string> {
  const pr = (typeof given === 'object' && given !== null ? given : {}) as { ref?: unknown; url?: unknown; title?: unknown; branch?: unknown; base?: unknown; comments?: unknown }
  const tasks = reviewTasks(pr.comments)

  if (typeof pr.ref !== 'string' || typeof pr.branch !== 'string' || pr.branch === '') return 'A review is handed over with its pull request (ref, branch) and its comments.'
  if (tasks.length === 0) return `No comment of ${pr.ref} asks for a change: there is nothing to build.`

  const ref = pr.ref.startsWith('review:') ? pr.ref : `review:${pr.ref}`
  const spec: Spec = { kind: 'review', ref, url: typeof pr.url === 'string' ? pr.url : '', title: typeof pr.title === 'string' ? pr.title : '', branch: pr.branch, base: typeof pr.base === 'string' && pr.base !== '' ? pr.base : undefined, isAuto, tasks, pr: typeof pr.url === 'string' ? pr.url : '' }
  const said = await begin($, spec, ownPlan(spec))

  // The first comment's member is sent here when the Black Gate hands it over from a hook; from the clock, at the next
  await pumpFellowship($, ref)

  return said
}

/** Sends a member on a task: marked doing, chosen by the try and the task, and spawned in the quest's worktree. */
async function march($: $, held: FellowshipQuest, made: FellowshipPlan, task: FellowshipTask, attempt: number, retry?: Retry): Promise<void> {
  const member = memberFor(made, task, attempt, await targetsKnown($).catch(() => []))
  const last = held.march
  // A task sent again keeps HEAD as it was when it was first sent: a commit made past the proof since stays one
  const head = last !== null && last.taskId === task.id && last.head !== undefined && last.head !== '' ? last.head : (await git($, ['rev-parse', 'HEAD'], held.tree)).out

  await mark($, held, task.id, 'doing')

  const started = await spawnIn($, { subagentType: typeOf(member), description: `${MEMBERS[member].title}: task ${task.id}, ${task.title}`, prompt: companionPrompt(held, made, task, member, retry, held.vision, await standardsText($)), cwd: held.tree })
    .catch((error: unknown) => ({ deny: errorText(error), agentId: undefined }))

  if (started.deny !== undefined) {
    await keep($, held.ref, was => ({ ...was, phase: 'stuck', march: null }))
    await say($, held.ref, `${MEMBERS[member].title} could not be sent on task ${task.id}: ${started.deny}`)

    return
  }

  if (started.agentId !== undefined && started.agentId !== '') await remember($, started.agentId, { role: 'member', root: await rootOf($), tree: held.tree, files: [...task.files] })

  await keep($, held.ref, was => ({ ...was, phase: 'marching', verdictLine: '', march: { taskId: task.id, title: task.title, member, agentId: started.agentId ?? '', attempt, at: Date.now(), answer: '', head, isResumed: false } }))
  await say($, held.ref, '')
}

/** What a quest comes to once every task is behind it: arrived, and on an auto quest that is no review, sailing. */
async function arrive($: $, held: FellowshipQuest): Promise<void> {
  await keep($, held.ref, was => ({ ...was, phase: 'arrived', march: null }))

  if (held.isAuto && held.kind !== 'review') await want($, held.ref, 'sail')
  else await tell($, `every task of ${held.ref} is behind it: ${held.kind === 'review' ? 'push the answers' : 'open the pull request'} from the pane`)
}

/** Sends the next task, or finds the quest arrived. A stuck task is sent again from its first rung, on what the tree holds. */
async function sendNext($: $, ref: string): Promise<void> {
  const held = await questOf($, ref)

  if (held === null || (held.phase !== 'ready' && held.phase !== 'stuck')) return

  const made = await workOf($, held)

  if (typeof made === 'string') return say($, ref, made)
  if (isAllDone(made)) return arrive($, held)

  const task = nextTask(made)

  if (task === undefined) {
    await keep($, ref, was => ({ ...was, phase: 'stuck' }))
    await say($, ref, `No task of ${ref} is ready: what is left depends on a task that is not done.`)

    return
  }

  // A plan's task that is not light is shown first in the Mirror: Galadriel writes its tests, red, before anyone builds it
  if (held.kind === 'plan' && task.weight !== 'light' && held.gazed !== task.id) return gazeOn($, held, made, task)

  const last = held.march?.taskId === task.id ? held.march : null
  const retry: Retry | undefined = last === null || held.proof === '' ? undefined : { attempt: 1, by: MEMBERS[last.member].title, answer: last.answer, proof: held.proof }

  await work($, ref, `Sending a member on task ${task.id}…`)
  await march($, held, made, task, 1, retry)
}

/** Has Galadriel write a task's tests first, in the quest's worktree. Where Lothlórien does not answer, the task is built without them. */
async function gazeOn($: $, held: FellowshipQuest, made: FellowshipPlan, task: FellowshipTask): Promise<void> {
  await work($, held.ref, `Galadriel gazes on task ${task.id}…`)

  const sent = await gazeFor($, purposeOf(held, made, task), held.ref, task.weight, held.tree).catch((error: unknown) => errorText(error))

  if (!/gazes/.test(sent)) {
    const after = await keep($, held.ref, was => ({ ...was, gazed: task.id, vision: null }))

    await say($, held.ref, `The Mirror did not answer (${sent.slice(0, 160)}): task ${task.id} is built without tests first.`)
    if (after !== null) await march($, after, made, task, 1)

    return
  }

  await keep($, held.ref, was => ({ ...was, phase: 'gazing', gazed: task.id, vision: null, march: null }))
}

/** Looks into the Mirror while Galadriel gazes: once she has shown the tests, or that there are none, the task is built. */
async function behold($: $, ref: string): Promise<void> {
  const held = await questOf($, ref)

  if (held === null || held.phase !== 'gazing') return

  const shown: { state?: string; tests?: { file: string; name: string }[]; red?: string; why?: string } = await mirrorIn($, held.tree).catch((error: unknown) => ({ state: 'unreadable', why: errorText(error).slice(0, 200) }))

  if (shown.state === 'gazing') return

  const made = await workOf($, held)
  const task = typeof made === 'string' ? undefined : made.tasks.find(one => one.id === held.gazed)

  if (typeof made === 'string' || task === undefined) {
    await keep($, ref, was => ({ ...was, phase: 'stuck' }))
    await say($, ref, `The task the Mirror showed is not in the plan of ${ref} any more.`)

    return
  }

  if (shown.state === 'clouded' || shown.state === 'unreadable') {
    await keep($, ref, was => ({ ...was, phase: 'stuck', gazed: undefined }))
    await say($, ref, `The Mirror is clouded on task ${task.id}: ${shown.why ?? ''}. Send it again, and Galadriel gazes anew.`)
    await tell($, `the Mirror is clouded on task ${task.id} of ${ref}`)

    return
  }

  const vision = shown.state === 'shown' ? { taskId: task.id, tests: shown.tests ?? [], red: shown.red ?? '' } : null
  const after = await keep($, ref, was => ({ ...was, phase: 'ready', vision }))

  if (shown.state === 'empty') await say($, ref, `Nothing to test first in task ${task.id}: ${shown.why ?? ''}`)
  await work($, ref, `Sending a member on task ${task.id}…`)
  if (after !== null) await march($, after, made, task, 1)
}

/**
 * Sends the task up a rung after a try that did not pass, with what stopped it; or, when Gandalf has tried it, stops
 * the quest for the person.
 */
async function again($: $, ref: string, why: { proof?: string; findings?: string[] }, line: string): Promise<void> {
  const held = await questOf($, ref)
  const out = held?.march

  if (held === null || out === null || out === undefined) return

  // A proof that does not settle the change, or findings that block it, send its member back once, with all it read
  // and did still in its context, before a fresh member a rung up starts over cold
  if (out.isResumed !== true && (await sendBack($, out.agentId, typeOf(out.member), sendBackPrompt(why)))) {
    await keep($, ref, was => ({ ...was, phase: 'marching', march: { ...out, isResumed: true, answer: '' } }))
    await say($, ref, `${MEMBERS[out.member].title} is sent back to task ${out.taskId} with ${why.findings !== undefined ? 'the findings' : 'the proof'}: ${line}`)

    return
  }

  const made = await workOf($, held)
  const task = typeof made === 'string' ? undefined : made.tasks.find(one => one.id === out.taskId)

  if (typeof made !== 'string' && task !== undefined && out.attempt < triesOf(made, task)) return march($, held, made, task, out.attempt + 1, { attempt: out.attempt + 1, by: MEMBERS[out.member].title, answer: out.answer, ...why })

  await stop($, held, `Task ${out.taskId} did not pass after ${out.attempt} ${out.attempt === 1 ? 'try' : 'tries'}, the last ${MEMBERS[out.member].title}'s: ${line}. Finish it by hand in ${held.tree} and commit it from the pane, or send it again.`)
}

/**
 * Why the change in the tree cannot be taken as the task's: HEAD moved since the task was first sent, so a commit was
 * made past the proof and the statues. Nothing when it did not.
 */
async function headMoved($: $, held: FellowshipQuest): Promise<string | undefined> {
  const out = held.march

  if (out === null || out.head === undefined || out.head === '') return undefined

  const now = (await git($, ['rev-parse', 'HEAD'], held.tree)).out

  return now === out.head
    ? undefined
    : `HEAD moved from ${out.head.slice(0, 7)} to ${now.slice(0, 7)} while task ${out.taskId} was out: a commit was made past the Argonath's proof and its statues. Put it back as uncommitted work (git reset --soft ${out.head.slice(0, 7)} in ${held.tree}), then put it before the Argonath again.`
}

/** Stops a quest for the person, saying why. */
async function stop($: $, held: FellowshipQuest, why: string): Promise<void> {
  await keep($, held.ref, was => ({ ...was, phase: 'stuck' }))
  await say($, held.ref, why)
  await tell($, `${held.ref} is stuck: ${why.split('\n')[0] ?? why}`)
}

/** Proves what a member built: settled, the statues of the Argonath are sent to judge it; else the task goes up a rung. */
async function prove($: $, ref: string): Promise<void> {
  const held = await questOf($, ref)

  if (held === null || held.phase !== 'proving' || held.march === null) return

  const out = held.march
  const moved = await headMoved($, held)

  if (moved !== undefined) return stop($, held, moved)

  await work($, ref, `Argonath proves task ${out.taskId}…`)

  // The statues are convened here, on the change and what it is for: the proof owes none at the turn's end. Galadriel's
  // tests, written from the task before it was built, must pass for the proof to settle
  const written = held.vision?.taskId === out.taskId ? (held.vision?.tests ?? []) : []
  const verdict = proofVerdict(await proveFor($, held.tree, written).catch((error: unknown) => `Argonath could not prove the change: ${errorText(error)}`))

  await keep($, ref, was => ({ ...was, proof: verdict.text, proofLine: verdict.line, unproven: verdict.unhandled }))

  // Argonath could not look at what the change reached: no member mends that, and no try is spent on it
  if (verdict.isUnlooked) return stop($, held, `${verdict.line}. No member can mend that: set the target right in .claude/argonath, then put task ${out.taskId} before the Argonath again.`)
  if (!verdict.isSettled) return again($, ref, { proof: verdict.text }, verdict.line)

  const mirror = held.vision?.taskId === out.taskId ? await mirrorOf($, held) : { amendments: [], tampered: [] }

  // What was taken out of Galadriel's tests without a reason blocks the change, as a finding would
  if (mirror.tampered.length > 0) {
    const findings = mirror.tampered.map(one => `- Lothlórien, ${one.file}: locked lines of Galadriel's tests were taken out with no reason given (${one.lines.slice(0, 2).map(line => `\`${line.trim()}\``).join(', ')}). Put them back, or call mcp__middle-earth__amend with the file and why before changing them.`)

    return again($, ref, { findings }, `${findings.length} of Galadriel's test ${findings.length === 1 ? 'file' : 'files'} changed with no reason`)
  }

  await work($, ref, `The statues of the Argonath are sent to judge task ${out.taskId}…`)

  const made = await workOf($, held)
  const task = typeof made === 'string' ? undefined : made.tasks.find(one => one.id === out.taskId)
  const about = typeof made === 'string' || task === undefined ? '' : purposeOf(held, made, task, mirror.amendments)
  // Both statues judge every change: a task's weight is the council's guess, and what a change lets in is known only
  // once it is made. Where nothing proves what it reached, they judge with their own model; else as the task's weight
  // and risks ask, a task that is not heavy on a lighter model
  const isBlind = typeof made === 'string' || task === undefined || verdict.unhandled.length > 0
  const model = isBlind ? undefined : statueModelFor(made, task)
  const judged = parseJudgement(await judgementFor($, held.tree, { convene: true, about, statues: ['isildur', 'anarion'], ...(model !== undefined ? { model } : {}) }).catch((error: unknown) => errorText(error)))

  await keep($, ref, was => ({ ...was, phase: 'judging', verdictLine: judged.line }))
  await settle($, ref, judged)
}

/** What a member changed of Galadriel's tests and why, and what was taken out of them with no reason, as Lothlórien keeps it. */
async function mirrorOf($: $, held: FellowshipQuest): Promise<{ amendments: { file: string; why: string; by: string }[]; tampered: { file: string; lines: string[] }[] }> {
  const shown = await mirrorIn($, held.tree).catch(() => undefined)

  return { amendments: shown?.amendments ?? [], tampered: shown?.tampered ?? [] }
}

/** Looks at the statues' judgement of a quest's change, while they sit. */
async function judge($: $, ref: string): Promise<void> {
  const held = await questOf($, ref)

  if (held === null || held.phase !== 'judging') return

  await settle($, ref, parseJudgement(await judgementFor($, held.tree).catch((error: unknown) => errorText(error))))
}

/** What the statues' verdict comes to: committed when they pass the change, sent back up a rung when they find what blocks it. */
async function settle($: $, ref: string, judged: ReturnType<typeof parseJudgement>): Promise<void> {
  const held = await keep($, ref, was => (was.phase === 'judging' ? { ...was, verdictLine: judged.line } : was))

  if (held === null || held.phase !== 'judging' || held.march === null) return

  const out = held.march

  if (judged.verdict === 'sitting') return
  if (judged.verdict === 'pass') return void (await commitNow($, ref, judged.minor))
  if (judged.verdict === 'fail') return again($, ref, { findings: judged.blocking }, judged.line)

  // The change moved while they sat, or they never sat on it: it is proved and judged afresh
  if (judged.verdict === 'stale' || judged.verdict === 'unsettled' || judged.verdict === 'none') {
    await keep($, ref, was => ({ ...was, phase: 'proving' }))
    await want($, ref, 'prove')

    return
  }

  await stop($, held, `The statues could not judge task ${out.taskId}: ${judged.line}. Commit it once they can, or send it again.`)
}

/** Commits the change the statues passed as the task's own, and goes on. Answers what was done, in a sentence. */
async function commitNow($: $, ref: string, minor: readonly string[]): Promise<string> {
  const held = await questOf($, ref)

  if (held === null || held.march === null) return 'There is nothing to commit.'

  const out = held.march
  const made = await workOf($, held)
  const task = typeof made === 'string' ? undefined : made.tasks.find(one => one.id === out.taskId)

  if (task === undefined || typeof made === 'string') {
    await keep($, ref, was => ({ ...was, phase: 'stuck' }))

    return `Task ${out.taskId} is not in the work of ${ref} any more: ${typeof made === 'string' ? made : 'set out again.'}`
  }

  // The statues judged the change against HEAD as it was sent: a commit made since was judged by no one
  const moved = await headMoved($, held)

  if (moved !== undefined) {
    await stop($, held, moved)

    return moved
  }

  await work($, ref, `Committing task ${task.id}…`)

  const by = MEMBERS[out.member].title
  const unproven = held.unproven ?? []
  // What the mods keep in the tree (Andúril's builds, the Argonath's trees) is none of the change
  const dirty = await git($, ['status', '--porcelain', ...UNMODDED], held.tree)
  let sha = ''

  // An errand is the whole issue in one change: none at all means it was built somewhere else, or not at all
  if (dirty.out === '' && held.kind === 'errand') {
    const why = `${by} left no change in ${held.tree} for ${ref}: it is not done. Look at what it says it built, then send it again.`

    await stop($, held, why)

    return why
  }

  // A task that needed no change is done with no commit
  if (dirty.out !== '') {
    const refused = await commitRefusal($, held)

    if (refused !== undefined) {
      await stop($, held, refused)

      return refused
    }

    const added = await git($, ['add', '-A', ...UNMODDED], held.tree)
    // What is staged is read for secrets before it is committed: a secret in a commit outlives the commit
    const staged = added.ok ? await git($, ['diff', '--cached', '--no-color', '--no-ext-diff'], held.tree) : added
    const leaked = staged.ok ? secretsIn(staged.out) : []

    if (staged.ok && leaked.length > 0) {
      await git($, ['reset', '-q'], held.tree)

      const why = `Task ${task.id}'s change adds what looks like a secret (${leaked.join('; ')}), so it is not committed: take it out of ${held.tree}, then put the task before the Argonath again.`

      await stop($, held, why)

      return why
    }

    const done = staged.ok ? await git($, ['commit', '-m', commitMessage(held, made, task, by, minor, unproven)], held.tree) : staged

    if (!done.ok) {
      await stop($, held, `Task ${task.id} could not be committed: ${done.out}`)

      return `Task ${task.id} could not be committed: ${done.out}`
    }

    sha = (await git($, ['rev-parse', 'HEAD'], held.tree)).out
  }

  await mark($, held, task.id, 'done')

  const after = await keep($, ref, was => ({ ...was, phase: 'ready', march: null, vision: null, proof: '', proofLine: '', verdictLine: '', unproven: [], isWarded: false, commits: [...was.commits, { taskId: task.id, title: task.title, sha, by, minor: [...minor], unproven: [...unproven], answer: out.answer, proof: was.proofLine, ...(out.isPutBefore === true ? { isPutBefore: true } : {}) }] }))
  const left = after === null ? made : await workOf($, after)
  const isArrived = typeof left !== 'string' && isAllDone(left)
  const said = `Task ${task.id} of ${ref}, "${task.title}", built by ${by}, passed the Argonath and is committed${sha === '' ? ' (it changed nothing, so it is marked done with no commit)' : ` as ${sha.slice(0, 7)}`}.`

  if (isArrived || after?.isAuto === true) await want($, ref, 'next')
  else await tell($, `${said} The next task waits for you.`)

  return said
}

/** Puts a stuck task's change before the Argonath again: proved, judged, and committed once the statues pass it. */
async function resubmit($: $, ref: string): Promise<string> {
  const held = await questOf($, ref)

  if (held === null) return HOW_TO
  if (held.march === null || held.phase !== 'stuck') return `There is nothing to put before the Argonath: the quest on ${ref} is ${held.phase}.`

  // The person puts it there having looked: git's config as it now stands is theirs
  const gitRuns = await gitRunsIn($, held.tree)

  await keep($, ref, was => ({ ...was, phase: 'proving', gitRuns, march: was.march === null ? null : { ...was.march, isPutBefore: true } }))
  await want($, ref, 'prove')

  return `Task ${held.march.taskId}'s change goes before the Argonath: it is proved, judged by the statues, and committed once they pass it.`
}

/** What a quest that is out waits on before it may be abandoned; nothing when it waits on nothing. */
const waitBeforeAbandon = (held: FellowshipQuest): string | undefined =>
  OUT.includes(held.phase)
    ? `The quest on ${held.ref} is ${held.phase}: wait until ${held.phase === 'gazing' ? 'Galadriel has shown the tests' : held.phase === 'judging' || held.phase === 'warding' ? 'the statues have judged' : held.phase === 'proving' ? 'the proof is made' : `${held.march === null ? 'the member' : MEMBERS[held.march.member].title} is back`}, then abandon it.`
    : undefined

/**
 * Gives a quest up: its worktree removed, its own branch deleted (a review's is the pull request's, and is left), a
 * plan's tasks reopened in Elrond, and the quest forgotten here and across sessions. Nothing on the forge is touched.
 */
async function abandon($: $, ref: string): Promise<string> {
  const held = (await questOf($, ref)) ?? ((await $.store.get(STORE_KEY(ref)).catch(() => undefined)) as FellowshipQuest | undefined) ?? null

  if (held === null) return `No quest on ${ref} is kept: there is nothing to abandon.`

  const waiting = waitBeforeAbandon(held)

  if (waiting !== undefined) return waiting

  const root = await rootOf($)
  const isOwnTree = held.tree !== undefined && held.tree !== '' && held.tree !== root
  const said: string[] = [`The quest on ${ref} is abandoned.`]

  if (isOwnTree) {
    // A worktree with work in it is the person's to keep or drop first
    if ((await git($, ['status', '--porcelain'], held.tree)).out !== '') return `${held.tree} holds uncommitted changes: commit, stash or drop them there, then abandon the quest.`

    const removed = await git($, ['worktree', 'remove', held.tree], root)

    if (!removed.ok) return `The worktree ${held.tree} could not be removed: ${removed.out}`
    said.push(`Its worktree is removed.`)
  }

  if (held.kind !== 'review' && isOwnTree) {
    const exists = await git($, ['rev-parse', '--verify', '--quiet', `refs/heads/${held.branch}`], root)
    const deleted = exists.ok ? await git($, ['branch', '-D', held.branch], root) : { ok: true, out: '' }

    said.push(deleted.ok ? (exists.ok ? `${held.branch} is deleted, with its ${held.commits.length} ${held.commits.length === 1 ? 'commit' : 'commits'}.` : `${held.branch} was already gone.`) : `${held.branch} could not be deleted: ${deleted.out}.`)
  } else if (held.commits.length > 0) said.push(`${held.branch} is left as it is, with its ${held.commits.length} ${held.commits.length === 1 ? 'commit' : 'commits'}.`)

  // The tasks a plan's quest took up are open again in the plan, which can be set out on as it is
  if (held.kind === 'plan') {
    const made = await workOf($, held)
    const reopened = typeof made === 'string' ? [] : made.tasks.filter(task => task.state !== 'todo')

    for (const task of reopened) await markTask($, task.id, 'todo', held.ref)
    if (reopened.length > 0) said.push(`${reopened.length} ${reopened.length === 1 ? 'task is' : 'tasks are'} open again in the Elrond plan.`)
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
async function landedSha($: $, tree: string, sha: string, task: FellowshipTask): Promise<string> {
  if (sha !== '' && (await git($, ['merge-base', '--is-ancestor', sha, 'HEAD'], tree)).ok) return sha
  if (task.url === undefined || task.url === '') return sha

  const found = (await git($, ['log', '-n', '1', '--format=%H', '--fixed-strings', `--grep=${task.url}`], tree)).out.split('\n')[0] ?? ''

  return found !== '' ? found : sha
}

/**
 * Answers each review thread whose comment the quest took up, once its answers are pushed: one built is told its commit
 * and resolved; one handed back is told why, and left open for the person. A thread is answered once. Says what was done.
 */
async function answerThreads($: $, ref: string): Promise<string> {
  const held = await questOf($, ref)
  const number = Number(/#(\d+)$/.exec(ref)?.[1] ?? NaN)

  if (held === null || !Number.isFinite(number)) return ''

  const forge = forgeOf(held.pr !== '' ? held.pr : held.url)
  let answered = 0
  let resolved = 0
  const failed: string[] = []

  for (const task of (held.tasks ?? []).filter(one => one.thread !== undefined && one.thread !== '' && one.isAnswered !== true)) {
    const commit = held.commits.find(one => one.taskId === task.id && one.sha !== '')
    const reply = commit !== undefined ? `Answered in ${(await landedSha($, held.tree, commit.sha, task)).slice(0, 7)} by ${commit.by}.` : task.state === 'asked' ? `Handed back to the author: ${task.note ?? ''}` : undefined

    if (reply === undefined) continue

    const argv = threadArgv(forge, number, task.thread ?? '', reply)
    const replied = await run($, argv.reply, undefined, held.tree)

    // A thread left unanswered is said, and tried again at the next push
    if (!replied.ok) {
      failed.push(`task ${task.id} (${replied.out.split('\n').slice(-1)[0] || 'the forge said nothing'})`)
      continue
    }

    answered += 1
    if (commit !== undefined) {
      const done = await run($, argv.resolve, undefined, held.tree)

      if (done.ok) resolved += 1
      else failed.push(`task ${task.id}'s thread is answered but not resolved (${done.out.split('\n').slice(-1)[0] || 'the forge said nothing'})`)
    }
    await keep($, ref, was => ({ ...was, tasks: (was.tasks ?? []).map(one => (one.id === task.id ? { ...one, isAnswered: true } : one)) }))
  }

  return [
    answered === 0 ? '' : ` ${answered} ${answered === 1 ? 'thread is' : 'threads are'} answered on the pull request, ${resolved} resolved.`,
    failed.length === 0 ? '' : ` Not answered on the forge: ${failed.join('; ')}.`,
  ].join('')
}

/**
 * Why a quest's branch may not leave the machine: what it adds over the branch it is pushed onto holds what looks like
 * a secret, or what it adds could not be read. Nothing when it may.
 */
async function leakOf($: $, held: FellowshipQuest): Promise<string | undefined> {
  const onto = `origin/${held.kind === 'review' ? held.branch : held.base}`
  const isFetched = (await git($, ['rev-parse', '--verify', '--quiet', `refs/remotes/${onto}`], held.tree)).ok
  const from = isFetched ? onto : held.kind === 'review' ? '' : held.base

  if (from === '') return `${onto} is not known here, so what ${held.branch} adds cannot be read for secrets: fetch it, then push again.`

  const added = await git($, ['diff', '--no-color', '--no-ext-diff', `${from}...HEAD`], held.tree)

  if (!added.ok) return `What ${held.branch} adds over ${from} could not be read for secrets: ${added.out}`

  const leaked = secretsIn(added.out)

  return leaked.length === 0 ? undefined : `${held.branch} adds what looks like a secret (${leaked.join('; ')}), so it does not leave the machine: take it out of the branch's history, then push again.`
}

/** Pushes the branch and opens the pull request that closes the issue; a review's answers are pushed onto its pull request. */
async function sail($: $, ref: string): Promise<string> {
  const held = await questOf($, ref)

  if (held === null) return HOW_TO
  if (held.phase === 'sailed') return held.kind === 'review' ? `The answers on ${ref} are pushed.` : `The pull request is open: ${held.pr}`
  if (held.phase === 'warding') return `The statues judge the whole branch of ${ref}: the pull request opens once they pass it.`
  if (held.phase !== 'arrived' && !(held.kind === 'review' && (held.phase === 'ready' || held.phase === 'stuck') && held.commits.length > 0)) return `The quest on ${ref} has not arrived: it is ${held.phase}. Every task is committed first.`

  const made = await workOf($, held)

  if (typeof made === 'string') return made

  // Nothing that looks like a secret leaves the machine, whoever committed it
  const leak = await leakOf($, held)

  if (leak !== undefined) {
    await say($, ref, leak)

    return leak
  }

  if (held.kind === 'review') {
    await work($, ref, `Pushing ${held.branch}…`)

    const pushed = await push($, held.branch, held.tree)

    if (!pushed.ok) return `${held.branch} could not be pushed: it may be behind its remote. ${pushed.out.split('\n').slice(-1)[0] ?? ''}`

    await keep($, ref, was => ({ ...was, phase: was.phase === 'arrived' ? 'sailed' : was.phase }))

    const told = await answerThreads($, ref)

    return `${held.branch} is pushed: ${held.commits.length} answered ${held.commits.length === 1 ? 'comment is' : 'comments are'} on ${held.pr}.${told}`
  }

  // What the base gained since is taken in before the branch is judged whole and leaves the machine, so its pull request
  // does not open in conflict. A conflict leaves the quest arrived: once it is merged by hand, it sails again
  if (held.isWarded !== true) {
    const behind = await followBase($, held)

    if (behind !== undefined) return behind
  }

  // Each task of a plan was judged alone: both statues judge what the tasks do and let in together, once, before the
  // branch leaves the machine
  if (held.kind === 'plan' && held.isWarded !== true) {
    // The branch took in origin's base, just fetched: judged against a local base behind it, the statues would judge
    // the commits it took in as the branch's own
    const upstream = (await git($, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${held.base}`], held.tree)).ok ? `origin/${held.base}` : held.base
    const judged = parseJudgement(await judgementFor($, held.tree, { convene: true, statues: ['isildur', 'anarion'], against: upstream, about: wardPurpose(made) }).catch((error: unknown) => errorText(error)))

    await keep($, ref, was => ({ ...was, phase: 'warding', verdictLine: judged.line }))

    return ward($, ref, judged)
  }

  await work($, ref, `Pushing ${held.branch} and opening the pull request…`)

  const opened = await openRequest($, held.branch, prArgv(held, made), held.tree)

  if (typeof opened !== 'object') return opened

  const url = opened.url

  await keep($, ref, was => ({ ...was, phase: 'sailed', pr: url }))
  await tell($, `the pull request for ${ref} is open${url === '' ? '' : `: ${url}`}`)

  return `The Fellowship has sailed: ${held.branch} is pushed and the pull request that closes ${ref} is open${url === '' ? '' : ` at ${url}`}.`
}

/**
 * What the statues' judgement of a plan's whole branch comes to: it sails once they pass it; what they find blocking,
 * or a statue's silence, stops it for the person. Answers what was done, in a sentence.
 */
async function ward($: $, ref: string, judged: ReturnType<typeof parseJudgement>): Promise<string> {
  const held = await questOf($, ref)

  if (held === null || held.phase !== 'warding') return ''
  if (judged.verdict === 'sitting') return `${WARDING} of ${ref} before it sails: the pull request opens once they pass it.`

  if (judged.verdict === 'pass') {
    await keep($, ref, was => ({ ...was, phase: 'arrived', isWarded: true, verdictLine: `the whole branch ${judged.line}` }))

    return sail($, ref)
  }

  const why =
    judged.verdict === 'fail'
      ? `The statues found what blocks the whole branch of ${ref}:\n${judged.blocking.join('\n')}\nFix it in ${held.tree} and commit, then sail again: they judge the branch as it then stands.`
      : `The statues could not judge the whole branch of ${ref} (${judged.line}): sail again to have them judge it.`

  await keep($, ref, was => ({ ...was, phase: 'arrived', isWarded: false, verdictLine: `the whole branch: ${judged.line}` }))
  await say($, ref, why)
  await tell($, why.split('\n')[0] ?? why)

  return why
}

/** Looks at the statues' judgement of a plan's whole branch, while they sit. */
async function watchWard($: $, ref: string): Promise<void> {
  const held = await questOf($, ref)

  if (held === null) return

  const said = await ward($, ref, parseJudgement(await judgementFor($, held.tree).catch((error: unknown) => errorText(error))))

  if (said !== '' && !said.startsWith(WARDING)) await say($, ref, said)
}

// The quests the clock is doing something for now: a proof takes minutes, and that quest's next ask waits for it while
// the others go on. '' stands for setting a new quest out
const busy = new Set<string>()

/** Does one thing asked of a quest, alone for that quest: what came of it is told as well as kept in the pane. */
async function act($: $, asked: { ref: string; what: FellowshipWanted | 'look'; arg?: string }): Promise<void> {
  const { ref, what } = asked

  busy.add(ref)

  try {
    if (what === 'look') {
      const phase = (await questOf($, ref))?.phase

      await (phase === 'gazing' ? behold($, ref) : phase === 'warding' ? watchWard($, ref) : judge($, ref))
    } else if (what === 'next') await sendNext($, ref)
    else if (what === 'prove') await prove($, ref)
    else {
      const said =
        what === 'set out' || what === 'set out auto'
          ? await setOut($, what === 'set out auto', asked.arg ?? '')
          : what === 'errand' || what === 'errand auto'
            ? await errand($, asked.arg ?? '', what === 'errand auto', true)
            : what === 'abandon'
              ? await abandon($, ref)
              : await sail($, ref)

      // A command typed answers before it is done: what came of it is told as well as kept in the pane, beside its
      // quest, or for the Fellowship as a whole where it set none out or there is none any more
      $.ui.toast(`Fellowship: ${said.split('\n')[0] ?? said}`)
      await say($, ref !== '' && (await questOf($, ref)) !== null ? ref : '', said)
    }
  } catch (error) {
    await say($, ref, `The Fellowship stumbled: ${errorText(error)}`)
  } finally {
    busy.delete(ref)
    await update($, working, ({ [ref]: _done, ...rest }) => rest)
  }
}

// What may be done where the mod stands in none of its hooks (the clock): what sends no agent. Setting out places the
// worktree and asks for the first task, which waits for a hook
const UNHELD: readonly FellowshipWanted[] = ['set out', 'set out auto', 'errand', 'errand auto', 'abandon']

/**
 * Does what was asked of the quests, the first ask of each at a time, and answers how many it took: in a hook every
 * one, as an agent sent there is held; from the clock only what sends none. `only` keeps to one quest's asks (and to
 * setting out); `isLooking` also looks at each quest waiting on the statues or the Mirror, whose answer is in.
 */
async function drain($: $, isFramed: boolean, only?: string, isLooking = false): Promise<number> {
  // A press of Elrond's pane asks to set out on the plan it shows
  const fromElrond = await takeSetOut($)

  if (fromElrond !== undefined) await want($, '', fromElrond.isAuto ? 'set out auto' : 'set out', fromElrond.ref)

  const queue = await read($, wanted)
  const firsts = queue.filter((one, at) => queue.findIndex(other => other.ref === one.ref) === at)
  const taken = firsts.filter(one => !busy.has(one.ref) && (isFramed || UNHELD.includes(one.what)) && (only === undefined || one.ref === only || one.ref === ''))
  const isSame = (one: (typeof queue)[number], other: (typeof queue)[number]) => one.ref === other.ref && one.what === other.what && one.arg === other.arg

  if (taken.length > 0) await update($, wanted, was => was.filter((one, at) => !taken.some(other => isSame(one, other) && was.findIndex(first => isSame(first, other)) === at)))

  const looked = isFramed && isLooking ? Object.values(await read($, quests)).filter(held => !busy.has(held.ref) && (only === undefined || held.ref === only) && (held.phase === 'judging' || held.phase === 'gazing' || held.phase === 'warding')) : []

  await Promise.all([...taken.map(one => act($, one)), ...looked.map(held => act($, { ref: held.ref, what: 'look' }))])

  return taken.length
}

/** The clock does what sends no agent: the rest waits for a hook. */
async function tick($: $): Promise<void> {
  await drain($, false)

  if ((await read($, wanted)).length > 0) await askToPump($, 'a Fellowship quest waits to send its next agent.')
}

/**
 * Does what was asked of the quests, in the hook that calls it: where it stands in one, a member, the statues or the
 * Mirror it sends are held. Each ask may ask the next (setting out asks for the first task, a commit for the next), so
 * it goes on until none is left; a quest waiting on the statues or the Mirror is looked at first.
 */
export async function pumpFellowship($: $, only?: string): Promise<void> {
  const isFramed = await inFrame($)

  for (let round = 0; round < 8; round += 1) {
    if ((await drain($, isFramed, only, round === 0)) === 0 && round > 0) break
  }

  // Outside a hook (a press, the clock), what would send an agent waits: Claude is asked to call for it
  if (!isFramed && (await read($, wanted)).length > 0) await askToPump($, 'a Fellowship quest waits to send its next agent.')
}

/** Runs a call that is not the clock's for a quest, holding the clock off that quest. */
async function alone<T>($: $, ref: string, act: () => Promise<T>): Promise<T> {
  busy.add(ref)

  try {
    return await act()
  } finally {
    busy.delete(ref)
    await update($, working, ({ [ref]: _done, ...rest }) => rest)
  }
}

/** The quest whose member an agent is: by the id its spawn answered, else, where it answered none, by its type. */
async function questOfAgent($: $, agentId: string, phase?: FellowshipPhase): Promise<FellowshipQuest | undefined> {
  const all = Object.values(await read($, quests)).filter(held => held.march !== null && (phase === undefined || held.phase === phase))
  const byId = all.find(held => held.march?.agentId !== '' && held.march?.agentId === agentId)

  if (byId !== undefined) return byId

  const agent = (await $.agent.list().catch(() => [])).find(one => one.id === agentId && one.status === 'running')

  return agent === undefined ? undefined : all.find(held => held.march?.agentId === '' && agent.type === typeOf(held.march.member))
}

/** The quest a command or a call names, by its ref or its branch; else the one the pane shows, else the only one. */
async function namedQuest($: $, named = ''): Promise<FellowshipQuest | null> {
  const all = await read($, quests)

  // A quest by its ref, its branch, or its number (`12`, `#12`), matched whole: `2` is never #12. Two quests a number
  // names alike (#12 of two repositories) name none
  if (named !== '') {
    const number = /^#?(\d+)$/.exec(named)?.[1]
    const found = all[named] !== undefined ? [all[named]] : Object.values(all).filter(one => one.branch === named || (number !== undefined && new RegExp(`[#!]${number}$`).test(one.ref)))

    return found.length === 1 ? (found[0] ?? null) : null
  }

  const shown = await read($, selected)

  return all[shown] ?? (Object.values(all).length === 1 ? (Object.values(all)[0] ?? null) : null)
}

const sectionText = (all: readonly FellowshipQuest[]): string =>
  [
    `The Fellowship mod is implementing ${all.length === 1 ? 'an issue' : `${all.length} issues`}, each task by task in a git worktree of its own by builder subagents, each change test-checked, reviewed and committed alone:`,
    ...all.map(held => `- ${held.ref} (${held.kind}): ${held.phase}, in ${held.tree}`),
    "Leave those worktrees to the builders; mcp__middle-earth__quest says where each quest stands.",
  ].join('\n')

/** The Fellowship at the session's start: its command, its tools, and the clock that does what was asked of a quest. */
export async function startFellowship($: $): Promise<void> {
  await $.command.register({ name: 'fellowship', description: 'Build an Elrond plan, an errand or a review task by task in a worktree: /fellowship sets out (--auto goes on by itself); errand <issue>; next, commit, sail, halt, abandon [quest]' })

  // A host that registers no tools still starts the session
  for (const tool of TOOLS) await $.tool.register(tool).catch(() => undefined)

  await recallQuests($).catch(() => undefined)

  $.clock.every(TICK_MS, () => void tick($).catch(() => undefined))
}

/**
 * The quests kept across sessions, back as they stood: what was out when the session ended (a member, the proof, the
 * statues, the Mirror) is out no more, and its quest stuck, as taking it up again leaves it; nothing is sent. A quest
 * the session holds already (a reload keeps them) is left as it is.
 */
async function recallQuests($: $): Promise<void> {
  const held = await read($, quests)

  for (const key of (await $.store.keys().catch(() => [])).filter(one => one.startsWith('quest:'))) {
    const kept = (await $.store.get(key).catch(() => undefined)) as FellowshipQuest | undefined

    if (kept === undefined || kept === null || typeof kept.ref !== 'string' || held[kept.ref] !== undefined) continue

    const was = kept.phase
    const phase: FellowshipPhase = was === 'gazing' || was === 'marching' || was === 'proving' || was === 'judging' ? 'stuck' : was === 'warding' ? 'arrived' : was
    const quest: FellowshipQuest = { ...kept, kind: kept.kind ?? 'plan', phase }

    await update($, quests, all => ({ ...all, [quest.ref]: quest }))
    await workOf($, quest).catch(() => undefined)
  }
}

/** A turn has ended: what a member built is proven, outside the hook; a task it hands back goes to the person. */
export async function endedFellowship($: $, e: TurnEnded): Promise<void> {
  const held = e.agentId === undefined ? undefined : await questOfAgent($, e.agentId, 'marching')

  if (held === undefined || held.march === null) return

  const out = { ...held.march, answer: e.answer ?? '' }
  const title = MEMBERS[out.member].title
  const handed = e.isAborted || e.reason !== 'answer' ? undefined : handBackOf(out.answer)

  if (e.isAborted || e.reason !== 'answer') {
    await keep($, held.ref, was => ({ ...was, phase: 'stuck', march: out }))
    await say($, held.ref, `${title} on task ${out.taskId} ${e.isAborted ? 'was interrupted' : e.reason === 'refusal' ? 'refused' : 'ended on an API error'}: send it again from the pane.`)
  } else if (handed !== undefined && held.kind === 'review') {
    // A comment that asks something only the person can answer is theirs, and the quest goes on to the next
    const isClean = (await git($, ['status', '--porcelain', ...UNMODDED], held.tree)).out === ''

    await keep($, held.ref, was => ({ ...was, phase: isClean ? 'ready' : 'stuck', march: isClean ? null : out }))
    await mark($, held, out.taskId, isClean ? 'asked' : 'doing', handed)
    if (isClean) await want($, held.ref, 'next')
    else await say($, held.ref, `${title} hands the comment back (${handed}), but left changes in ${held.tree}: drop them, or commit them from the pane.`)
  } else if (handed !== undefined) {
    await keep($, held.ref, was => ({ ...was, phase: 'stuck', march: out }))
    await say($, held.ref, held.kind === 'errand' ? `${title} hands ${held.ref} back: it is no errand. ${handed} Abandon it, then plan it with /elrond ${held.ref}.` : `${title} stops on task ${out.taskId}: the plan must be revised. ${handed} Revise it in the Elrond pane, then send the task again.`)
    await tell($, `${title} hands ${held.ref} back: ${handed}`)
  } else {
    await keep($, held.ref, was => ({ ...was, phase: 'proving', march: out }))
    await want($, held.ref, 'prove')
  }
}

/** What Claude is told of the quests while they are under way. */
export async function sectionOfFellowship($: $): Promise<Section | undefined> {
  const all = Object.values(await read($, quests)).filter(held => held.phase !== 'sailed')

  return all.length === 0 ? undefined : { id: 'fellowship:quest', text: sectionText(all) }
}

/** A member the record lost (sent where its spawn answered no id), found by the quest it is out on, and held to its task's files. */
export async function memberFound($: $, agentId: string): Promise<MiddleEarthAgent | undefined> {
  const held = await questOfAgent($, agentId)

  if (held === undefined || held.march === null) return undefined

  const task = (await read($, plans))[held.ref]?.tasks.find(one => one.id === held.march?.taskId)

  return { role: 'member', root: await rootOf($), tree: held.tree, files: [...(task?.files ?? [])] }
}

export function registerFellowship(on: On): void {

  on('tool.call', { tool: 'mcp__middle-earth__set_out' }, async ($, e) => {
    const given = e as unknown as { auto?: unknown; ref?: unknown }

    const said = await alone($, '', () => setOut($, given.auto === true, typeof given.ref === 'string' ? given.ref : ''))

    // The first task is sent here, where its member is held
    await pumpFellowship($)

    return { result: said }
  }).catch((_$, _e, next) => toolFailed('set_out', next.error))

  on('tool.call', { tool: 'mcp__middle-earth__errand' }, async ($, e) => {
    const given = e as unknown as { issue?: unknown; auto?: unknown }

    const said = await alone($, '', () => errand($, String(given.issue ?? ''), given.auto === true, false))

    // The errand's member is sent here, where it is held
    await pumpFellowship($)

    return { result: said }
  }).catch((_$, _e, next) => toolFailed('errand', next.error))

  on('tool.call', { tool: 'mcp__middle-earth__quest' }, async ($, e) => {
    const named = String((e as unknown as { ref?: unknown }).ref ?? '')
    const all = Object.values(await read($, quests)).filter(held => named === '' || held.ref === named || held.branch === named)

    if (all.length === 0) return { result: named === '' ? HOW_TO : `No quest on ${named} is under way.` }

    const texts: string[] = []

    for (const held of all) {
      const made = await workOf($, held)

      texts.push(questText(held, typeof made === 'string' ? ((await read($, plans))[held.ref] ?? null) : made))
    }

    return { result: texts.join('\n\n―――\n\n') }
  }).catch((_$, _e, next) => toolFailed('quest', next.error))

  on('tool.call', { tool: 'mcp__middle-earth__commit' }, async ($, e) => {
    const held = await namedQuest($, String((e as unknown as { ref?: unknown }).ref ?? ''))

    if (held === null) return { result: 'Name the quest, by its ref: more than one is under way, or none.' }

    const said = await resubmit($, held.ref)

    // The proof, and the statues it leads to, are done here, where the statues are held
    await pumpFellowship($, held.ref)

    return { result: said }
  }).catch((_$, _e, next) => toolFailed('commit', next.error))

  on('tool.call', { tool: 'mcp__middle-earth__next' }, async ($, e) => {
    const held = await namedQuest($, String((e as unknown as { ref?: unknown }).ref ?? ''))

    if (held === null) return { result: 'Name the quest, by its ref: more than one is under way, or none.' }
    if (held.phase !== 'ready' && held.phase !== 'stuck') return { result: `The quest on ${held.ref} is ${held.phase}: no task is sent now.` }

    await want($, held.ref, 'next')
    // The member is sent here, inside the tool's own hook, where it is held
    await pumpFellowship($, held.ref)

    return { result: `A member is sent on the next task of ${held.ref}: mcp__middle-earth__quest says how it goes.` }
  }).catch((_$, _e, next) => toolFailed('next', next.error))

  // Pushing and opening the pull request reach outside the machine: no tool offers them to Claude. The person sails with
  // /fellowship sail or the pane, or opted into it up front with --auto. What sends an agent is done in the command,
  // where the agent is held: it answers once the agent is out (sailing, once the pull request is open)
  on('command.run', { command: 'fellowship' }, async ($, e) => {
    const words = e.args.trim().split(/\s+/).filter(word => word !== '')
    // `auto` is taken as --auto: no issue is named so, and /fellowship set out auto once set out on an issue "auto"
    const isAuto = words.includes('--auto') || words.includes('auto')
    const plain = words.filter(word => !word.startsWith('--') && word !== 'auto')
    const verb = plain[0] ?? ''
    const named = plain[1] ?? ''

    await $.ui.open({ id: PANE, title: TITLE })

    if (verb === 'errand') {
      if (named === '') return { text: 'Name the issue: /fellowship errand <issue> (--auto opens its pull request by itself).' }
      await want($, '', isAuto ? 'errand auto' : 'errand', plain.slice(1).join(' '))
      await pumpFellowship($)

      return { text: `The Fellowship sets out on ${named} as an errand: the pane says how it went.` }
    }

    if (verb === '' || verb === 'set') {
      // Every quest under way is shown, unless the person asks to set out: /fellowship set out [issue]
      const all = Object.values(await read($, quests))
      const shown = await read($, plans)

      if (all.length > 0 && !isAuto && verb === '') return { text: all.map(held => questLine(held, shown[held.ref] ?? null)).join('\n') }

      await want($, '', isAuto ? 'set out auto' : 'set out', verb === 'set' ? (plain[2] ?? '') : '')
      await pumpFellowship($)

      return { text: `The Fellowship sets out on the Elrond plan${isAuto ? ', going on by itself' : ''}: the pane says how it went.` }
    }

    const held = await namedQuest($, named)

    if (held === null) return { text: named === '' ? 'Name the quest, by its ref or its branch: more than one is under way, or none.' : `No quest on ${named} is under way.` }

    if (verb === 'abandon') {
      const waiting = waitBeforeAbandon(held)

      if (waiting !== undefined) return { text: waiting }
      await want($, held.ref, 'abandon')

      return { text: `The quest on ${held.ref} is being abandoned: the pane says how it went.` }
    }

    if (verb === 'halt') {
      await keep($, held.ref, was => ({ ...was, isAuto: false }))

      return { text: `The quest on ${held.ref} stops after the task it is on: send the next from the pane, or /fellowship next.` }
    }

    if (verb === 'next') {
      if (held.phase !== 'ready' && held.phase !== 'stuck') return { text: `The quest on ${held.ref} is ${held.phase}: no task is sent now.` }
      await want($, held.ref, 'next')
      await pumpFellowship($, held.ref)

      return { text: `A member is sent on the next task of ${held.ref}.` }
    }

    if (verb === 'commit') {
      const said = await resubmit($, held.ref)

      await pumpFellowship($, held.ref)

      return { text: said }
    }

    if (verb === 'sail') {
      await want($, held.ref, 'sail')
      await pumpFellowship($, held.ref)

      return { text: `The quest on ${held.ref} makes ready to sail: the pane says how it went.` }
    }

    return { text: `/fellowship knows set out (no word, or --auto), errand <issue>, next, commit, sail, halt and abandon, each with a quest's ref or branch; not ${verb}.` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const all = Object.values(await read($, quests)).sort((one, other) => other.at - one.at)
    const shown = await read($, selected)
    const held = all.find(one => one.ref === shown) ?? all[0] ?? null
    const said = await read($, notes)
    const doing = await read($, working)
    const queue = await read($, wanted)
    // A press asks, then does it where it stands in a hook: where it does not, Claude is asked to call for it
    const press = async (ref: string, what: FellowshipWanted) => {
      await want($, ref, what)
      await pumpFellowship($, ref === '' ? undefined : ref)
    }
    const general = said[''] ?? ''

    if (held === null) {
      return view.keep(
        <Box flexDirection="column" gap={1}>
          {badge({ label: 'no quest', tone: 'neutral' })}
          {queue.length > 0 && <Text dimColor>{`${queue[0]?.what ?? ''}…`}</Text>}
          {general !== '' && <Text color="warning">{general}</Text>}
          <Text dimColor>{HOW_TO}</Text>
          <Button key="set-out" hotkey="s" variant="primary" onPress={() => press('', 'set out')}>
            Set out on the Elrond plan
          </Button>
        </Box>,
      )
    }

    const made = (await read($, plans))[held.ref] ?? null
    const out = held.march
    const commitOf = (id: number) => held.commits.find(one => one.taskId === id)
    const outTask = out === null || made === null ? undefined : made.tasks.find(task => task.id === out.taskId)
    const problem = said[held.ref] ?? ''
    const busyLine = doing[held.ref] ?? ''
    const asked = queue.find(one => one.ref === held.ref)

    return view.keep(
      <Box flexDirection="column" gap={1}>
        {all.length > 1 && (
          <Box flexDirection="column">
            {all.map(one => (
              <Button key={`quest-${one.ref}`} plain onPress={() => update($, selected, () => one.ref)}>
                {`${one.ref === held.ref ? '▸' : ' '} ${one.ref} · ${one.kind} · ${one.phase}${one.isAuto ? ' · auto' : ''}`}
              </Button>
            ))}
          </Box>
        )}
        <Box flexDirection="row" gap={2}>
          {badge({ label: held.phase, tone: PHASE_TONE[held.phase] })}
          {made !== null && badge({ label: tally(made), tone: isAllDone(made) ? 'success' : 'info' })}
          <Text bold wrap="truncate-end">{held.title}</Text>
        </Box>
        <Text dimColor>{`${held.ref} · ${held.kind} · ${held.branch} ← ${held.base}${held.isAuto ? ' · auto' : ''}`}</Text>
        <Text dimColor wrap="truncate-start">{held.tree}</Text>
        <Box flexDirection="column">
          {busyLine !== '' && <Text color="suggestion">{busyLine}</Text>}
          {asked !== undefined && busyLine === '' && <Text dimColor>{`${asked.what}…`}</Text>}
          {problem !== '' && <Text color="warning">{problem}</Text>}
          {general !== '' && <Text dimColor>{general}</Text>}
        </Box>
        {made !== null && (
          <Box flexDirection="column" borderStyle="round" paddingX={1}>
            {made.tasks.map(task => (
              <Text key={`task-${task.id}`} color={out?.taskId === task.id ? 'suggestion' : task.state === 'done' ? 'success' : task.state === 'asked' ? 'warning' : undefined} dimColor={task.state === 'todo' && out?.taskId !== task.id} wrap="truncate-end">
                {`${MARK[task.state]} ${task.id}. ${task.title}  · ${task.weight}${commitOf(task.id) !== undefined ? ` · ${commitOf(task.id)?.by ?? ''} ${commitOf(task.id)?.sha.slice(0, 7) || 'no change'}` : ''}${out?.taskId === task.id ? ` · ${MEMBERS[out.member].title}, ${held.phase}` : ''}${task.note !== undefined && task.note !== '' ? ` · ${task.note}` : ''}`}
              </Text>
            ))}
          </Box>
        )}
        {held.phase === 'gazing' && <Text color="suggestion">{`Galadriel gazes into the Mirror: task ${held.gazed ?? ''}'s tests are written first, red`}</Text>}
        {held.phase === 'warding' && <Text color="suggestion">{`${WARDING} before it sails`}</Text>}
        {out === null && held.verdictLine.startsWith('the whole branch') && <Text color={held.isWarded === true ? 'success' : 'warning'}>{`The statues: ${held.verdictLine}`}</Text>}
        {held.vision !== undefined && held.vision !== null && held.vision.tests.length > 0 && <Text dimColor>{`The Mirror: ${held.vision.tests.length} red ${held.vision.tests.length === 1 ? 'test' : 'tests'} for task ${held.vision.taskId} to make pass`}</Text>}
        {out !== null && (
          <Box flexDirection="column" borderStyle="round" paddingX={1}>
            <Text bold>{`${MEMBERS[out.member].title} ${held.phase === 'stuck' ? 'back from' : 'on'} task ${out.taskId}: ${out.title}`}</Text>
            <Text dimColor>{`try ${out.attempt}${made !== null && outTask !== undefined ? ` of ${triesOf(made, outTask)}` : ''} · since ${new Date(out.at).toLocaleTimeString()}`}</Text>
            {held.proofLine !== '' && <Text color={held.phase === 'judging' ? 'success' : 'warning'}>{`Argonath's proof: ${held.proofLine}`}</Text>}
            {held.verdictLine !== '' && <Text color={held.verdictLine.startsWith('passed') ? 'success' : held.verdictLine === 'judging' ? 'suggestion' : 'warning'}>{`The statues: ${held.verdictLine}`}</Text>}
          </Box>
        )}
        {held.pr !== '' && <Text color="success">{`Pull request: ${held.pr}`}</Text>}
        <Box flexDirection="row" gap={1}>
          {(held.phase === 'ready' || held.phase === 'stuck') && (
            <Button key="next" hotkey="n" variant="primary" onPress={() => press(held.ref, 'next')}>
              {held.phase === 'stuck' ? 'Send again' : 'Send the next task'}
            </Button>
          )}
          {held.phase === 'stuck' && out !== null && (
            <Button key="commit" hotkey="c" onPress={() => resubmit($, held.ref).then(text => say($, held.ref, text)).then(() => pumpFellowship($, held.ref))}>
              Put it before the Argonath
            </Button>
          )}
          {(held.phase === 'arrived' || (held.kind === 'review' && held.phase !== 'sailed' && !OUT.includes(held.phase) && held.commits.length > 0)) && (
            <Button key="sail" hotkey="p" variant={held.phase === 'arrived' ? 'primary' : 'secondary'} onPress={() => press(held.ref, 'sail')}>
              {held.kind === 'review' ? 'Push the answers' : 'Push and open the pull request'}
            </Button>
          )}
          {held.phase !== 'sailed' && (
            <Button key="auto" hotkey="a" onPress={() => keep($, held.ref, was => ({ ...was, isAuto: !was.isAuto })).then(() => undefined)}>
              {held.isAuto ? '✓ Going on by itself' : 'Go on by itself'}
            </Button>
          )}
          <Button key="set-out" hotkey="s" onPress={() => press('', 'set out')}>
            Set out on the Elrond plan
          </Button>
        </Box>
      </Box>,
    )
  })
}
