import { approve, reattend } from './attended'
import { BUDGET_WINDOW, beforeTicket, clockTime, isOverBudget } from './budget'
import type { Settings } from './budget'
import { REVIEWER_TOOLS, finish, finished } from './finisher'
import { readFolders, readRecord, writeRecord, writeStatus } from './folders'
import type { Host } from './host'
import { SCRATCH, folderOf, issuesOf, kept, specOf } from './run'
import type { RunRecord, UsageReading } from './run'
import { READING_GIT, SHELL_REFUSAL, isAllowedShell } from './shell'
import { verificationOf } from './spec'
import { blockedBy, frontier, label, problemsOf } from './tickets'
import type { Ticket } from './tickets'
import { discard, git, launch, readUsage, tail, verify } from './work'

/** The agent type that builds a ticket, as the mod registers it and as the engine names it. */
export const IMPLEMENTER = 'implementer'
export const IMPLEMENTER_TYPE = `ship-flow:${IMPLEMENTER}`

/** What the implementer may call. Its shell is narrowed further, command by command, by `checkTool`. */
export const IMPLEMENTER_TOOLS = ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash'] as const

export const IMPLEMENTER_PROMPT = [
  'You build one ticket of a spec, alone and unattended. Nobody can answer a question: decide, and say what you decided in your report.',
  '',
  'You are given two paths: the spec and your ticket. Read both first. The ticket says what to build and lists its acceptance criteria; the spec holds the decisions, the vocabulary and the seams to test at. Build the ticket and nothing beyond it. Its `**Touches:**` line is the estimate the person approved, not a constraint: change another file when the work needs it.',
  '',
  'Work test-first at the seams the spec names: write a failing test for one behaviour, make it pass, then the next. Match the code around you.',
  '',
  'Your shell runs only these: the commands under the spec\'s "Verification" heading, exactly as written, and git status, diff, log, show, blame, ls-files, grep, rev-parse, mv, rm and add. One command per call, from the repo root, with nothing joined to it. Any other command is refused and does not run, so use the file tools to read, search and edit. Do not commit: the run commits your work after it has run the verification commands itself.',
  '',
  'You are done when every acceptance criterion holds and every verification command passes. Tick the criteria you met in the ticket file and leave its Status line alone. End with a short report: what you built, what you decided, and anything left undone.',
].join('\n')

/** How many times a ticket is attempted before it is marked `blocked`: once, and one retry. */
export const ATTEMPTS = 2

type Failure = NonNullable<RunRecord['failure']>

const named = (ticket: Ticket): string => `${label(ticket.number ?? 0)} ${ticket.title}`

// A feature's tickets as their files now say
const ticketsOf = async (host: Host, feature: string): Promise<readonly Ticket[]> =>
  (await readFolders(host)).find(folder => folder.feature === feature)?.tickets ?? []

/**
 * Starts the implementer of one ticket: the ticket is `in-progress` and the record names it and its agent. A
 * retry is told why the attempt before it was discarded. Answers what it did, as the end of a sentence.
 */
