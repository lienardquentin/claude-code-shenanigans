import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { FellowshipKind, FellowshipMember, FellowshipPhase, FellowshipPlan, FellowshipQuest, FellowshipTask, FellowshipTaskState, FellowshipWanted } from '../types'
import {
  HOW_TO,
  MARK,
  MEMBERS,
  branchOf,
  commitMessage,
  companionPrompt,
  errandTask,
  handBackOf,
  isAllDone,
  isModSource,
  isOutside,
  memberFor,
  memberSystem,
  nextTask,
  ownPlan,
  parsePlan,
  parseWorktrees,
  prArgv,
  purposeOf,
  questLine,
  questText,
  reachesOut,
  resolvedFrom,
  reviewTasks,
  statueModelFor,
  statuesFor,
  tally,
  treePathOf,
  triesOf,
  unsettledOf,
  wardPurpose,
} from './quest'
import type { Retry } from './quest'
import { ask, errorText, git, isForbiddenGit, isMergedFrom, isModPath, openRequest, parseJudgement, proofVerdict, push, rootOf, run, sendBack, sendBackPrompt, targetsOf } from './kit/flow'
import { badge } from './kit/badge'
import type { Tone } from './kit/badge'
import { paneView } from './kit/pane-text'

type $ = EngineInterface

const PANE = 'fellowship'
const TITLE = 'Fellowship'
// How many ticks of the clock pass between two looks at what a quest waits on: the statues, or the Mirror
const LOOK_EVERY = 6
// How often the clock looks for what a press, a command or a turn asked for
const TICK_MS = 500
// What is said while the statues judge a plan's whole branch
const WARDING = 'The statues judge the whole branch'
// Where a quest is kept across sessions, by its ref
const STORE_KEY = (ref: string) => `quest:${ref}`
// How long the forge is given to answer a fetch
const FETCH_TIMEOUT_MS = 120_000

const quests = atom({ plugin: 'fellowship', key: 'quests' } as const, {} as Record<string, FellowshipQuest>)
const plans = atom({ plugin: 'fellowship', key: 'plans' } as const, {} as Record<string, FellowshipPlan>)
const notes = atom({ plugin: 'fellowship', key: 'notes' } as const, {} as Record<string, string>)
const working = atom({ plugin: 'fellowship', key: 'working' } as const, {} as Record<string, string>)
const wanted = atom({ plugin: 'fellowship', key: 'wanted' } as const, [] as { ref: string; what: FellowshipWanted; arg?: string }[])
const selected = atom({ plugin: 'fellowship', key: 'selected' } as const, '')

const view = paneView({ id: PANE, title: TITLE, command: '/fellowship' })

const REF = { type: 'string', description: 'The quest, by its ref; the one the pane shows when left out.' } as const

const TOOLS = [
  {
    name: 'set_out',
    description:
      "Implements the Elrond plan in force (or resumes it) in a git worktree of its own under .fellowship/trees/, leaving the person's checkout alone: a builder subagent builds each task in turn, Argonath checks that an integration test pins each behaviour it changed, reviewer subagents review the change, and it is committed once they pass it. When every task is committed, the person opens the pull request with /fellowship sail, or it opens by itself with auto. It starts only once every question of the plan is answered and every risk decided; quests on other issues run beside it. Call it when the person asks to implement a planned issue. The Black Gate calls it with kind `review` to hand over a pull request's review comments.",
    inputSchema: {
      type: 'object',
      properties: {
        auto: { type: 'boolean', description: 'Go on by itself: send each task once the one before is committed, and open the pull request at the end. Only when the person asked for it in those words.' },
        ref: { type: 'string', description: "The plan of this issue, as Elrond spells it (`github:owner/repo#12`); the plan in force when left out." },
        kind: { type: 'string', enum: ['plan', 'review'], description: 'From the Black Gate: `review`, with the pull request and its comments below. `plan` when left out.' },
        review: {
          type: 'object',
          description: 'From the Black Gate: the pull request, and the review comments that ask for a change.',
          properties: {
            ref: { type: 'string' },
            url: { type: 'string' },
            title: { type: 'string' },
            branch: { type: 'string' },
            base: { type: 'string' },
            comments: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, brief: { type: 'string' }, author: { type: 'string' }, where: { type: 'string' }, url: { type: 'string' }, weight: { type: 'string' }, files: { type: 'array', items: { type: 'string' } } } } },
          },
        },
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
    name: 'relics',
    description: 'Every quest the Fellowship keeps, as JSON: its ref, kind, branch, base, worktree, pull request and phase. For Mount Doom, which watches for their pull requests to be merged.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'forget',
    description: 'Forgets a quest once its pull request is merged from its branch, which the forge is asked; one not merged is kept. For Mount Doom.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string' },
        pr: { type: 'string', description: 'The merged pull request, by its URL.' },
        json: { type: 'boolean', description: 'Answer as JSON, `{ forgotten, text }`, for a mod that reads it.' },
      },
      required: ['ref', 'pr'],
    },
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
] as const

const PHASE_TONE: Record<FellowshipPhase, Tone> = { ready: 'neutral', gazing: 'info', marching: 'info', proving: 'info', judging: 'info', stuck: 'danger', arrived: 'accent', warding: 'info', sailed: 'success' }

// The phases a quest waits in on something that is out: a member, the Mirror, the proof or the statues
const OUT: readonly FellowshipPhase[] = ['gazing', 'marching', 'proving', 'judging', 'warding']

const questOf = async ($: $, ref: string): Promise<FellowshipQuest | null> => (await read($, quests))[ref] ?? null

