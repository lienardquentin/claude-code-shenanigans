import type { Run, RunTask, RunWork } from '../../types'
import { UNMODDED } from '../change'
import { gitRunsOf } from '../git'
import { clockTime, holdOf, isOverBudget, shareOf } from '../budget'
import { errorText } from '../kit'
import { BUILDERS, afterFailedTry, afterGaze, besideOf, briefFor, handBackOf, isAllDone, issueRefOf, laneBranchOf, laneRefOf, nextTask, purposeOf, readyTasks, sendBackPrompt, triesOf } from '../run'
import type { Retry, Seen, Why } from '../run'
import { budgetIn, gitAt, workOf, mark } from './ports'
import type { Ports, BuilderTurn } from './ports'
import { placeTree } from './start'

// A task sent: its tests written first, a builder sent on it (or held for the quota, or out in a lane), and what
// comes of the builder's turn.

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
  else await p.board.tell(`every task of ${held.ref} is done: ${held.kind === 'review' ? 'push the answers' : 'open the pull request'} from the build pane, or with /theseus build submit`)
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
export async function holdFor(p: Ports, held: Run, task: RunTask, hold: { why: string; until?: number; isOver?: true }): Promise<void> {
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
  await p.board.working(held.ref, `Writing the tests of task ${task.id} first…`)

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
    await p.board.say(held.ref, held.kind === 'errand' ? `${title} hands ${held.ref} back: it is not an errand. ${handed} Abandon it, then plan it with /theseus plan ${held.ref}.` : `${title} stops on task ${out.taskId}: the plan must be revised. ${handed} Revise it in the planner pane, then send the task again.`)
    await p.board.tell(`${title} hands ${held.ref} back: ${handed}`)
  } else {
    await p.runs.keep(held.ref, was => ({ ...was, phase: 'proving', current: out }))
    await p.board.want(held.ref, 'prove')
  }
}