const start = async (host: Host, settings: Settings, record: RunRecord, ticket: Ticket): Promise<string> => {
  const { feature } = record
  const key = label(ticket.number ?? 0)
  // The ticket's failed attempt of this same walk, if it had one
  const retryOf = (record.attempts[key] ?? 0) > 0 && record.failure?.ticket === ticket.number ? record.failure : undefined
  const started: RunRecord = {
    ...kept(record),
    phase: 'unattended',
    ...(ticket.number !== undefined ? { ticket: ticket.number } : {}),
    attempts: { ...record.attempts, [key]: (record.attempts[key] ?? 0) + 1 },
    usage: await readUsage(host),
  }

  await writeStatus(host, feature, ticket, 'in-progress')
  await writeRecord(host, started)

  const launched = await launch(host, {
    subagentType: IMPLEMENTER_TYPE,
    description: `Build ticket ${key}`,
    model: ticket.model ?? settings.implementerModel,
    // Pointers, not content: the implementer reads the spec and the ticket in its own window
    prompt: [
      `Build the ticket ${issuesOf(feature)}/${ticket.file} of the spec ${specOf(feature)}.`,
      ...(retryOf
        ? [
            '',
            `A first attempt at this ticket was discarded: ${retryOf.reason}. Nothing of it is left in the working tree.`,
            ...(retryOf.output ? ['What the failure said:', '', retryOf.output] : []),
          ]
        : []),
    ].join('\n'),
  })

  if ('why' in launched) {
    const why = `the implementer could not start: ${launched.why}`

    await writeStatus(host, feature, ticket, 'ready')
    await writeRecord(host, { ...started, phase: 'paused', pause: why })

    return `${named(ticket)} was not started: ${why}`
  }

  await writeRecord(host, { ...started, agentId: launched.agentId })

  return `building ${named(ticket)} on ${launched.model}, on branch ${record.branch}`
}

// What the quota says before a ticket starts, as the run words it; undefined when the ticket may start
const holdOf = (usage: UsageReading, settings: Settings): { pause: string; resumeAt?: number; isOver?: true } | undefined => {
  const verdict = beforeTicket(usage, settings)

  if (verdict.kind === 'start') return undefined
  if (verdict.kind === 'stop') return { pause: `the weekly quota window is at ${verdict.percentUsed}%`, isOver: true }

  return {
    pause: `the 5-hour quota window is at ${verdict.percentUsed}%: the run goes on by itself at ${clockTime(verdict.until)}`,
    resumeAt: verdict.until,
  }
}

/**
 * Takes the run one step on: marks `blocked` every ticket that can no longer be reached, then starts the first
 * ticket of the frontier. When none can be taken, or the weekly quota is nearly spent, the building is over and
 * the run goes on to its end: the review and the pull request.
 */
const advance = async (host: Host, settings: Settings, record: RunRecord): Promise<string> => {
  const { feature } = record

  for (const unreachable of blockedBy(await ticketsOf(host, feature))) {
    await writeStatus(host, feature, unreachable, 'blocked')
  }

  const tickets = await ticketsOf(host, feature)
  const ticket = frontier(tickets)[0]
  const count = (status: string) => tickets.filter(t => t.status === status).length
  const left = ['blocked', 'too-large'].map(status => ({ status, n: count(status) })).filter(({ n }) => n > 0)
  const stand = [`${count('done')} of ${tickets.length} done`, ...left.map(({ status, n }) => `${n} ${status}`)].join(', ')

  if (!ticket) return `no ticket left to take: ${stand}; ${await finish(host, settings, record)}`

  const usage = await readUsage(host)
  const hold = holdOf(usage, settings)

  if (!hold) return start(host, settings, record, ticket)

  // A weekly window is days from resetting: waiting does not help, so the run ends on what it has
  if (hold.isOver) return `${hold.pause}, so the building stops: ${stand}; ${await finish(host, settings, record)}`

  // No ticket starts on a quota window that is nearly spent: it would be cut off halfway
  await writeRecord(host, { ...kept(record), phase: 'paused', pause: hold.pause, ...(hold.resumeAt !== undefined ? { resumeAt: hold.resumeAt } : {}), usage })
  host.notify(`${feature} is paused: ${hold.pause}.`)
  if (hold.resumeAt !== undefined) {
    host.after(Math.max(hold.resumeAt - usage.at, 0), () => void wake(host, settings, feature))
  }

  return `paused: ${hold.pause}`
}

/**
 * The timer of a run paused for quota: the run goes on if it is still paused and waiting, which it is not when
 * the person resumed it in the meantime. A window still over its threshold pauses it again.
 */
