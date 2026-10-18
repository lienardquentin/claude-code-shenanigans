import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, TurnUsage } from 'claude-code'
import type { SentAgent, SpentTurn, RunKind, RunPhase, RunWork, Run, RunTask, RunAsk } from '../../types'
import { HOW_TO, MARK, BUILDERS, isAllDone, issueRefOf, ownPlan, runLine, runText, reviewTasks, spentOn, tally, triesOf } from '../../core/run'
import { canMove, restingPhase } from '../../core/phases'
import * as loop from '../../core/build'
import { budgetOf, fillOf } from '../../core/budget'
import type { Budget, Quota } from '../../core/budget'
import type { Ports, Spec } from '../../core/build'
import { WARDING, runFromStore } from '../../core/run'
import { errorText, forgeIn, gitRootOf, removeTree, isMergedFrom, rootOf, sendBack, shellIn, toolFailed, treePathOf } from '../flow'
import type { Section, TurnEnded } from '../flow'
import { badge } from '../kit/badge'
import type { Tone } from '../kit/badge'
import { paneView } from '../kit/pane-text'
import { clip, clockOf, homePath, keyed, shortRef } from '../look'
import { askToPump, inFrame, remember, spawnIn, stopAgent, typeOf } from '../agents'
import { SPEND_FILE, costLine, costText, record, spendOf, spends } from '../spend'
import { markTask, planFor, readIssue, settlePlanAlone, takeSetOut } from '../planner/register'
import { writeTestsFor, testsFirstIn } from '../tests-first/register'
import { judgementFor, proveFor, standardsText, targetsKnown } from '../verify/register'

type $ = EngineInterface
type On = Parameters<Register>[0]

const PANE = 'build'
const TITLE = 'Build'
// How often the clock looks for what a press, a command or a turn asked for
const TICK_MS = 500
// Where a run is kept across sessions, by its ref
const STORE_KEY = (ref: string) => `run:${ref}`

const quests = atom({ plugin: 'pipeline', key: 'buildRuns' } as const, {} as Record<string, Run>)
const plans = atom({ plugin: 'pipeline', key: 'buildWork' } as const, {} as Record<string, RunWork>)
const notes = atom({ plugin: 'pipeline', key: 'buildNotes' } as const, {} as Record<string, string>)
const working = atom({ plugin: 'pipeline', key: 'buildWorking' } as const, {} as Record<string, string>)
const wanted = atom({ plugin: 'pipeline', key: 'buildWanted' } as const, [] as { ref: string; what: RunAsk; arg?: string }[])
const selected = atom({ plugin: 'pipeline', key: 'buildSelected' } as const, '')
const spent = atom({ plugin: 'pipeline', key: 'buildSpent' } as const, {} as Record<string, string>)

export const buildView = paneView({ id: PANE, title: TITLE, command: '/build' })
const view = buildView

// Where the runs stop spending, as the person set it on the mod
let budget: Budget = budgetOf(undefined)

/** Takes where the runs stop spending from the mod's options. */
export function setBudget(options: Readonly<Record<string, unknown>> | undefined): void {
  budget = budgetOf(options)
}

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


/** The ports the core's loop stands on, made of `$`: the runs held in the session and kept across it, the pane, the agents, the parts. */
function portsOf($: $): Ports {
  return {
    runs: {
      at: ref => runAt($, ref),
      all: async () => Object.values(await read($, quests)),
      keep: (ref, change) => keep($, ref, change),
      put: (held, made) => put($, held, made),
      setWork: async (ref, made) => void (await update($, plans, was => ({ ...was, [ref]: made }))),
      stored: async ref => runFromStore(await $.store.get(STORE_KEY(ref)).catch(() => undefined)) ?? null,
      drop: ref => drop($, ref),
    },
    board: {
      say: (ref, text) => say($, ref, text),
      working: (ref, text) => work($, ref, text),
      want: (ref, what, arg) => want($, ref, what, arg),
      unwant: async ref => void (await update($, wanted, was => was.filter(one => one.ref !== ref))),
      tell: text => tell($, text),
      show: ref => show($, ref),
      forget: async ref => void (await update($, notes, ({ [ref]: _gone, ...rest }) => rest)),
    },
    agents: {
      send: asked => spawnIn($, { subagentType: typeOf(asked.builder), description: asked.description, prompt: asked.prompt, cwd: asked.cwd }),
      sendBack: (agentId, builder, text) => sendBack($, agentId, typeOf(builder), text),
      remember: (agentId, sent) => remember($, agentId, sent),
      stop: (agentId, why) => stopAgent($, agentId, why),
    },
    parts: {
      planFor: ref => planFor($, ref),
      markTask: (id, state, ref) => markTask($, id, state, ref),
      readIssue: input => readIssue($, input),
      writeTestsFor: (purpose, ref, weight, tree) => writeTestsFor($, purpose, ref, weight, tree),
      testsFirstIn: tree => testsFirstIn($, tree),
      proveFor: (tree, mustPass) => proveFor($, tree, mustPass),
      judgementFor: (tree, asked) => judgementFor($, tree, asked),
      targetsKnown: () => targetsKnown($),
      standardsText: () => standardsText($),
      isMergedFrom: (url, branch) => isMergedFrom($, url, branch),
      settleAlone: ref => settlePlanAlone($, ref),
      spentOn: async held => {
        const root = await rootOf($)

        return costText(spentOn(held, root, await spends($, root)))
      },
    },
    machine: {
      root: () => rootOf($),
      shell: cwd => shellIn($, cwd),
      forge: (kind, cwd) => forgeIn($, kind, cwd),
      removeTree: (root, tree) => removeTree($, root, tree),
      write: (path, text) => $.fs.write(path, text),
      treePath: (root, branch) => treePathOf(root, branch),
    },
    clock: { now: () => Date.now(), quota: () => quotaOf($) },
    budget,
  }
}