/** Changes a quest, and keeps it across sessions. Answers it as it now stands; nothing when no quest is on the ref. */
const keep = async ($: $, ref: string, change: (was: FellowshipQuest) => FellowshipQuest): Promise<FellowshipQuest | null> => {
  const was = await questOf($, ref)

  if (was === null) return null

  const made = change(was)

  await update($, quests, held => (held[ref] === undefined ? held : { ...held, [ref]: change(held[ref]) }))
  await $.store.set(STORE_KEY(ref), made).catch(() => undefined)

  return made
}

/** Lays a quest down: no longer under way here, and kept across sessions no more. */
const drop = async ($: $, ref: string): Promise<void> => {
  await update($, quests, ({ [ref]: _gone, ...rest }) => rest)
  await update($, plans, ({ [ref]: _gone, ...rest }) => rest)
  await update($, working, ({ [ref]: _gone, ...rest }) => rest)
  await $.store.delete(STORE_KEY(ref)).catch(() => undefined)
  await update($, selected, was => (was === ref ? '' : was))
}

const say = async ($: $, ref: string, text: string): Promise<void> => {
  await update($, notes, was => ({ ...was, [ref]: text }))
}

const work = async ($: $, ref: string, text: string): Promise<void> => {
  await update($, working, was => ({ ...was, [ref]: text }))
}

const want = async ($: $, ref: string, what: FellowshipWanted, arg?: string): Promise<void> => {
  await update($, wanted, was => [...was, { ref, what, ...(arg !== undefined ? { arg } : {}) }])
}

const tell = async ($: $, text: string): Promise<void> => {
  $.ui.toast(`Fellowship: ${text}`)
  await $.ui.notify(text, { title: 'Fellowship' }).catch(() => undefined)
}

/**
 * The work of a quest, read afresh and kept for the pane: a plan's from Elrond, by its issue; an errand's or a review's
 * from the tasks it keeps. A sentence when it could not be read.
 */
const workOf = async ($: $, held: FellowshipQuest): Promise<FellowshipPlan | string> => {
  let made: FellowshipPlan | null | string

  if (held.kind === 'plan') {
    const got = await ask($, 'elrond', 'plan', { json: true, ref: held.ref })

    made = got.isError ? got.text : parsePlan(got.text)
  } else made = ownPlan(held)

  if (made === null) return `Elrond keeps no plan of ${held.ref} any more.`
  if (typeof made === 'string') return made

  const kept = made

  await update($, plans, was => ({ ...was, [held.ref]: kept }))

  return kept
}

/** Marks a task of a quest: in Elrond for a plan, in the quest itself for any other. */
const mark = async ($: $, held: FellowshipQuest, id: number, state: FellowshipTaskState, note?: string): Promise<void> => {
  if (held.kind === 'plan') {
    await ask($, 'elrond', 'task', { id, state, ref: held.ref })

    return
  }

  await keep($, held.ref, was => ({ ...was, tasks: (was.tasks ?? []).map(task => (task.id === id ? { ...task, state, ...(note !== undefined ? { note } : {}) } : task)) }))
}

/** Every quest kept, here or across sessions: what Mount Doom watches. */
const relics = async ($: $): Promise<{ ref: string; kind: FellowshipKind; branch: string; base: string; tree: string; pr: string; phase: string }[]> => {
  const kept = Object.values(await read($, quests))

  for (const key of (await $.store.keys().catch(() => [])).filter(one => one.startsWith('quest:'))) {
    const one = (await $.store.get(key).catch(() => undefined)) as FellowshipQuest | undefined

    if (one !== undefined && one !== null && !kept.some(was => was.ref === one.ref)) kept.push(one)
  }

  return kept.map(({ ref, kind, branch, base, tree, pr, phase }) => ({ ref, kind: kind ?? 'plan', branch, base, tree: tree ?? '', pr, phase }))
}

/** Forgets a quest whose pull request is merged from its branch, here and across sessions. Its worktree is Mount Doom's to clear. */
const forget = async ($: $, ref: string, pr: string): Promise<{ forgotten: boolean; text: string }> => {
  const found = (await relics($)).find(one => one.ref === ref)

  if (found === undefined) return { forgotten: false, text: `No quest on ${ref} is kept.` }
  if (!(await isMergedFrom($, pr, found.branch))) return { forgotten: false, text: `${pr} is not a merged pull request from ${found.branch}: the quest on ${ref} is kept.` }

  await drop($, ref)

  return { forgotten: true, text: `The quest on ${ref} is forgotten.` }
}

/** The branch the person's checkout is on, else the remote's default, else main: what a quest sets out from. */
const baseOf = async ($: $, root: string, branch: string): Promise<string> => {
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
const placeTree = async ($: $, branch: string, base: string | undefined, isFetched: boolean): Promise<{ tree: string; base: string } | string> => {
  const root = await rootOf($)
  const from = base ?? (await baseOf($, root, branch))
  const at = parseWorktrees((await git($, ['worktree', 'list', '--porcelain'], root)).out).find(one => one.branch === branch)

  if (at !== undefined) return { tree: at.path, base: from }

  const tree = treePathOf(root, branch)

  // The folder ignores itself: no quest's worktree is part of the project's checkout
  await $.fs.write(`${root}/.fellowship/.gitignore`, '*\n').catch(() => undefined)

  if (isFetched) await run($, ['git', 'fetch', 'origin', branch], FETCH_TIMEOUT_MS, root)

  const exists = await git($, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], root)
  const added = await git($, exists.ok || isFetched ? ['worktree', 'add', tree, branch] : ['worktree', 'add', '-b', branch, tree, from], root)

  return added.ok ? { tree, base: from } : `The worktree of ${branch} could not be made at ${tree}: ${added.out}`
}