async function wake(host: Host, settings: Settings, feature: string): Promise<void> {
  try {
    const record = await readRecord(host, feature)

    if (record?.phase !== 'paused' || record.resumeAt === undefined) return

    host.log(`${feature}: the quota window has reset; ${await advance(host, settings, { ...kept(record), phase: 'unattended' })}.`)
  } catch (error) {
    host.log(`${feature}: could not go on after the pause: ${error instanceof Error ? error.message : String(error)}. /ship resume.`)
  }
}

const isAtWork = (record: RunRecord | undefined): record is RunRecord & { agentId: string } =>
  (record?.phase === 'unattended' || record?.phase === 'finishing') && record.agentId !== undefined

/**
 * `/ship resume [feature]`: starts, or takes up again, the walk of a feature's ticket graph. Answers what it did,
 * or why it did nothing. From there each ticket's end, `complete`, takes the next one.
 */
export const resume = async (host: Host, settings: Settings, wanted: string): Promise<string> => {
  const folders = await readFolders(host)

  if (folders.length === 0) return 'No run in this repo: there is no .scratch/<feature>/issues folder.'

  const folder = wanted === '' && folders.length === 1 ? folders[0] : folders.find(f => f.feature === wanted)

  if (!folder) {
    const names = folders.map(f => f.feature).join(', ')

    return wanted === ''
      ? `Several runs here: ${names}. Name one: /ship resume <feature>.`
      : `No run named ${wanted}. Here: ${names}.`
  }

  const { feature, tickets } = folder
  const refusals = problemsOf(tickets).map(
    problem => `${problem.number !== undefined ? label(problem.number) : problem.file} ${problem.reason}`,
  )
  const spec = (await host.exists(specOf(feature))) ? await host.read(specOf(feature)) : undefined
  const verification = spec === undefined ? [] : verificationOf(spec)

  // Nothing to approve yet: the attended phase is not over, and the conversation that held it may be gone
  if (folder.record?.phase === 'attended' && (spec === undefined || tickets.length === 0)) {
    return reattend(host, settings, folder.record)
  }

  if (spec === undefined) refusals.push(`there is no spec at ${specOf(feature)}`)
  else if (verification.length === 0) refusals.push('the spec has no Verification section naming the commands to run')
  if (tickets.length === 0) refusals.push(`there are no tickets in ${issuesOf(feature)}/`)
  if (refusals.length > 0) return [`${feature}: cannot be run`, ...refusals.map(reason => `  ${reason}`)].join('\n')

  const record = await readRecord(host, feature)

  if (isAtWork(record) && (await host.agents()).some(agent => agent.id === record.agentId && agent.isRunning)) {
    return record.phase === 'finishing'
      ? `${feature}: the branch is being ${record.stage === 'fix' ? 'fixed' : 'reviewed'} now.`
      : `${feature}: ticket ${label(record.ticket ?? 0)} is being built now.`
  }

  // A failed ticket's changes are discarded with everything untracked: the run's own files must be ignored by git
  if ((await git(host, 'check-ignore', '-q', folderOf(feature))).exitCode !== 0) {
    return `${feature}: ${SCRATCH}/ is not ignored by git. Add it to .gitignore, commit that, then /ship resume.`
  }

  // The checkpoint: this command, typed by the person on a run still with them, is the approval
  if (record?.phase === 'attended') {
    const approved = await approve(host, record)

    if ('refusal' in approved) return `${feature}: cannot start: ${approved.refusal}.`

    return `${feature}: approved, on branch ${approved.branch}; ${await advance(host, settings, { ...approved, startUsage: await readUsage(host) })}.`
  }

  const interrupted = tickets.filter(ticket => ticket.status === 'in-progress')

  if (isAtWork(record) || interrupted.length > 0) {
    // The run was cut off mid-work: what its agent left behind is the run's own, and the work is done anew
    await discard(host)
    for (const ticket of interrupted) await writeStatus(host, feature, ticket, 'ready')
  } else if ((await git(host, 'status', '--porcelain')).stdout.trim() !== '') {
    // and a run only starts where there is nothing of the person's to lose
    return `${feature}: the working tree has uncommitted changes. Commit or stash them, then /ship resume.`
  }

  const branch = (await git(host, 'rev-parse', '--abbrev-ref', 'HEAD')).stdout.trim()
  // What the run has built and opened so far stays; the person's own resume gives every ticket its attempts back
  const carried: Partial<RunRecord> = record ? kept(record) : {}

  delete carried.failure

  const startUsage = record?.startUsage ?? (await readUsage(host))

  return `${feature}: ${await advance(host, settings, { ...carried, feature, branch, phase: 'unattended', attempts: {}, startUsage })}.`
}