/** The quota as the session last read it; nothing where it has no reading. */
async function quotaOf($: $): Promise<Quota | undefined> {
  const { rateLimits } = await $.session.usage()

  return rateLimits.length === 0 ? undefined : { at: Date.now(), windows: rateLimits.map(({ kind, percentUsed, resetsAt }) => ({ kind, percentUsed, ...(resetsAt !== undefined ? { resetsAt } : {}) })) }
}

/** Holds a run set out afresh, and its work, and keeps it across sessions. */
async function put($: $, held: Run, made: RunWork): Promise<void> {
  await update($, quests, was => ({ ...was, [held.ref]: held }))
  await update($, plans, was => ({ ...was, [held.ref]: made }))
  await $.store.set(STORE_KEY(held.ref), held).catch((error: unknown) => $.ui.toast(`Build: ${held.ref} could not be kept for the next session: ${errorText(error)}`))
}

/** Shows a run in the pane. */
async function show($: $, ref: string): Promise<void> {
  await update($, selected, () => ref)
  await $.ui.open({ id: PANE, title: TITLE }).catch(() => undefined)
}

// The loop's steps, as the mod's hooks, its pane and its clock call them
function workOf($: $, held: Run): Promise<RunWork | string> {
  return loop.workOf(portsOf($), held)
}
function begin($: $, spec: Spec, made: RunWork): Promise<string> {
  return loop.begin(portsOf($), spec, made)
}
function setOut($: $, isAuto: boolean, ref = ''): Promise<string> {
  return loop.setOut(portsOf($), isAuto, ref)
}
function errand($: $, input: string, isAuto: boolean, isPersons: boolean): Promise<string> {
  return loop.errand(portsOf($), input, isAuto, isPersons)
}
function sendNext($: $, ref: string): Promise<void> {
  return loop.sendNext(portsOf($), ref)
}
function behold($: $, ref: string): Promise<void> {
  return loop.behold(portsOf($), ref)
}
function prove($: $, ref: string): Promise<void> {
  return loop.prove(portsOf($), ref)
}
function judge($: $, ref: string): Promise<void> {
  return loop.judge(portsOf($), ref)
}
function watchWard($: $, ref: string): Promise<void> {
  return loop.watchWard(portsOf($), ref)
}
function sail($: $, ref: string): Promise<string> {
  return loop.sail(portsOf($), ref)
}
function resubmit($: $, ref: string): Promise<string> {
  return loop.resubmit(portsOf($), ref)
}
function abandon($: $, ref: string): Promise<string> {
  return loop.abandon(portsOf($), ref)
}
function abandonRefusal($: $, held: Run): Promise<string | undefined> {
  return loop.abandonRefusal(portsOf($), held)
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
  // A run held for the quota is asked for its next task once its time has come
  await loop.wakeHeld(portsOf($))
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

  if (held !== undefined) await loop.builderEnded(portsOf($), held, e)
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
  // Each response of a builder says how full its context is: one past its budget is stopped there
  on('turn.step', async function* ($, e, next) {
    const response = yield* next(e)

    if (e.agentId !== undefined && response.usage !== null) {
      const held = await runOfAgent($, e.agentId, 'building')

      if (held !== undefined) await loop.measure(portsOf($), held, e.agentId, fillOf(response.usage))
    }

    return response
  })
    // A response is never held back by the run: what the model answered stands
    .catch(async function* (_$, e, next) {
      return yield* next(e)
    })

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
      // What would refuse it is said here, not found by the clock after the command has answered
      const refused = await abandonRefusal($, held)

      if (refused !== undefined) return { text: refused }
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
    const isSailable = held.phase === 'built' || (held.kind === 'review' && held.phase !== 'submitted' && !loop.OUT.includes(held.phase) && held.commits.length > 0)

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