/** What a quest is set out on: what it is, and the branch it is built on. */
type Spec = { kind: FellowshipKind; ref: string; url: string; title: string; branch: string; base?: string; isAuto: boolean; tasks?: FellowshipTask[]; pr?: string }

/**
 * Sets a quest out, or takes it up where it was left: in its worktree, its first task sent by the clock, outside the
 * call that asked. Answers what was done, in a sentence.
 */
const begin = async ($: $, spec: Spec, made: FellowshipPlan): Promise<string> => {
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
  // A review handed over again brings the comments that came since: those already taken up keep where they stand
  const tasks = spec.kind === 'plan' ? undefined : [...(resumed?.tasks ?? []), ...(spec.tasks ?? []).filter(task => !(resumed?.tasks ?? []).some(one => one.url !== undefined && one.url === task.url))].map((task, at) => ({ ...task, id: at + 1 }))
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
    at: resumed?.at ?? Date.now(),
  }

  await update($, quests, was => ({ ...was, [spec.ref]: quest }))
  await update($, plans, was => ({ ...was, [spec.ref]: work }))
  await $.store.set(STORE_KEY(spec.ref), quest).catch(() => undefined)
  await update($, selected, () => spec.ref)
  await say($, spec.ref, '')
  await $.ui.open({ id: PANE, title: TITLE }).catch(() => undefined)

  if (quest.phase === 'ready') await want($, spec.ref, 'next')
  if (quest.phase === 'arrived' && quest.isAuto && quest.kind !== 'review') await want($, spec.ref, 'sail')

  const how = spec.isAuto ? 'going on by itself' : 'stopping after each commit for you'
  const where = placed.tree === (await rootOf($)) ? 'in your own checkout, where its branch is' : `in its worktree ${placed.tree}`

  return resumed !== undefined
    ? `The Fellowship takes up its quest on ${spec.ref} (${tally(work)}, ${quest.phase}) on ${branch}, ${where}, ${how}.`
    : `The Fellowship sets out on ${spec.ref}, "${spec.title}", on ${branch} from ${placed.base}, ${where}, ${how}: the first task is sent.`
}

/** Sets out on the Elrond plan in force, or the one of the issue named. */
const setOut = async ($: $, isAuto: boolean, ref = ''): Promise<string> => {
  const got = await ask($, 'elrond', 'plan', { json: true, ...(ref !== '' ? { ref } : {}) })
  const made = got.isError ? got.text : parsePlan(got.text)

  if (made === null) return HOW_TO
  if (typeof made === 'string') return made

  const open = unsettledOf(made)

  if (open.length > 0) return `The council's work on ${made.ref} is not settled: ${open.join('; ')}. Settle them in the Elrond pane, then set out.`

  return begin($, { kind: 'plan', ref: made.ref, url: made.url, title: made.title, branch: branchOf(made), isAuto }, made)
}

/** Sets out on an issue as an errand: one task, the whole issue, read through Elrond. */
const errand = async ($: $, input: string, isAuto: boolean): Promise<string> => {
  let issue: { ref?: string; url?: string; title?: string; body?: string; comments?: { author: string; body: string }[]; error?: string }

  try {
    issue = JSON.parse((await ask($, 'elrond', 'issue', { issue: input })).text) as typeof issue
  } catch {
    return 'Elrond did not read the issue: is the Elrond mod loaded?'
  }

  if (issue.error !== undefined || issue.ref === undefined) return issue.error ?? 'Elrond read no issue.'

  const task = errandTask(issue)
  const spec: Spec = { kind: 'errand', ref: issue.ref, url: issue.url ?? '', title: issue.title ?? '', branch: branchOf({ ref: issue.ref, title: issue.title ?? '' }), isAuto, tasks: [task] }

  return begin($, spec, ownPlan(spec))
}

/** Takes up the review comments the Black Gate handed over, on the pull request's own branch. */
const review = async ($: $, given: unknown, isAuto: boolean): Promise<string> => {
  const pr = (typeof given === 'object' && given !== null ? given : {}) as { ref?: unknown; url?: unknown; title?: unknown; branch?: unknown; base?: unknown; comments?: unknown }
  const tasks = reviewTasks(pr.comments)

  if (typeof pr.ref !== 'string' || typeof pr.branch !== 'string' || pr.branch === '') return 'A review is handed over with its pull request (ref, branch) and its comments.'
  if (tasks.length === 0) return `No comment of ${pr.ref} asks for a change: there is nothing to build.`

  const ref = pr.ref.startsWith('review:') ? pr.ref : `review:${pr.ref}`
  const spec: Spec = { kind: 'review', ref, url: typeof pr.url === 'string' ? pr.url : '', title: typeof pr.title === 'string' ? pr.title : '', branch: pr.branch, base: typeof pr.base === 'string' && pr.base !== '' ? pr.base : undefined, isAuto, tasks, pr: typeof pr.url === 'string' ? pr.url : '' }

  return begin($, spec, ownPlan(spec))
}