// The run this agent is at work for, if it is one: an implementer's, or its reviewer's
const flightOf = async (host: Host, agentId: string) => {
  for (const { feature, tickets, record } of await readFolders(host)) {
    if (isAtWork(record) && record.agentId === agentId) return { feature, tickets, record }
  }

  return undefined
}

/**
 * The permission decision for a tool call made in a subagent's loop. For an agent of a run it is the run's to
 * make, so that nothing is ever asked of a person who is not there: its listed tools are allowed, and its shell
 * only the commands `isAllowedShell` admits. A refused command does not run and costs the agent nothing else: it
 * is told what its shell runs and works on, and the run judges the work by its verification as any. Any other
 * agent: undefined.
 */
export const checkTool = async (
  host: Host,
  agentId: string,
  tool: string,
  input: unknown,
): Promise<{ decision: 'allow' } | { decision: 'deny'; reason: string } | undefined> => {
  const flight = await flightOf(host, agentId)

  if (!flight) return undefined

  const { record } = flight
  const isReviewer = record.phase === 'finishing' && record.stage === 'review'
  const tools: readonly string[] = isReviewer ? REVIEWER_TOOLS : IMPLEMENTER_TOOLS
  const role = isReviewer ? 'reviewer' : 'implementer'

  // Past its context budget the implementer gets nothing more done: this is how the run stops it
  if (record.tooLarge !== undefined) {
    if (record.isStopped !== true) await writeRecord(host, { ...record, isStopped: true })

    return {
      decision: 'deny',
      reason: 'ship-flow: this ticket has outgrown its context budget and is stopped. Call no more tools: end your turn now.',
    }
  }

  if (tool !== 'Bash') {
    return tools.includes(tool) ? { decision: 'allow' } : { decision: 'deny', reason: `ship-flow: the ${role} has no ${tool} tool.` }
  }

  const command = String((input as { command?: unknown } | null)?.command ?? '')

  if (isReviewer) {
    return isAllowedShell(command, [], READING_GIT)
      ? { decision: 'allow' }
      : { decision: 'deny', reason: 'ship-flow: the reviewer runs only the git commands that read the repo.' }
  }
  return isAllowedShell(command, verificationOf(await host.read(specOf(flight.feature))))
    ? { decision: 'allow' }
    : { decision: 'deny', reason: SHELL_REFUSAL }
}

/**
 * One response of a subagent, by how full its context was when it was made. A run's implementer that has passed
 * the ticket's context budget is marked so: its work from here on would be worse, and the ticket is too large for
 * one window. `checkTool` then refuses whatever it calls next, which is what stops it (the engine's own call to
 * abort a turn does not stop a subagent's), and `complete` discards the attempt.
 */
export const measure = async (
  host: Host,
  settings: Settings,
  step: { agentId: string; tokens: number },
): Promise<void> => {
  const flight = await flightOf(host, step.agentId)

  // The budget is a ticket's: the review and the fix pass are not held to it
  if (!flight || flight.record.phase !== 'unattended') return

  const { record } = flight
  const key = label(record.ticket ?? 0)
  const isStopping = record.tooLarge === undefined && isOverBudget(step.tokens, settings)

  if (!isStopping && step.tokens <= (record.peak?.[key] ?? 0)) return

  await writeRecord(host, {
    ...record,
    peak: { ...record.peak, [key]: Math.max(step.tokens, record.peak?.[key] ?? 0) },
    ...(isStopping ? { tooLarge: step.tokens } : {}),
  })
}

