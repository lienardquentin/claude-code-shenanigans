import { readFolders, readRecord, writeRecord, writeStatus } from './folders'
import type { Host } from './host'
import { SCRATCH, folderOf, issuesOf, specOf } from './run'
import type { RunRecord, UsageReading } from './run'
import { isAllowedShell, isWindowsPath, shellArgv } from './shell'
import { verificationOf } from './spec'
import { frontier, label, problemsOf } from './tickets'
import type { Ticket } from './tickets'

/** The agent type that builds a ticket, as the mod registers it and as the engine names it. */
export const IMPLEMENTER = 'implementer'
export const IMPLEMENTER_TYPE = `ship-flow:${IMPLEMENTER}`

// The model a ticket is built on until the mod has settings
export const IMPLEMENTER_MODEL = 'sonnet'

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

// A verification command may run as long as the host lets a process run
const VERIFY_TIMEOUT_MS = 10 * 60 * 1000

// How much of a failing command's output is kept for the next attempt and for the person
const OUTPUT_KEPT = 4000

const tail = (text: string): string => (text.length > OUTPUT_KEPT ? `…${text.slice(-OUTPUT_KEPT)}` : text)

const named = (ticket: Ticket): string => `${label(ticket.number ?? 0)} ${ticket.title}`

const git = (host: Host, ...args: string[]) => host.run(['git', ...args])

// The session's own figures now, stamped with the time they were read
const readUsage = async (host: Host): Promise<UsageReading> => ({ at: await host.now(), ...(await host.usage()) })

/**
 * `/ship resume [feature]`: takes the first ticket of the frontier and starts its implementer. Answers what it
 * did, or why it did nothing. The ticket's end is `complete`, raised by the implementer's own last turn.
 */
export const resume = async (host: Host, wanted: string): Promise<string> => {
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

  if (record?.phase === 'unattended' && record.agentId !== undefined) {
    if ((await host.agents()).some(agent => agent.id === record.agentId && agent.isRunning)) {
      return `${feature}: ticket ${label(record.ticket ?? 0)} is being built now.`
    }
  }

  const ticket = frontier(tickets)[0]

  if (!ticket) return `${feature}: no ticket can be taken now. /ship status says why.`

  // A failed ticket's changes are discarded with everything untracked: the run's own files must be ignored by git
  if ((await git(host, 'check-ignore', '-q', folderOf(feature))).exitCode !== 0) {
    return `${feature}: ${SCRATCH}/ is not ignored by git. Add it to .gitignore, commit that, then /ship resume.`
  }

  // and the run only starts where there is nothing of the person's to lose
  if ((await git(host, 'status', '--porcelain')).stdout.trim() !== '') {
    return `${feature}: the working tree has uncommitted changes. Commit or stash them, then /ship resume.`
  }

  const branch = (await git(host, 'rev-parse', '--abbrev-ref', 'HEAD')).stdout.trim()
  const key = label(ticket.number ?? 0)
  const started: RunRecord = {
    feature,
    branch,
    phase: 'unattended',
    ...(ticket.number !== undefined ? { ticket: ticket.number } : {}),
    attempts: { ...record?.attempts, [key]: (record?.attempts[key] ?? 0) + 1 },
    usage: await readUsage(host),
  }

  await writeStatus(host, feature, ticket, 'in-progress')
  await writeRecord(host, started)

  const spawned = await host.spawn({
    subagentType: IMPLEMENTER_TYPE,
    description: `Build ticket ${key}`,
    model: ticket.model ?? IMPLEMENTER_MODEL,
    // Pointers, not content: the implementer reads the spec and the ticket in its own window
    prompt: `Build the ticket ${issuesOf(feature)}/${ticket.file} of the spec ${specOf(feature)}.`,
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

    return `${feature}: ${named(ticket)} was not started: ${why}`
  }

  await writeRecord(host, { ...started, agentId })

  return `${feature}: building ${named(ticket)} on ${spawned.model ?? IMPLEMENTER_MODEL}, on branch ${branch}.`
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

/**
 * The end of an implementer's turn: the run verifies the work itself, then commits it and marks the ticket `done`,
 * or discards it and marks the ticket `blocked`. One line goes to the transcript; the model is not told.
 */
export const complete = async (host: Host, turn: { agentId: string; reason: string }): Promise<void> => {
  const flight = await flightOf(host, turn.agentId)
  const ticket = flight?.tickets.find(t => t.number === flight.record.ticket)

  if (!flight || !ticket) return

  const { feature, record } = flight
  // What of the record outlives the attempt
  const kept = { feature, branch: record.branch, attempts: record.attempts }
  const fail = async (reason: string, output?: string) => {
    await git(host, 'reset', '--hard', 'HEAD')
    await git(host, 'clean', '-fd')
    await writeStatus(host, feature, ticket, 'blocked')
    await writeRecord(host, {
      ...kept,
      phase: 'paused',
      pause: `${named(ticket)} failed`,
      failure: { ticket: ticket.number ?? 0, reason, ...(output ? { output } : {}) },
      usage: await readUsage(host),
    })
    host.log(`ship-flow: ${named(ticket)} failed: ${reason}. Its changes were discarded and it is marked blocked.`)
  }

  if (turn.reason !== 'answer') return fail(`the implementer's turn ended with ${turn.reason}`)
  if (record.refused !== undefined) return fail(`the implementer tried a command it may not run: ${record.refused}`)

  const failed = await verify(host, feature)

  if (failed) return fail(failed.reason, failed.output)
  if ((await git(host, 'status', '--porcelain')).stdout.trim() === '') return fail('the implementer changed nothing')

  await git(host, 'add', '-A')

  const committed = await git(host, 'commit', '-m', `${feature}: ${ticket.title}`)

  if (committed.exitCode !== 0) return fail('the commit failed', tail(committed.stderr || committed.stdout))

  const commit = (await git(host, 'rev-parse', '--short', 'HEAD')).stdout.trim()

  await writeStatus(host, feature, ticket, 'done')
  await writeRecord(host, {
    ...kept,
    phase: 'paused',
    pause: 'one ticket is built per /ship resume until the run walks the graph',
    usage: await readUsage(host),
  })
  host.log(`ship-flow: ${named(ticket)} is done (${commit}).`)
}