/** Sends a member on a task: marked doing, chosen by the try and the task, and spawned in the quest's worktree. */
const march = async ($: $, held: FellowshipQuest, made: FellowshipPlan, task: FellowshipTask, attempt: number, retry?: Retry): Promise<void> => {
  const member = memberFor(made, task, attempt, await targetsOf($))
  const last = held.march
  // A task sent again keeps HEAD as it was when it was first sent: a commit made past the proof since stays one
  const head = last !== null && last.taskId === task.id && last.head !== undefined && last.head !== '' ? last.head : (await git($, ['rev-parse', 'HEAD'], held.tree)).out

  await mark($, held, task.id, 'doing')

  const started = await $.agent
    .spawn({ subagentType: `fellowship:${member}`, description: `${MEMBERS[member].title}: task ${task.id}, ${task.title}`, prompt: companionPrompt(held, made, task, member, retry, held.vision), cwd: held.tree })
    .catch((error: unknown) => ({ deny: errorText(error), agentId: undefined }))

  if (started.deny !== undefined) {
    await keep($, held.ref, was => ({ ...was, phase: 'stuck', march: null }))
    await say($, held.ref, `${MEMBERS[member].title} could not be sent on task ${task.id}: ${started.deny}`)

    return
  }

  if (started.agentId !== undefined && started.agentId !== '') fences.set(started.agentId, { root: await rootOf($), tree: held.tree, files: task.files })

  await keep($, held.ref, was => ({ ...was, phase: 'marching', verdictLine: '', march: { taskId: task.id, title: task.title, member, agentId: started.agentId ?? '', attempt, at: Date.now(), answer: '', head, isResumed: false } }))
  await say($, held.ref, '')
}

/** What a quest comes to once every task is behind it: arrived, and on an auto quest that is no review, sailing. */
const arrive = async ($: $, held: FellowshipQuest): Promise<void> => {
  await keep($, held.ref, was => ({ ...was, phase: 'arrived', march: null }))

  if (held.isAuto && held.kind !== 'review') await want($, held.ref, 'sail')
  else await tell($, `every task of ${held.ref} is behind it: ${held.kind === 'review' ? 'push the answers' : 'open the pull request'} from the pane`)
}