// What is wrong with a finished attempt, or, when nothing is, the commit that now holds it
const settle = async (
  host: Host,
  feature: string,
  ticket: Ticket,
  record: RunRecord,
  reason: string,
): Promise<{ commit: string } | { reason: string; output?: string }> => {
  if (reason !== 'answer') return { reason: `the implementer's turn ended with ${reason}` }

  const failed = await verify(host, feature)

  if (failed) return failed
  if ((await git(host, 'status', '--porcelain')).stdout.trim() === '') return { reason: 'the implementer changed nothing' }

  await git(host, 'add', '-A')

  const committed = await git(host, 'commit', '-m', `${feature}: ${ticket.title}`)

  if (committed.exitCode !== 0) return { reason: 'the commit failed', output: tail(committed.stderr || committed.stdout) }

  return { commit: (await git(host, 'rev-parse', '--short', 'HEAD')).stdout.trim() }
}

/**
 * The end of the turn of an agent of a run. An implementer's: the run verifies the work itself and commits it,
 * and the ticket is `done`; or it discards the work and tries once more with a fresh implementer; or, the retry
 * having failed too, the ticket is `blocked`; then the run goes on to the next ticket. The reviewer's, or the fix
 * pass's: the run goes on towards its pull request. A line each goes to the transcript; the model is not told.
 */
export const complete = async (
  host: Host,
  settings: Settings,
  turn: { agentId: string; reason: string; answer: string },
): Promise<void> => {
  const flight = await flightOf(host, turn.agentId)

  if (!flight) return

  const { feature, record } = flight

  if (record.phase === 'finishing') {
    host.log(`${feature}: ${await finished(host, settings, IMPLEMENTER_TYPE, flight, turn)}.`)

    return
  }

  const ticket = flight.tickets.find(t => t.number === record.ticket)

  if (!ticket) return

  const key = label(ticket.number ?? 0)

  // Stopped for its size: another attempt would only fill another window, so the ticket is the person's to split.
  // An implementer that passed the budget on its last response was refused nothing, and its work is judged as any.
  if (record.tooLarge !== undefined && record.isStopped === true) {
    const share = Math.round((record.tooLarge / BUDGET_WINDOW) * 100)

    await discard(host)
    await writeStatus(host, feature, ticket, 'too-large')
    host.log(
      `${feature}: ${named(ticket)} was stopped at ${share}% of a context window and is marked too-large: split it; ${await advance(host, settings, record)}.`,
    )

    return
  }

  const settled = await settle(host, feature, ticket, record, turn.reason)

  if ('commit' in settled) {
    await writeStatus(host, feature, ticket, 'done')

    const built = { ...record, commits: { ...record.commits, [key]: settled.commit } }

    host.log(`${feature}: ${named(ticket)} is done (${settled.commit}); ${await advance(host, settings, built)}.`)

    return
  }

  const failure: Failure = { ticket: ticket.number ?? 0, reason: settled.reason, ...(settled.output ? { output: settled.output } : {}) }
  const failed = { ...record, failure }

  await discard(host)

  if ((record.attempts[key] ?? 0) < ATTEMPTS) {
    // Back on the frontier, where it is the first to be taken: the walk tries it once more, quota allowing
    await writeStatus(host, feature, ticket, 'ready')

    const retry = await advance(host, settings, failed)

    host.log(`${feature}: ${named(ticket)} failed (${settled.reason}) and its changes were discarded; once more: ${retry}.`)

    return
  }

  await writeStatus(host, feature, ticket, 'blocked')

  const blocked = { ...failed, reasons: { ...record.reasons, [key]: settled.reason } }

  host.log(
    `${feature}: ${named(ticket)} failed again (${settled.reason}) and is marked blocked; ${await advance(host, settings, blocked)}.`,
  )
}
