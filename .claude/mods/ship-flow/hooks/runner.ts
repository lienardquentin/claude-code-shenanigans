import { beforeTicket, clockTime } from './budget'
import type { Settings } from './budget'
import { readFolders, readRecord, writeRecord, writeStatus } from './folders'
import type { Host } from './host'
import { SCRATCH, folderOf, issuesOf, specOf } from './run'
import type { RunRecord, UsageReading } from './run'
import { isAllowedShell, isWindowsPath, shellArgv } from './shell'
import { verificationOf } from './spec'
import { blockedBy, frontier, label, problemsOf } from './tickets'
import type { Ticket } from './tickets'

/** The agent type that builds a ticket, as the mod registers it and as the engine names it. */
export const IMPLEMENTER = 'implementer'
export const IMPLEMENTER_TYPE = `ship-flow:${IMPLEMENTER}`

/** What the implementer may call. Its shell is narrowed further, command by command, by `checkTool`. */
export const IMPLEMENTER_TOOLS = ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash'] as const

export const IMPLEMENTER_PROMPT = [
  'You build one ticket of a spec, alone and unattended. Nobody can answer a question: decide, and say what you decided in your report.',
  '',
  'You are given two paths: the spec and your ticket. Read both first. The ticket says what to build and lists its acceptance criteria; the spec holds the decisions, the vocabulary and the seams to test at. Build the ticket and nothing beyond it.',
  '',
  'Work test-first at the seams the spec names: write a failing test for one behaviour, make it pass, then the next. Match the code around you.',
  '',
  'Your shell runs only these: the commands under the spec\'s "Verification" heading, exactly as written, and git status, diff, log, show, blame, ls-files, grep, rev-parse, mv, rm and add. Any other command is refused and fails the ticket, so use the file tools to read, search and edit. Do not commit: the run commits your work after it has run the verification commands itself.',
  '',
  'You are done when every acceptance criterion holds and every verification command passes. Tick the criteria you met in the ticket file and leave its Status line alone. End with a short report: what you built, what you decided, and anything left undone.',
].join('\n')

/** How many times a ticket is attempted before it is marked `blocked`: once, and one retry. */
export const ATTEMPTS = 2

// A verification command may run as long as the host lets a process run
const VERIFY_TIMEOUT_MS = 10 * 60 * 1000

// How much of a failing command's output is kept for the next attempt and for the person
const OUTPUT_KEPT = 4000

type Failure = NonNullable<RunRecord['failure']>

const tail = (text: string): string => (text.length > OUTPUT_KEPT ? `…${text.slice(-OUTPUT_KEPT)}` : text)

const named = (ticket: Ticket): string => `${label(ticket.number ?? 0)} ${ticket.title}`

const git = (host: Host, ...args: string[]) => host.run(['git', ...args])

// Leaves the working tree as the last commit has it: what an attempt changed and what it created
const discard = async (host: Host) => {
  await git(host, 'reset', '--hard', 'HEAD')
  await git(host, 'clean', '-fd')
}

// The session's own figures now, stamped with the time they were read
const readUsage = async (host: Host): Promise<UsageReading> => ({ at: await host.now(), ...(await host.usage()) })

// A feature's tickets as their files now say
const ticketsOf = async (host: Host, feature: string): Promise<readonly Ticket[]> =>
  (await readFolders(host)).find(folder => folder.feature === feature)?.tickets ?? []

// What of a record outlives one attempt
const kept = (record: RunRecord) => ({
  feature: record.feature,
  branch: record.branch,
  attempts: record.attempts,
  ...(record.failure ? { failure: record.failure } : {}),
})

/**
 * Starts the implementer of one ticket: the ticket is `in-progress` and the record names it and its agent. A
 * retry is told why the attempt before it was discarded. Answers what it did, as the end of a sentence.
 */