/** Sends the next task, or finds the quest arrived. A stuck task is sent again from its first rung, on what the tree holds. */
const sendNext = async ($: $, ref: string): Promise<void> => {
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
const gazeOn = async ($: $, held: FellowshipQuest, made: FellowshipPlan, task: FellowshipTask): Promise<void> => {
  await work($, held.ref, `Galadriel gazes on task ${task.id}…`)

  const sent = await ask($, 'lothlorien', 'gaze', { purpose: purposeOf(held, made, task), ref: held.ref, weight: task.weight, tree: held.tree })

  if (sent.isError || !/gazes/.test(sent.text)) {
    const after = await keep($, held.ref, was => ({ ...was, gazed: task.id, vision: null }))

    await say($, held.ref, `The Mirror did not answer (${sent.text.slice(0, 160)}): task ${task.id} is built without tests first.`)
    if (after !== null) await march($, after, made, task, 1)

    return
  }

  await keep($, held.ref, was => ({ ...was, phase: 'gazing', gazed: task.id, vision: null, march: null }))
}

/** Looks into the Mirror while Galadriel gazes: once she has shown the tests, or that there are none, the task is built. */
const behold = async ($: $, ref: string): Promise<void> => {
  const held = await questOf($, ref)

  if (held === null || held.phase !== 'gazing') return

  const answer = await ask($, 'lothlorien', 'mirror', { json: true, tree: held.tree })
  let shown: { state?: string; tests?: { file: string; name: string }[]; red?: string; why?: string } = {}

  try {
    shown = JSON.parse(answer.text) as typeof shown
  } catch {
    shown = { state: 'unreadable', why: answer.text.slice(0, 200) }
  }

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
const again = async ($: $, ref: string, why: { proof?: string; findings?: string[] }, line: string): Promise<void> => {
  const held = await questOf($, ref)
  const out = held?.march

  if (held === null || out === null || out === undefined) return

  // A proof that does not settle the change, or findings that block it, send its member back once, with all it read
  // and did still in its context, before a fresh member a rung up starts over cold
  if (out.isResumed !== true && (await sendBack($, out.agentId, `fellowship:${out.member}`, sendBackPrompt(why)))) {
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
const headMoved = async ($: $, held: FellowshipQuest): Promise<string | undefined> => {
  const out = held.march

  if (out === null || out.head === undefined || out.head === '') return undefined

  const now = (await git($, ['rev-parse', 'HEAD'], held.tree)).out

  return now === out.head
    ? undefined
    : `HEAD moved from ${out.head.slice(0, 7)} to ${now.slice(0, 7)} while task ${out.taskId} was out: a commit was made past the Argonath's proof and its statues. Put it back as uncommitted work (git reset --soft ${out.head.slice(0, 7)} in ${held.tree}), then put it before the Argonath again.`
}

/** Stops a quest for the person, saying why. */
const stop = async ($: $, held: FellowshipQuest, why: string): Promise<void> => {
  await keep($, held.ref, was => ({ ...was, phase: 'stuck' }))
  await say($, held.ref, why)
  await tell($, `${held.ref} is stuck: ${why.split('\n')[0] ?? why}`)
}

/** Proves what a member built: settled, the statues of the Argonath are sent to judge it; else the task goes up a rung. */
const prove = async ($: $, ref: string): Promise<void> => {
  const held = await questOf($, ref)

  if (held === null || held.phase !== 'proving' || held.march === null) return

  const out = held.march
  const moved = await headMoved($, held)

  if (moved !== undefined) return stop($, held, moved)

  await work($, ref, `Argonath proves task ${out.taskId}…`)

  // The statues are convened here, on the change and what it is for: the proof owes none at the turn's end. Galadriel's
  // tests, written from the task before it was built, must pass for the proof to settle
  const written = held.vision?.taskId === out.taskId ? (held.vision?.tests ?? []) : []
  const proof = await ask($, 'argonath', 'prove', { owe: false, json: true, tree: held.tree, ...(written.length > 0 ? { mustPass: written } : {}) })
  const verdict = proof.isError ? { isSettled: false, isUnlooked: true, line: proof.text, unhandled: [] as string[], text: proof.text } : proofVerdict(proof.text)

  await keep($, ref, was => ({ ...was, proof: verdict.text, proofLine: verdict.line, unproven: verdict.unhandled }))

  // Argonath could not look at what the change reached: no member mends that, and no try is spent on it
  if (verdict.isUnlooked) return stop($, held, `${verdict.line}. No member can mend that: set the target right in .claude/argonath, then put task ${out.taskId} before the Argonath again.`)
  if (!verdict.isSettled) return again($, ref, { proof: verdict.text }, verdict.line)

  const mirror = held.vision?.taskId === out.taskId ? await mirrorOf($, held) : { amendments: [], tampered: [] }

  // What was taken out of Galadriel's tests without a reason blocks the change, as a finding would
  if (mirror.tampered.length > 0) {
    const findings = mirror.tampered.map(one => `- Lothlórien, ${one.file}: locked lines of Galadriel's tests were taken out with no reason given (${one.lines.slice(0, 2).map(line => `\`${line.trim()}\``).join(', ')}). Put them back, or call mcp__lothlorien__amend with the file and why before changing them.`)

    return again($, ref, { findings }, `${findings.length} of Galadriel's test ${findings.length === 1 ? 'file' : 'files'} changed with no reason`)
  }

  await work($, ref, `The statues of the Argonath are sent to judge task ${out.taskId}…`)

  const made = await workOf($, held)
  const task = typeof made === 'string' ? undefined : made.tasks.find(one => one.id === out.taskId)
  const about = typeof made === 'string' || task === undefined ? '' : purposeOf(held, made, task, mirror.amendments)
  // Where nothing proves what the change reached, both statues judge it with their own model; else as the task's weight
  // and risks ask, a task that is not heavy on a lighter model
  const isBlind = typeof made === 'string' || task === undefined || verdict.unhandled.length > 0
  const statues = isBlind ? ['isildur', 'anarion'] : statuesFor(made, task)
  const model = isBlind ? undefined : statueModelFor(made, task)
  const judged = parseJudgement((await ask($, 'argonath', 'judgement', { convene: true, json: true, about, statues, tree: held.tree, ...(model !== undefined ? { model } : {}) })).text)

  await keep($, ref, was => ({ ...was, phase: 'judging', verdictLine: judged.line }))
  await settle($, ref, judged)
}

/** What a member changed of Galadriel's tests and why, and what was taken out of them with no reason, as Lothlórien keeps it. */
const mirrorOf = async ($: $, held: FellowshipQuest): Promise<{ amendments: { file: string; why: string; by: string }[]; tampered: { file: string; lines: string[] }[] }> => {
  try {
    const shown = JSON.parse((await ask($, 'lothlorien', 'mirror', { json: true, tree: held.tree })).text) as { amendments?: { file: string; why: string; by: string }[]; tampered?: { file: string; lines: string[] }[] }

    return { amendments: Array.isArray(shown.amendments) ? shown.amendments : [], tampered: Array.isArray(shown.tampered) ? shown.tampered : [] }
  } catch {
    return { amendments: [], tampered: [] }
  }
}

/** Looks at the statues' judgement of a quest's change, while they sit. */
const judge = async ($: $, ref: string): Promise<void> => {
  const held = await questOf($, ref)

  if (held === null || held.phase !== 'judging') return

  await settle($, ref, parseJudgement((await ask($, 'argonath', 'judgement', { json: true, tree: held.tree })).text))
}

/** What the statues' verdict comes to: committed when they pass the change, sent back up a rung when they find what blocks it. */
const settle = async ($: $, ref: string, judged: ReturnType<typeof parseJudgement>): Promise<void> => {
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
const commitNow = async ($: $, ref: string, minor: readonly string[]): Promise<string> => {
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
  const dirty = await git($, ['status', '--porcelain'], held.tree)
  let sha = ''

  // An errand is the whole issue in one change: none at all means it was built somewhere else, or not at all
  if (dirty.out === '' && held.kind === 'errand') {
    const why = `${by} left no change in ${held.tree} for ${ref}: it is not done. Look at what it says it built, then send it again.`

    await stop($, held, why)

    return why
  }

  // A task that needed no change is done with no commit
  if (dirty.out !== '') {
    const added = await git($, ['add', '-A'], held.tree)
    const done = added.ok ? await git($, ['commit', '-m', commitMessage(held, made, task, by, minor, unproven)], held.tree) : added

    if (!done.ok) {
      await stop($, held, `Task ${task.id} could not be committed: ${done.out}`)

      return `Task ${task.id} could not be committed: ${done.out}`
    }

    sha = (await git($, ['rev-parse', 'HEAD'], held.tree)).out
  }

  await mark($, held, task.id, 'done')

  const after = await keep($, ref, was => ({ ...was, phase: 'ready', march: null, vision: null, proof: '', proofLine: '', verdictLine: '', unproven: [], isWarded: false, commits: [...was.commits, { taskId: task.id, title: task.title, sha, by, minor: [...minor], unproven: [...unproven], answer: out.answer }] }))
  const left = after === null ? made : await workOf($, after)
  const isArrived = typeof left !== 'string' && isAllDone(left)
  const said = `Task ${task.id} of ${ref}, "${task.title}", built by ${by}, passed the Argonath and is committed${sha === '' ? ' (it changed nothing, so it is marked done with no commit)' : ` as ${sha.slice(0, 7)}`}.`

  if (isArrived || after?.isAuto === true) await want($, ref, 'next')
  else await tell($, `${said} The next task waits for you.`)

  return said
}

/** Puts a stuck task's change before the Argonath again: proved, judged, and committed once the statues pass it. */
const resubmit = async ($: $, ref: string): Promise<string> => {
  const held = await questOf($, ref)

  if (held === null) return HOW_TO
  if (held.march === null || held.phase !== 'stuck') return `There is nothing to put before the Argonath: the quest on ${ref} is ${held.phase}.`

  await keep($, ref, was => ({ ...was, phase: 'proving' }))
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
const abandon = async ($: $, ref: string): Promise<string> => {
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

    for (const task of reopened) await ask($, 'elrond', 'task', { id: task.id, state: 'todo', ref: held.ref })
    if (reopened.length > 0) said.push(`${reopened.length} ${reopened.length === 1 ? 'task is' : 'tasks are'} open again in the Elrond plan.`)
  }

  if (held.pr !== '' && held.kind !== 'review') said.push(`Its pull request, ${held.pr}, is left as it is on the forge.`)

  await drop($, ref)
  await update($, wanted, was => was.filter(one => one.ref !== ref))
  await update($, notes, ({ [ref]: _gone, ...rest }) => rest)

  return said.join(' ')
}

/** Pushes the branch and opens the pull request that closes the issue; a review's answers are pushed onto its pull request. */
const sail = async ($: $, ref: string): Promise<string> => {
  const held = await questOf($, ref)

  if (held === null) return HOW_TO
  if (held.phase === 'sailed') return held.kind === 'review' ? `The answers on ${ref} are pushed.` : `The pull request is open: ${held.pr}`
  if (held.phase === 'warding') return `The statues judge the whole branch of ${ref}: the pull request opens once they pass it.`
  if (held.phase !== 'arrived' && !(held.kind === 'review' && (held.phase === 'ready' || held.phase === 'stuck') && held.commits.length > 0)) return `The quest on ${ref} has not arrived: it is ${held.phase}. Every task is committed first.`

  const made = await workOf($, held)

  if (typeof made === 'string') return made

  if (held.kind === 'review') {
    await work($, ref, `Pushing ${held.branch}…`)

    const pushed = await push($, held.branch, held.tree)

    if (!pushed.ok) return `${held.branch} could not be pushed: it may be behind its remote. ${pushed.out.split('\n').slice(-1)[0] ?? ''}`

    await keep($, ref, was => ({ ...was, phase: was.phase === 'arrived' ? 'sailed' : was.phase }))

    return `${held.branch} is pushed: ${held.commits.length} answered ${held.commits.length === 1 ? 'comment is' : 'comments are'} on ${held.pr}.`
  }

  // Each task of a plan was judged alone: both statues judge what the tasks do and let in together, once, before the
  // branch leaves the machine
  if (held.kind === 'plan' && held.isWarded !== true) {
    const judged = parseJudgement((await ask($, 'argonath', 'judgement', { convene: true, json: true, statues: ['isildur', 'anarion'], against: held.base, about: wardPurpose(made), tree: held.tree })).text)

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
const ward = async ($: $, ref: string, judged: ReturnType<typeof parseJudgement>): Promise<string> => {
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
const watchWard = async ($: $, ref: string): Promise<void> => {
  const held = await questOf($, ref)

  if (held === null) return

  const said = await ward($, ref, parseJudgement((await ask($, 'argonath', 'judgement', { json: true, tree: held.tree })).text))

  if (said !== '' && !said.startsWith(WARDING)) await say($, ref, said)
}

// The quests the clock is doing something for now: a proof takes minutes, and that quest's next ask waits for it while
// the others go on. '' stands for setting a new quest out
const busy = new Set<string>()
// Ticks since what a quest waits on was last looked at
let ticks = 0

/** Does one thing asked of a quest, alone for that quest: what came of it is told as well as kept in the pane. */
const act = async ($: $, asked: { ref: string; what: FellowshipWanted | 'look'; arg?: string }): Promise<void> => {
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
            ? await errand($, asked.arg ?? '', what === 'errand auto')
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

/** Does what a press, a command or a turn asked for, a quest at a time; and while a quest waits on the statues or the Mirror, looks now and then. */
const tick = async ($: $): Promise<void> => {
  const queue = await read($, wanted)
  // The first ask of each quest the clock is not already busy with; the rest wait their turn
  const taken = queue.filter((one, at) => !busy.has(one.ref) && queue.findIndex(other => other.ref === one.ref) === at)
  const isSame = (one: (typeof queue)[number], other: (typeof queue)[number]) => one.ref === other.ref && one.what === other.what && one.arg === other.arg

  if (taken.length > 0) await update($, wanted, was => was.filter((one, at) => !taken.some(other => isSame(one, other) && was.findIndex(first => isSame(first, other)) === at)))
  for (const one of taken) void act($, one)

  ticks += 1
  if (ticks % LOOK_EVERY !== 0) return

  for (const held of Object.values(await read($, quests))) {
    if (!busy.has(held.ref) && (held.phase === 'judging' || held.phase === 'gazing' || held.phase === 'warding')) void act($, { ref: held.ref, what: 'look' })
  }
}

/** Runs a call that is not the clock's for a quest, holding the clock off that quest. */
const alone = async <T,>($: $, ref: string, act: () => Promise<T>): Promise<T> => {
  busy.add(ref)

  try {
    return await act()
  } finally {
    busy.delete(ref)
    await update($, working, ({ [ref]: _done, ...rest }) => rest)
  }
}

/** The quest whose member an agent is: by the id its spawn answered, else, where it answered none, by its type. */
const questOfAgent = async ($: $, agentId: string, phase?: FellowshipPhase): Promise<FellowshipQuest | undefined> => {
  const all = Object.values(await read($, quests)).filter(held => held.march !== null && (phase === undefined || held.phase === phase))
  const byId = all.find(held => held.march?.agentId !== '' && held.march?.agentId === agentId)

  if (byId !== undefined) return byId

  const agent = (await $.agent.list().catch(() => [])).find(one => one.id === agentId && one.status === 'running')

  return agent === undefined ? undefined : all.find(held => held.march?.agentId === '' && agent.type === `fellowship:${held.march.member}`)
}

/** What a member is held to: the person's checkout it stays out of, the quest's worktree it works in, its task's files. */
type Fence = { root: string; tree: string; files: readonly string[] }

// The members sent, by agent id, kept where no `$` call is needed to read it: their guard is asked of a call raised
// beneath one of the mod's own, where it can make none, and holds them to their fence alike
const fences = new Map<string, Fence>()

/** Why a member's tool call is refused; nothing when it stays inside its fence. */
const fenced = (fence: Fence, e: unknown): string | undefined => {
  const given = e as { tool?: unknown; command?: unknown; file_path?: unknown; notebook_path?: unknown; path?: unknown }

  if (given.tool === 'Bash' && typeof given.command === 'string') {
    if (isForbiddenGit(given.command)) return 'The Fellowship commits and keeps the branch: leave your change uncommitted, and run no git command that moves HEAD or the index.'
    // A cd into the person's checkout would build the quest there, and move where the mods look with it
    if (reachesOut(fence.root, fence.tree, given.command)) return `You work in the quest's worktree, ${fence.tree}: name no path of the person's checkout outside it, and use paths relative to your working directory.`
  }

  // The file a tool reads or changes, and the folder Grep and Glob search
  const named = [given.file_path, given.notebook_path, given.tool === 'Grep' || given.tool === 'Glob' ? given.path : undefined].find((one): one is string => typeof one === 'string' && one !== '')

  if (named === undefined) return undefined

  const path = resolvedFrom(fence.tree, named)

  if (isOutside(fence.tree, path)) return `You work in the quest's worktree, ${fence.tree}: read and change files there alone.`
  if (isModPath(fence.tree, path)) return 'That folder belongs to a mod: a member changes the project, not what the mods keep.'
  if (isModSource(fence.tree, path, { files: fence.files })) return "That is a mod's source, and your task is not about a mod: say in your account what of it stood in your way, and leave it as it is."

  return undefined
}

/** The fence of an agent the Fellowship sent: as kept when it was sent, else read from the quest it is out on. */
const fenceOf = async ($: $, agentId: string): Promise<Fence | undefined> => {
  const known = fences.get(agentId)

  if (known !== undefined) return known

  const held = await questOfAgent($, agentId)

  if (held === undefined || held.march === null) return undefined

  const task = (await read($, plans))[held.ref]?.tasks.find(one => one.id === held.march?.taskId)
  const fence = { root: await rootOf($), tree: held.tree, files: task?.files ?? [] }

  fences.set(agentId, fence)

  return fence
}

/** The quest a command or a call names, by its ref or its branch; else the one the pane shows, else the only one. */
const namedQuest = async ($: $, named = ''): Promise<FellowshipQuest | null> => {
  const all = await read($, quests)

  if (named !== '') return all[named] ?? Object.values(all).find(one => one.branch === named || one.ref.endsWith(named)) ?? null

  const shown = await read($, selected)

  return all[shown] ?? (Object.values(all).length === 1 ? (Object.values(all)[0] ?? null) : null)
}

const sectionText = (all: readonly FellowshipQuest[]): string =>
  [
    `The Fellowship mod is implementing ${all.length === 1 ? 'an issue' : `${all.length} issues`}, each task by task in a git worktree of its own by builder subagents, each change test-checked, reviewed and committed alone:`,
    ...all.map(held => `- ${held.ref} (${held.kind}): ${held.phase}, in ${held.tree}`),
    "Leave those worktrees to the builders; mcp__fellowship__quest says where each quest stands.",
  ].join('\n')

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'fellowship', description: 'Build an Elrond plan, an errand or a review task by task in a worktree: /fellowship sets out (--auto goes on by itself); errand <issue>; next, commit, sail, halt, abandon [quest]' })

    for (const [name, member] of Object.entries(MEMBERS) as [FellowshipMember, (typeof MEMBERS)[FellowshipMember]][]) {
      await $.agent
        .register({
          name,
          description: `${member.title} of the Fellowship: builds one task of a quest in its worktree, proven and judged by the Argonath. Sent by the Fellowship mod alone.`,
          prompt: memberSystem(name),
          tools: ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash', 'mcp__argonath__radius', 'mcp__argonath__prove', 'mcp__lothlorien__amend'],
          // No permission mode of its own: it builds under the session's, as every agent a mod sends does. The fence
          // the mod holds it to (its worktree, no git that moves the branch, no mod's folder) is the mod's own guard
          disallowedTools: ['Agent', 'mcp__elrond__task', 'mcp__argonath__judgement', 'mcp__fellowship__commit'],
          model: member.model,
          effort: member.effort,
        })
        .catch(() => undefined)
    }

    // A host that registers no tools still starts the session
    for (const tool of [view.tool, ...TOOLS]) await $.tool.register(tool).catch(() => undefined)

    $.clock.every(TICK_MS, () => void tick($).catch(() => undefined))

    // A reload loads the module afresh: a pane drawn by the copy before it is drawn again, so its buttons press this one
    $.ui.invalidate('ui.render')

    return next(e)
  })

  // A member is sent by the Fellowship, never through the Agent tool
  for (const name of Object.keys(MEMBERS)) on('agent.offer', { agent: `fellowship:${name}` }, () => ({ isOffered: false }))

  // The member's turn has ended: what it built is proven, outside this hook; a task it hands back goes to the person
  on('turn.complete', async ($, e, next) => {
    const held = e.agentId === undefined ? undefined : await questOfAgent($, e.agentId, 'marching')

    if (held !== undefined && held.march !== null) {
      const out = { ...held.march, answer: e.answer ?? '' }
      const title = MEMBERS[out.member].title
      const handed = e.isAborted || e.reason !== 'answer' ? undefined : handBackOf(out.answer)

      if (e.isAborted || e.reason !== 'answer') {
        await keep($, held.ref, was => ({ ...was, phase: 'stuck', march: out }))
        await say($, held.ref, `${title} on task ${out.taskId} ${e.isAborted ? 'was interrupted' : e.reason === 'refusal' ? 'refused' : 'ended on an API error'}: send it again from the pane.`)
      } else if (handed !== undefined && held.kind === 'review') {
        // A comment that asks something only the person can answer is theirs, and the quest goes on to the next
        const isClean = (await git($, ['status', '--porcelain'], held.tree)).out === ''

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

    return next(e)
  })

  // The member builds its task in the quest's worktree, and leaves the branch, the commits and the mods' folders to the
  // Fellowship. Where the guard could not look (it failed, or was asked beneath a call of the mod's own), a member it
  // sent is held to its fence alike
  on('tool.call', async ($, e, next) => {
    const agentId = (e as { agentId?: string }).agentId
    const fence = agentId === undefined ? undefined : await fenceOf($, agentId)
    const why = fence === undefined ? undefined : fenced(fence, e)

    return why === undefined ? next(e) : { deny: why }
  }).catch((_$, e, next) => {
    const agentId = (e as { agentId?: string }).agentId
    const fence = next.called || agentId === undefined ? undefined : fences.get(agentId)
    const why = fence === undefined ? undefined : fenced(fence, e)

    return why === undefined ? next(e) : { deny: why }
  })

  // Claude is told of the quests while they are under way
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const all = Object.values(await read($, quests)).filter(held => held.phase !== 'sailed')

    return all.length === 0 ? composed : { sections: [...composed.sections, { id: 'fellowship:quest', text: sectionText(all), scope: 'session' as const }] }
  })

  on('tool.call', { tool: 'mcp__fellowship__pane' }, $ => view.answer(() => $.ui.panes()))

  on('tool.call', { tool: 'mcp__fellowship__set_out' }, async ($, e) => {
    const given = e as unknown as { auto?: unknown; ref?: unknown; kind?: unknown; review?: unknown }
    const isAuto = given.auto === true

    return { result: await alone($, '', () => (given.kind === 'review' ? review($, given.review, isAuto) : setOut($, isAuto, typeof given.ref === 'string' ? given.ref : ''))) }
  })

  on('tool.call', { tool: 'mcp__fellowship__errand' }, async ($, e) => {
    const given = e as unknown as { issue?: unknown; auto?: unknown }

    return { result: await alone($, '', () => errand($, String(given.issue ?? ''), given.auto === true)) }
  })

  on('tool.call', { tool: 'mcp__fellowship__quest' }, async ($, e) => {
    const named = String((e as unknown as { ref?: unknown }).ref ?? '')
    const all = Object.values(await read($, quests)).filter(held => named === '' || held.ref === named || held.branch === named)

    if (all.length === 0) return { result: named === '' ? HOW_TO : `No quest on ${named} is under way.` }

    const texts: string[] = []

    for (const held of all) {
      const made = await workOf($, held)

      texts.push(questText(held, typeof made === 'string' ? ((await read($, plans))[held.ref] ?? null) : made))
    }

    return { result: texts.join('\n\n―――\n\n') }
  })

  on('tool.call', { tool: 'mcp__fellowship__commit' }, async ($, e) => {
    const held = await namedQuest($, String((e as unknown as { ref?: unknown }).ref ?? ''))

    return { result: held === null ? 'Name the quest, by its ref: more than one is under way, or none.' : await resubmit($, held.ref) }
  })

  on('tool.call', { tool: 'mcp__fellowship__relics' }, async $ => ({ result: JSON.stringify(await relics($)) }))

  on('tool.call', { tool: 'mcp__fellowship__forget' }, async ($, e) => {
    const given = e as unknown as { ref?: unknown; pr?: unknown; json?: unknown }
    const done = await forget($, String(given.ref ?? ''), String(given.pr ?? ''))

    return { result: given.json === true ? JSON.stringify(done) : done.text }
  })

  // Pushing and opening the pull request reach outside the machine: no tool offers them to Claude. The person sails with
  // /fellowship sail or the pane, or opted into it up front with --auto. Setting out, sailing and abandoning call other
  // mods, whose hooks answer no call made beneath a command's: the clock makes them
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

      return { text: `The Fellowship sets out on ${named} as an errand: the pane says how it went.` }
    }

    if (verb === '' || verb === 'set') {
      // Every quest under way is shown, unless the person asks to set out: /fellowship set out [issue]
      const all = Object.values(await read($, quests))
      const shown = await read($, plans)

      if (all.length > 0 && !isAuto && verb === '') return { text: all.map(held => questLine(held, shown[held.ref] ?? null)).join('\n') }

      await want($, '', isAuto ? 'set out auto' : 'set out', verb === 'set' ? (plain[2] ?? '') : '')

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

      return { text: `A member is sent on the next task of ${held.ref}.` }
    }

    if (verb === 'commit') return { text: await resubmit($, held.ref) }
    if (verb === 'sail') {
      await want($, held.ref, 'sail')

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
    const press = (ref: string, what: FellowshipWanted) => want($, ref, what)
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
            <Text bold>{`${MEMBERS[out.member].title} on task ${out.taskId}: ${out.title}`}</Text>
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
            <Button key="commit" hotkey="c" onPress={() => resubmit($, held.ref).then(text => say($, held.ref, text))}>
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