const start = async (host: Host, settings: Settings, record: RunRecord, ticket: Ticket): Promise<string> => {
  const { feature } = record
  const key = label(ticket.number ?? 0)
  // The ticket's failed attempt of this same walk, if it had one
  const retryOf = (record.attempts[key] ?? 0) > 0 && record.failure?.ticket === ticket.number ? record.failure : undefined
  const model = ticket.model ?? settings.implementerModel
  const started: RunRecord = {
    ...kept(record),
    phase: 'unattended',
    ...(ticket.number !== undefined ? { ticket: ticket.number } : {}),
    attempts: { ...record.attempts, [key]: (record.attempts[key] ?? 0) + 1 },
    usage: await readUsage(host),
  }

  await writeStatus(host, feature, ticket, 'in-progress')
  await writeRecord(host, started)

  const spawned = await host.spawn({
    subagentType: IMPLEMENTER_TYPE,
    description: `Build ticket ${key}`,
    model,
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

  // The started agent's id, or, where the answer carries none, the newest running implementer of the session
  const agentId =
    spawned.agentId ??
    (spawned.deny === undefined
      ? (await host.agents()).filter(agent => agent.type === IMPLEMENTER_TYPE && agent.isRunning).at(-1)?.id
      : undefined)

  if (agentId === undefined) {
    const why = `the implementer could not start: ${spawned.deny ?? 'it was given no id'}`

    await writeStatus(host, feature, ticket, 'ready')
    await writeRecord(host, { ...started, phase: 'paused', pause: why })

    return `${named(ticket)} was not started: ${why}`
  }

  await writeRecord(host, { ...started, agentId })

  return `building ${named(ticket)} on ${spawned.model ?? model}, on branch ${record.branch}`
}

// What the quota says before a ticket starts, as the run words it; undefined when the ticket may start
const holdOf = (usage: UsageReading, settings: Settings): { pause: string; resumeAt?: number } | undefined => {
  const verdict = beforeTicket(usage, settings)

  if (verdict.kind === 'start') return undefined
  if (verdict.kind === 'stop') {
    return { pause: `the weekly quota window is at ${verdict.percentUsed}%: the run stops here until you /ship resume` }
  }

  return {
    pause: `the 5-hour quota window is at ${verdict.percentUsed}%: the run goes on by itself at ${clockTime(verdict.until)}`,
    resumeAt: verdict.until,
  }
}

/**
 * Takes the run one step on: marks `blocked` every ticket that can no longer be reached, then starts the first
 * ticket of the frontier, or, when none can be taken, stops the run and says how it stands.
 */
const advance = async (host: Host, settings: Settings, record: RunRecord): Promise<string> => {
  const { feature } = record

  for (const unreachable of blockedBy(await ticketsOf(host, feature))) {
    await writeStatus(host, feature, unreachable, 'blocked')
  }

  const tickets = await ticketsOf(host, feature)
  const ticket = frontier(tickets)[0]

  if (ticket) {
    const usage = await readUsage(host)
    const hold = holdOf(usage, settings)

    if (!hold) return start(host, settings, record, ticket)

    // No ticket starts on a quota window that is nearly spent: it would be cut off halfway
    await writeRecord(host, { ...kept(record), phase: 'paused', ...hold, usage })
    host.notify(`${feature} is paused: ${hold.pause}.`)
    if (hold.resumeAt !== undefined) {
      host.after(Math.max(hold.resumeAt - usage.at, 0), () => void wake(host, settings, feature))
    }

    return `paused: ${hold.pause}`
  }

  const count = (status: string) => tickets.filter(t => t.status === status).length
  const left = ['blocked', 'too-large'].map(status => ({ status, n: count(status) })).filter(({ n }) => n > 0)
  const stand = [`${count('done')} of ${tickets.length} done`, ...left.map(({ status, n }) => `${n} ${status}`)].join(', ')
  const pause = left.length > 0 ? 'no ticket can be taken: fix the blocked tickets, then /ship resume' : 'every ticket is done'

  await writeRecord(host, { ...kept(record), phase: 'paused', pause, usage: await readUsage(host) })

  return `no ticket left to take: ${stand}`
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

  if (spec === undefined) refusals.push(`there is no spec at ${specOf(feature)}`)
  else if (verification.length === 0) refusals.push('the spec has no Verification section naming the commands to run')
  if (refusals.length > 0) return [`${feature}: cannot be run`, ...refusals.map(reason => `  ${reason}`)].join('\n')

  const record = await readRecord(host, feature)
  const isInFlight = record?.phase === 'unattended' && record.agentId !== undefined

  if (isInFlight && (await host.agents()).some(agent => agent.id === record.agentId && agent.isRunning)) {
    return `${feature}: ticket ${label(record.ticket ?? 0)} is being built now.`
  }

  // A failed ticket's changes are discarded with everything untracked: the run's own files must be ignored by git
  if ((await git(host, 'check-ignore', '-q', folderOf(feature))).exitCode !== 0) {
    return `${feature}: ${SCRATCH}/ is not ignored by git. Add it to .gitignore, commit that, then /ship resume.`
  }

  const interrupted = tickets.filter(ticket => ticket.status === 'in-progress')

  if (isInFlight || interrupted.length > 0) {
    // The run was cut off mid-ticket: what that ticket left behind is the run's own, and the ticket is built anew
    await discard(host)
    for (const ticket of interrupted) await writeStatus(host, feature, ticket, 'ready')
  } else if ((await git(host, 'status', '--porcelain')).stdout.trim() !== '') {
    // and a run only starts where there is nothing of the person's to lose
    return `${feature}: the working tree has uncommitted changes. Commit or stash them, then /ship resume.`
  }

  const branch = (await git(host, 'rev-parse', '--abbrev-ref', 'HEAD')).stdout.trim()

  // The person's own resume gives every ticket its attempts back
  return `${feature}: ${await advance(host, settings, { feature, branch, phase: 'unattended', attempts: {} })}.`
}

// The run whose implementer this agent is, if it is one
const flightOf = async (host: Host, agentId: string) => {
  for (const { feature, tickets } of await readFolders(host)) {
    const record = await readRecord(host, feature)

    if (record?.phase === 'unattended' && record.agentId === agentId) return { feature, tickets, record }
  }

  return undefined
}

/**
 * The permission decision for a tool call made in a subagent's loop. For a run's implementer it is the run's to
 * make, so that nothing is ever asked of a person who is not there: its listed tools are allowed, and its shell
 * only the commands `isAllowedShell` admits. A refused command fails the attempt. Any other agent: undefined.
 */
export const checkTool = async (
  host: Host,
  agentId: string,
  tool: string,
  input: unknown,
): Promise<{ decision: 'allow' } | { decision: 'deny'; reason: string } | undefined> => {
  const flight = await flightOf(host, agentId)

  if (!flight) return undefined
  if (tool !== 'Bash') {
    return (IMPLEMENTER_TOOLS as readonly string[]).includes(tool)
      ? { decision: 'allow' }
      : { decision: 'deny', reason: `ship-flow: the implementer has no ${tool} tool.` }
  }

  const command = String((input as { command?: unknown } | null)?.command ?? '')
  const verification = verificationOf(await host.read(specOf(flight.feature)))

  if (isAllowedShell(command, verification)) return { decision: 'allow' }

  await writeRecord(host, { ...flight.record, refused: command })

  return {
    decision: 'deny',
    reason: 'ship-flow: this command is outside what the implementer may run, and the ticket has failed. Stop and report.',
  }
}

// Runs the spec's verification commands in order; the first that fails is the failure
const verify = async (host: Host, feature: string) => {
  const isWindows = isWindowsPath(await host.cwd())

  for (const command of verificationOf(await host.read(specOf(feature)))) {
    const ran = await host
      .run(shellArgv(command, isWindows), VERIFY_TIMEOUT_MS)
      .catch((error: unknown) => ({ exitCode: 1, stdout: '', stderr: error instanceof Error ? error.message : String(error) }))

    if (ran.exitCode !== 0) {
      return { reason: `\`${command}\` failed`, output: tail([ran.stdout, ran.stderr].filter(Boolean).join('\n')) }
    }
  }

  return undefined
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
  if (record.refused !== undefined) return { reason: `the implementer tried a command it may not run: ${record.refused}` }

  const failed = await verify(host, feature)

  if (failed) return failed
  if ((await git(host, 'status', '--porcelain')).stdout.trim() === '') return { reason: 'the implementer changed nothing' }

  await git(host, 'add', '-A')

  const committed = await git(host, 'commit', '-m', `${feature}: ${ticket.title}`)

  if (committed.exitCode !== 0) return { reason: 'the commit failed', output: tail(committed.stderr || committed.stdout) }

  return { commit: (await git(host, 'rev-parse', '--short', 'HEAD')).stdout.trim() }
}

/**
 * The end of an implementer's turn. The run verifies the work itself and commits it, and the ticket is `done`; or
 * it discards the work and tries once more with a fresh implementer; or, the retry having failed too, the ticket
 * is `blocked`. Then the run goes on to the next ticket. A line a ticket goes to the transcript; the model is
 * not told.
 */
export const complete = async (
  host: Host,
  settings: Settings,
  turn: { agentId: string; reason: string },
): Promise<void> => {
  const flight = await flightOf(host, turn.agentId)
  const ticket = flight?.tickets.find(t => t.number === flight.record.ticket)

  if (!flight || !ticket) return

  const { feature, record } = flight
  const settled = await settle(host, feature, ticket, record, turn.reason)

  if ('commit' in settled) {
    await writeStatus(host, feature, ticket, 'done')
    host.log(`${feature}: ${named(ticket)} is done (${settled.commit}); ${await advance(host, settings, record)}.`)

    return
  }

  const failure: Failure = { ticket: ticket.number ?? 0, reason: settled.reason, ...(settled.output ? { output: settled.output } : {}) }
  const failed = { ...record, failure }

  await discard(host)

  if ((record.attempts[label(ticket.number ?? 0)] ?? 0) < ATTEMPTS) {
    // Back on the frontier, where it is the first to be taken: the walk tries it once more, quota allowing
    await writeStatus(host, feature, ticket, 'ready')

    const retry = await advance(host, settings, failed)

    host.log(`${feature}: ${named(ticket)} failed (${settled.reason}) and its changes were discarded; once more: ${retry}.`)

    return
  }

  await writeStatus(host, feature, ticket, 'blocked')
  host.log(
    `${feature}: ${named(ticket)} failed again (${settled.reason}) and is marked blocked; ${await advance(host, settings, failed)}.`,
  )
}
