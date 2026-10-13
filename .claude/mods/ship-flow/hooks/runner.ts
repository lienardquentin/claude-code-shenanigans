import { approve, reattend } from './attended'
import { BUDGET_WINDOW, holdOf, isOverBudget, roomFor } from './budget'
import type { Settings } from './budget'
import { finish, finished, follow } from './finisher'
import { detect, requestOf } from './forge'
import { locked, pick, readFolder, readFolders, readRecord, writeRecord, writeStatus } from './folders'
import { workOf } from './guard'
import type { Host } from './host'
import { SCRATCH, finishingOf, folderOf, issuesOf, kept, specOf, ticketBranchOf, treeOf } from './run'
import type { Failure, Flight, RunRecord } from './run'
import { verificationOf } from './spec'
import { blockedBy, frontier, label, problemsOf, takeable } from './tickets'
import type { Ticket } from './tickets'
import { changedIn, git, gitIn, isPlanted, land, launch, plant, readUsage, setUp, tail, treeAt, unplant, verify } from './work'

export { IMPLEMENTER_TOOLS, checkTool, placeShell } from './guard'

/** The agent type that builds a ticket, as the mod registers it and as the engine names it. */
export const IMPLEMENTER = 'implementer'
export const IMPLEMENTER_TYPE = `ship-flow:${IMPLEMENTER}`

export const IMPLEMENTER_PROMPT = [
  'You build one ticket of a spec, alone and unattended. Nobody can answer a question: decide, and say what you decided in your report.',
  '',
  'You are given two paths: the spec and your ticket. Read both first. The ticket says what to build and lists its acceptance criteria; the spec holds the decisions, the vocabulary and the seams to test at. Build the ticket and nothing beyond it. Its `**Touches:**` line is the estimate the person approved, not a constraint: change another file when the work needs it.',
  '',
  'Your working directory is a git worktree of the repo, yours alone: other tickets may be being built beside you, each in its own. Change files under your working directory and nowhere else; the one file outside it you may change is your ticket.',
  '',
  'Work test-first at the seams the spec names: write a failing test for one behaviour, make it pass, then the next. Match the code around you.',
  '',
  'Your shell runs only these: the commands under the spec\'s "Verification" heading, exactly as written, and git status, diff, log, show, blame, ls-files, grep, rev-parse, mv, rm and add. One command per call, from your working directory, with nothing joined to it. Any other command is refused and does not run, so use the file tools to read, search and edit. Do not commit: the run commits your work after it has run the verification commands itself.',
  '',
  'You are done when every acceptance criterion holds and every verification command passes. Tick the criteria you met in the ticket file and leave its Status line alone: the run reads the ticks, and says in the pull request which you left. End with a short report: what you built, what you decided, and anything left undone.',
].join('\n')

/** How many times a ticket is attempted before it is marked `blocked`: once, and one retry. */
export const ATTEMPTS = 2

/** How many times a ticket whose work was sound is built anew because it could not land, before that costs it an attempt. */
export const FREE_LANDINGS = 2

// How many times a ticket's commit is brought up to a run's branch that moved under it, before the attempt is given up
const LANDINGS = 3

/** One step of a run: what it did, as the end of a sentence, and the tickets it took, whose implementers start next. */
type Step = { said: string; taken: readonly Ticket[] }

/** What a ticket's attempt came to: its commit and the files that changed, that it outgrew its budget, or how it failed. */
type Outcome = { commit: string; changed: readonly string[] } | { tooLarge: number } | Failure

const named = (ticket: Ticket): string => `${label(ticket.number ?? 0)} ${ticket.title}`

// A feature's tickets as their files now say
const ticketsOf = async (host: Host, feature: string): Promise<readonly Ticket[]> => (await readFolder(host, feature))?.tickets ?? []

// The tickets whose worktree is being made ready, as `<feature>/<label>`: taken, with no implementer yet
const preparing = new Set<string>()

// A ticket the run had taken does not start: it is `ready` again, and with no other being built the run waits for the person
const ground = (host: Host, feature: string, ticket: Ticket, why: string): Promise<string> =>
  locked(feature, async () => {
    const now = await readRecord(host, feature)
    const isHeld = now?.flights?.some(other => other.ticket === ticket.number) === true

    // A run stopped meanwhile holds the ticket no more: its state is the person's as they left it
    if (now && isHeld) {
      const rest = (now.flights ?? []).filter(other => other.ticket !== ticket.number)

      await writeStatus(host, feature, ticket, 'ready')
      // The tickets still being built go on, and their end takes this one again
      await writeRecord(host, rest.length > 0 ? { ...now, flights: rest } : { ...kept(now), phase: 'paused', pause: why })
    }

    return `${named(ticket)} was not started: ${why}`
  })

/**
 * Starts the implementers of the tickets a step has taken, each in a worktree of its own cut from the run's branch
 * as it is now. The worktrees are made one after the other, which is how git makes them; their setups, which may
 * take minutes, run side by side; the implementers start in ticket order. A retry is told why the attempt before it
 * failed, and takes up the work that attempt left when the run kept it. Answers what it did for each ticket, as the
 * end of a sentence.
 */
const takeOff = async (host: Host, settings: Settings, feature: string, tickets: readonly Ticket[]): Promise<string[]> => {
  try {
    const record = await readRecord(host, feature)
    const root = await host.repo()
    const boarding: { ticket: Ticket; flight?: Flight; retryOf?: Failure; isRepair: boolean; why?: string }[] = []

    for (const ticket of tickets) {
      const flight = record?.flights?.find(other => other.ticket === ticket.number)

      if (!record || !flight) {
        boarding.push({ ticket, isRepair: false, why: 'the run no longer holds it' })
        continue
      }

      // The ticket's failed attempt of this same walk, if it had one
      const retryOf = record.failures?.[label(ticket.number ?? 0)]
      const isRepair = retryOf?.isKept === true && (await isPlanted(host, flight))
      const why = isRepair ? undefined : await plant(host, flight, record.branch)

      boarding.push({ ticket, flight, isRepair, ...(retryOf ? { retryOf } : {}), ...(why !== undefined ? { why } : {}) })
    }

    const ready = await Promise.all(
      boarding.map(async seat => {
        // A worktree taken up from the attempt before was set up for that attempt
        if (seat.why !== undefined || !seat.flight || seat.isRepair) return seat

        const unready = await setUp(host, feature, await treeAt(host, seat.flight))

        return unready ? { ...seat, why: `its worktree could not be set up: ${unready.reason}` } : seat
      }),
    )
    const said: string[] = []

    for (const { ticket, flight, retryOf, isRepair, why } of ready) {
      const key = label(ticket.number ?? 0)

      if (why !== undefined || !flight) {
        if (flight) await unplant(host, flight)
        said.push(await ground(host, feature, ticket, why ?? 'the run no longer holds it'))
        continue
      }

      const launched = await launch(host, {
        subagentType: IMPLEMENTER_TYPE,
        description: `Build ticket ${key}`,
        model: ticket.model ?? settings.implementerModel,
        cwd: await treeAt(host, flight),
        // Pointers, not content: the implementer reads the spec and the ticket in its own window. Absolute,
        // because the run's folder is not in the worktree: git ignores it
        prompt: [
          `Build the ticket ${root}/${issuesOf(feature)}/${ticket.file} of the spec ${root}/${specOf(feature)}.`,
          ...(retryOf
            ? [
                '',
                isRepair
                  ? `A first attempt at this ticket did not pass: ${retryOf.reason}. Its work is still in your worktree: read it with git status, git diff and git log before anything else, then put right what failed rather than starting over.`
                  : `A first attempt at this ticket was discarded: ${retryOf.reason}. Nothing of it is left in your worktree.`,
                ...(retryOf.output ? ['What the failure said:', '', retryOf.output] : []),
              ]
            : []),
        ].join('\n'),
      })

      if ('why' in launched) {
        await unplant(host, flight)
        said.push(await ground(host, feature, ticket, `the implementer could not start: ${launched.why}`))
        continue
      }

      said.push(
        await locked(feature, async () => {
          const now = await readRecord(host, feature)
          const isHeld = now?.flights?.some(other => other.ticket === ticket.number) === true

          if (now) {
            await writeRecord(
              host,
              isHeld
                ? { ...now, flights: (now.flights ?? []).map(other => (other.ticket === ticket.number ? { ...other, agentId: launched.agentId } : other)) }
                : // The person stopped the run while the worktree was made ready: the implementer is stopped as it starts
                  { ...now, halted: [...(now.halted ?? []), launched.agentId] },
            )
          }

          return isHeld
            ? `${isRepair ? 'repairing' : 'building'} ${named(ticket)} on ${launched.model}`
            : `${named(ticket)} was stopped as it started`
        }),
      )
    }

    return said
  } finally {
    for (const ticket of tickets) preparing.delete(`${feature}/${label(ticket.number ?? 0)}`)
  }
}

/**
 * Takes one step of a run, alone on its record, then starts the implementer of each ticket the step took.
 * Answers what was done, as the end of a sentence; undefined when the step did nothing.
 */
const stepOn = async (
  host: Host,
  settings: Settings,
  feature: string,
  step: () => Promise<Step | undefined>,
): Promise<string | undefined> => {
  const stepped = await locked(feature, step)

  if (!stepped) return undefined

  const started = stepped.taken.length > 0 ? await takeOff(host, settings, feature, stepped.taken) : []

  return [stepped.said, ...started].filter(said => said !== '').join('; ')
}

/**
 * Takes the run one step on, from a record that holds the tickets still being built: marks `blocked` every ticket
 * that can no longer be reached, then takes every ticket that can be built now beside those: of the frontier,
 * overlapping none of them, as many as the run builds at once and as the quota has room for. When none can be taken
 * and none is being built, or the weekly quota is nearly spent, the building is over and the run goes on to its
 * end: the review and the pull request.
 */
const advance = async (host: Host, settings: Settings, given: RunRecord): Promise<Step> => {
  const { feature } = given
  const flights = given.flights ?? []
  const unreachable = blockedBy(await ticketsOf(host, feature))

  for (const ticket of unreachable) await writeStatus(host, feature, ticket, 'blocked')

  // Kept apart from the tickets that failed: once the person has put right what these hang off, they are ready again
  const record: RunRecord =
    unreachable.length > 0
      ? { ...given, hangs: [...new Set([...(given.hangs ?? []), ...unreachable.map(ticket => label(ticket.number ?? 0))])] }
      : given
  const tickets = await ticketsOf(host, feature)
  const taken = takeable(
    tickets,
    flights.map(flight => flight.ticket),
    settings.parallelTickets,
  )
  const count = (status: string) => tickets.filter(t => t.status === status).length
  const left = ['blocked', 'too-large'].map(status => ({ status, n: count(status) })).filter(({ n }) => n > 0)
  const stand = [`${count('done')} of ${tickets.length} done`, ...left.map(({ status, n }) => `${n} ${status}`)].join(', ')
  const going: RunRecord = { ...kept(record), phase: 'unattended', ...(flights.length > 0 ? { flights } : {}) }
  const still = `${flights.map(flight => label(flight.ticket)).join(', ')} still being built`
  const usage = await readUsage(host)
  const hold = holdOf(usage, settings)
  const again = (ms: number) => host.after(ms, () => void wake(host, settings, feature))

  if (taken.length === 0) {
    if (flights.length === 0) {
      return { said: `no ticket left to take: ${stand}; ${await finish(host, settings, record, { hold, usage, again })}`, taken: [] }
    }

    await writeRecord(host, going)

    return { said: still, taken: [] }
  }

  if (hold) {
    // The tickets being built are let end: the last of them to end finds the run here again, with none in the air
    if (flights.length > 0) {
      await writeRecord(host, { ...going, usage })

      return { said: `${hold.pause}, so no ticket is started; ${still}`, taken: [] }
    }

    // A weekly window is days from resetting: waiting does not help, so the run ends on what it has
    if (hold.isOver) {
      return { said: `the building stops: ${stand}; ${await finish(host, settings, record, { hold, usage, again })}`, taken: [] }
    }

    // No ticket starts on a quota window that is nearly spent: it would be cut off halfway
    await writeRecord(host, { ...kept(record), phase: 'paused', pause: hold.pause, ...(hold.resumeAt !== undefined ? { resumeAt: hold.resumeAt } : {}), usage })
    host.notify(`${feature} is paused: ${hold.pause}.`)
    if (hold.resumeAt !== undefined) again(Math.max(hold.resumeAt - usage.at, 0))

    return { said: `paused: ${hold.pause}`, taken: [] }
  }

  // Under its thresholds a window may still be too near them for every ticket the run could take: as many start as
  // what the tickets ended so far have cost says it has room for, counting those being built
  const room = Math.max(roomFor(record.startUsage, usage, record.ended ?? 0, settings) - flights.length, flights.length > 0 ? 0 : 1)
  const boarding = taken.slice(0, room)

  if (boarding.length === 0) {
    await writeRecord(host, { ...going, usage })

    return { said: `the quota has room for no other ticket beside those being built; ${still}`, taken: [] }
  }

  const attempts = { ...record.attempts }
  const boarded: Flight[] = []

  for (const ticket of boarding) {
    const key = label(ticket.number ?? 0)

    attempts[key] = (attempts[key] ?? 0) + 1
    boarded.push({ ticket: ticket.number ?? 0, tree: treeOf(feature, key), branch: ticketBranchOf(record.branch, key), startedAt: usage.at })
    preparing.add(`${feature}/${key}`)
    await writeStatus(host, feature, ticket, 'in-progress')
  }

  await writeRecord(host, { ...going, flights: [...flights, ...boarded], attempts, usage })

  return { said: '', taken: boarding }
}

/**
 * The timer of a run paused for quota: the run goes on if it is still paused and waiting, which it is not when
 * the person resumed it in the meantime. A window still over its threshold pauses it again.
 */
async function wake(host: Host, settings: Settings, feature: string): Promise<void> {
  try {
    const said = await stepOn(host, settings, feature, async () => {
      const record = await readRecord(host, feature)

      return record?.phase !== 'paused' || record.resumeAt === undefined ? undefined : advance(host, settings, { ...kept(record), phase: 'unattended' })
    })

    if (said !== undefined) host.log(`${feature}: the quota window has reset; ${said}.`)
  } catch (error) {
    host.log(`${feature}: could not go on after the pause: ${error instanceof Error ? error.message : String(error)}. /ship resume.`)
  }
}

/**
 * A session has started, or the module was loaded again: the timer of every run paused for quota is set again from
 * its record, since the one that was set died with the module that set it. A run whose time has passed goes on at
 * once.
 */
export const rearm = async (host: Host, settings: Settings): Promise<void> => {
  const now = await host.now()

  for (const { feature, record } of await readFolders(host)) {
    if (record?.phase !== 'paused' || record.resumeAt === undefined) continue

    host.after(Math.max(record.resumeAt - now, 0), () => void wake(host, settings, feature))
  }
}

/**
 * `/ship resume [feature]`: starts, or takes up again, the walk of a feature's ticket graph. Answers what it did,
 * or why it did nothing. From there each ticket's end, `complete`, takes the next ones. On a run whose pull request
 * is open and whose tickets leave nothing to take, it follows up what the pull request has met since.
 */
export const resume = async (host: Host, settings: Settings, wanted: string): Promise<string> => {
  const folder = pick(await readFolders(host), wanted, '/ship resume <feature>')

  if (typeof folder === 'string') return folder

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

  const said = await stepOn(host, settings, feature, async (): Promise<Step> => {
    const refused = (why: string): Step => ({ said: why, taken: [] })
    const record = await readRecord(host, feature)
    const running = new Set((await host.agents()).filter(agent => agent.isRunning).map(agent => agent.id))
    const isFinishing = record?.phase === 'finishing' && record.agentId !== undefined
    const building = (record?.phase === 'unattended' ? (record.flights ?? []) : []).filter(
      flight => (flight.agentId !== undefined && running.has(flight.agentId)) || preparing.has(`${feature}/${label(flight.ticket)}`),
    )

    if (isFinishing && running.has(record?.agentId ?? '')) {
      return refused(
        record?.stage === 'follow' ? `its ${requestOf(record)} is being followed up now` : `the branch is being ${record?.stage === 'fix' ? 'fixed' : 'reviewed'} now`,
      )
    }
    if (building.length > 0) {
      const labels = building.map(flight => label(flight.ticket)).join(', ')

      return refused(building.length === 1 ? `ticket ${labels} is being built now` : `tickets ${labels} are being built now`)
    }

    // The run's own files are in no worktree and reach no commit: they must be ignored by git
    if ((await git(host, 'check-ignore', '-q', folderOf(feature))).exitCode !== 0) {
      return refused(`${SCRATCH}/ is not ignored by git. Add it to .gitignore, commit that, then /ship resume`)
    }

    // The checkpoint: this command, typed by the person on a run still with them, is the approval
    if (record?.phase === 'attended') {
      const approved = await approve(host, record)

      if ('refusal' in approved) return refused(`cannot start: ${approved.refusal}`)

      const begun = await advance(host, settings, { ...approved, startUsage: await readUsage(host) })

      return { ...begun, said: [`approved, on branch ${approved.branch}`, begun.said].filter(part => part !== '').join('; ') }
    }

    // A pull request that is open, with no ticket to take: what its checks and its reviewers said since is the work
    if (record?.pr && !isFinishing && frontier(tickets).length === 0) {
      const followed = await follow(host, settings, IMPLEMENTER_TYPE, record)

      if (followed !== undefined) return refused(followed)
    }

    // What was cut off is built anew: a ticket's worktree goes with what its implementer left there, and so does
    // the one the branch was being reviewed or fixed in. The repo's own working tree is the person's and is left alone
    if (record && isFinishing) await unplant(host, finishingOf(record))
    for (const flight of record?.flights ?? []) await unplant(host, flight)
    for (const ticket of tickets.filter(t => t.status === 'in-progress')) await writeStatus(host, feature, ticket, 'ready')

    // A ticket that was blocked only for what it hung off is given back to the walk, which blocks it again if that still stands
    const hangs = new Set(record?.hangs ?? [])

    for (const ticket of tickets.filter(t => t.status === 'blocked' && hangs.has(label(t.number ?? 0)))) {
      await writeStatus(host, feature, ticket, 'ready')
    }

    // A run with no record yet is built on the branch the person is on; one that has a record keeps its own
    const branch = record?.branch || (await git(host, 'rev-parse', '--abbrev-ref', 'HEAD')).stdout.trim()
    // What the run has built and opened so far stays; the person's own resume gives every ticket its attempts back
    const carried: Partial<RunRecord> = record ? kept(record) : {}

    delete carried.failures
    delete carried.landings
    delete carried.hangs

    const startUsage = record?.startUsage ?? (await readUsage(host))
    // A run with no record was not begun by /ship: its forge is made out here, as a run's is when it begins
    const forge = record ? undefined : await detect(host, settings.forge)

    return advance(host, settings, {
      ...carried,
      ...(forge !== undefined && forge.id !== 'github' ? { forge: forge.id } : {}),
      feature,
      branch,
      phase: 'unattended',
      attempts: {},
      startUsage,
    })
  })

  return `${feature}: ${said ?? ''}.`
}

/**
 * `/ship stop [feature]`: stops a run that is building, reviewing or waiting on the quota. Its tickets being built
 * go back to `ready` and their worktrees go; its agents still at work are refused whatever they call next, which is
 * the one way a run has to end a subagent's turn. `/ship resume` takes the run up again.
 */
export const stop = async (host: Host, wanted: string): Promise<string> => {
  const folder = pick(await readFolders(host), wanted, '/ship stop <feature>')

  if (typeof folder === 'string') return folder

  const { feature } = folder

  return locked(feature, async () => {
    const record = await readRecord(host, feature)
    const isWaiting = record?.phase === 'paused' && record.resumeAt !== undefined

    if (!record || (record.phase !== 'unattended' && record.phase !== 'finishing' && !isWaiting)) {
      return `${feature}: is not building: there is nothing to stop.`
    }

    const flights = record.phase === 'unattended' ? (record.flights ?? []) : []
    const running = new Set((await host.agents()).filter(agent => agent.isRunning).map(agent => agent.id))
    const halted = [...flights.flatMap(flight => flight.agentId ?? []), ...(record.phase === 'finishing' && record.agentId !== undefined ? [record.agentId] : [])].filter(
      agentId => running.has(agentId),
    )

    for (const flight of flights) await unplant(host, flight)
    if (record.phase === 'finishing') await unplant(host, finishingOf(record))
    for (const ticket of (await ticketsOf(host, feature)).filter(t => t.status === 'in-progress')) await writeStatus(host, feature, ticket, 'ready')

    await writeRecord(host, { ...kept(record), phase: 'paused', pause: 'stopped by you', ...(halted.length > 0 ? { halted } : {}) })

    const one = halted.length === 1

    return [
      `${feature}: stopped.`,
      ...(halted.length > 0
        ? [
            `${one ? 'Its agent at work is' : `Its ${halted.length} agents at work are`} refused whatever ${one ? 'it calls' : 'they call'} next, and what ${one ? 'it' : 'they'} had not finished is discarded.`,
          ]
        : []),
      `/ship resume ${feature} takes it up again.`,
    ].join(' ')
  })
}

/**
 * One response of a subagent, by how full its context was when it was made. A ticket's implementer that has passed
 * the ticket's context budget is marked so: its work from here on would be worse, and the ticket is too large for
 * one window. `checkTool` then refuses whatever it calls next, which is what stops it (the engine's own call to
 * abort a turn does not stop a subagent's), and `complete` discards the attempt.
 */
export const measure = async (
  host: Host,
  settings: Settings,
  step: { agentId: string; tokens: number },
): Promise<void> => {
  const found = await workOf(host, step.agentId)

  // The budget is a ticket's: the review and the passes on the branch are not held to it
  if (!found?.flight) return

  await locked(found.feature, async () => {
    const record = await readRecord(host, found.feature)
    const flight = record?.flights?.find(other => other.agentId === step.agentId)

    if (!record || !flight) return

    const key = label(flight.ticket)
    const isStopping = flight.tooLarge === undefined && isOverBudget(step.tokens, settings)

    if (!isStopping && step.tokens <= (record.peak?.[key] ?? 0)) return

    await writeRecord(host, {
      ...record,
      peak: { ...record.peak, [key]: Math.max(step.tokens, record.peak?.[key] ?? 0) },
      ...(isStopping ? { flights: (record.flights ?? []).map(other => (other === flight ? { ...other, tooLarge: step.tokens } : other)) } : {}),
    })
  })
}

// What is wrong with a finished attempt, or, when nothing is, undefined: the ticket's branch then holds it as one commit
const settle = async (host: Host, feature: string, ticket: Ticket, tree: string, reason: string): Promise<Failure | undefined> => {
  if (reason !== 'answer') return { reason: `the implementer's turn ended with ${reason}` }

  const failed = await verify(host, feature, tree)

  // What does not pass is kept where it is: putting it right costs the next attempt less than building it again
  if (failed) return { ...failed, isKept: true }
  if ((await gitIn(host, tree, 'status', '--porcelain')).stdout.trim() === '') return { reason: 'the implementer changed nothing' }

  await gitIn(host, tree, 'add', '-A')

  const committed = await gitIn(host, tree, 'commit', '-m', `${feature}: ${ticket.title}`)

  return committed.exitCode === 0 ? undefined : { reason: 'the commit failed', output: tail(committed.stderr || committed.stdout) }
}

// Brings a ticket's commit up to a run's branch that moved under it, and verifies the two together; what went wrong, if anything
const catchUp = async (host: Host, feature: string, branch: string, tree: string): Promise<Failure | undefined> => {
  const rebased = await gitIn(host, tree, 'rebase', branch)

  if (rebased.exitCode !== 0) {
    await gitIn(host, tree, 'rebase', '--abort')

    // The work passed where it was built: what failed is the estimate that let the two be built side by side
    return { reason: 'its changes conflict with those of a ticket built beside it', output: tail(rebased.stdout || rebased.stderr), isLanding: true }
  }

  const failed = await verify(host, feature, tree)

  return failed ? { ...failed, reason: `${failed.reason} once on top of the tickets built beside it`, isKept: true } : undefined
}

/**
 * What a ticket's attempt came to, written down, and the run taken on from there: `done` with its commit; or
 * `too-large`; or, failed, `ready` for its one retry, then `blocked`. A ticket whose work was sound and only could
 * not land is built anew without being charged the attempt, a few times. The other tickets being built go on.
 */
const conclude = async (host: Host, settings: Settings, feature: string, ticket: Ticket, outcome: Outcome): Promise<Step | undefined> => {
  const record = await readRecord(host, feature)

  if (!record) return undefined

  const key = label(ticket.number ?? 0)
  const flight = record.flights?.find(other => other.ticket === ticket.number)
  const landed: RunRecord = {
    ...record,
    flights: (record.flights ?? []).filter(other => other.ticket !== ticket.number),
    ended: (record.ended ?? 0) + 1,
  }
  const then = async (said: string, next: RunRecord): Promise<Step> => {
    const step = await advance(host, settings, next)

    return { ...step, said: [said, step.said].filter(part => part !== '').join('; ') }
  }

  if ('commit' in outcome) {
    const unticked = ticket.criteria.filter(criterion => !criterion.isDone).length

    await writeStatus(host, feature, ticket, 'done')

    return then(
      `${named(ticket)} is done (${outcome.commit})${unticked > 0 ? `, with ${unticked} of ${ticket.criteria.length} criteria left unticked` : ''}`,
      {
        ...landed,
        commits: { ...record.commits, [key]: outcome.commit },
        ...(outcome.changed.length > 0 ? { actual: { ...record.actual, [key]: outcome.changed } } : {}),
        ...(flight?.startedAt !== undefined ? { took: { ...record.took, [key]: Math.max((await host.now()) - flight.startedAt, 0) } } : {}),
      },
    )
  }

  // Stopped for its size: another attempt would only fill another window, so the ticket is the person's to split
  if ('tooLarge' in outcome) {
    await writeStatus(host, feature, ticket, 'too-large')

    return then(
      `${named(ticket)} was stopped at ${Math.round((outcome.tooLarge / BUDGET_WINDOW) * 100)}% of a context window and is marked too-large: split it`,
      landed,
    )
  }

  const failed: RunRecord = { ...landed, failures: { ...record.failures, [key]: outcome } }
  const relanded = record.landings?.[key] ?? 0

  if (outcome.isLanding === true && relanded < FREE_LANDINGS) {
    await writeStatus(host, feature, ticket, 'ready')

    return then(`${named(ticket)} could not land (${outcome.reason}): it is built anew on the branch as it is now, at no cost to its attempts`, {
      ...failed,
      attempts: { ...record.attempts, [key]: Math.max((record.attempts[key] ?? 1) - 1, 0) },
      landings: { ...record.landings, [key]: relanded + 1 },
    })
  }

  if ((record.attempts[key] ?? 0) < ATTEMPTS) {
    // Back on the frontier: the walk tries it once more, quota allowing
    await writeStatus(host, feature, ticket, 'ready')

    return then(
      outcome.isKept === true
        ? `${named(ticket)} failed (${outcome.reason}): its work is kept, for one more attempt to put right`
        : `${named(ticket)} failed (${outcome.reason}) and its changes were discarded: it is tried once more`,
      failed,
    )
  }

  await writeStatus(host, feature, ticket, 'blocked')

  return then(`${named(ticket)} failed again (${outcome.reason}) and is marked blocked`, {
    ...failed,
    reasons: { ...record.reasons, [key]: outcome.reason },
  })
}

/**
 * The end of the turn of an agent of a run. An implementer's: the run verifies the work itself in the ticket's
 * worktree, commits it there and puts the commit on the run's branch, and the ticket is `done`; or it tries once
 * more with a fresh implementer, which repairs work that did not pass and builds anew what was lost; or, the retry
 * having failed too, the ticket is `blocked`; then the run takes the tickets that can now be built. A commit that
 * finds the run's branch moved, by a ticket built beside it, is brought up to the branch and verified again before
 * it lands. The reviewer's, or a pass's on the branch: the run goes on towards its pull request. A line each goes
 * to the transcript; the model is not told.
 */
export const complete = async (
  host: Host,
  settings: Settings,
  turn: { agentId: string; reason: string; answer: string },
): Promise<void> => {
  const found = await workOf(host, turn.agentId)

  if (!found) return

  const { feature, record, flight } = found

  // An agent of a run the person stopped has ended: there is no more of it to refuse
  if (found.isHalted) {
    await locked(feature, async () => {
      const now = await readRecord(host, feature)

      if (!now) return

      const { halted = [], ...without } = now
      const rest = halted.filter(agentId => agentId !== turn.agentId)

      await writeRecord(host, rest.length > 0 ? { ...without, halted: rest } : without)
    })

    return
  }

  if (!flight) {
    host.log(`${feature}: ${await locked(feature, () => finished(host, settings, IMPLEMENTER_TYPE, found, turn))}.`)

    return
  }

  const ticket = found.tickets.find(t => t.number === flight.ticket)

  if (!ticket) return

  const tree = await treeAt(host, flight)
  const said = (text: string | undefined) => {
    if (text !== undefined) host.log(`${feature}: ${text}.`)
  }
  // An implementer that passed the budget on its last response was refused nothing, and its work is judged as any
  let failure: { tooLarge: number } | Failure | undefined =
    flight.tooLarge !== undefined && flight.isStopped === true
      ? { tooLarge: flight.tooLarge }
      : await settle(host, feature, ticket, tree, turn.reason)
  // What the commit changed is what the ticket's estimate is held against, whatever it is rebased onto later
  const changed = failure === undefined ? await changedIn(host, tree) : []

  for (let landings = 1; failure === undefined; landings += 1) {
    const at: { landed: Failure | 'moved' | { commit: string } } = { landed: 'moved' }
    // Landing and the ticket's `done` are one step: no other ticket's end sees the branch moved and the ticket unbuilt
    const text = await stepOn(host, settings, feature, async () => {
      at.landed = (await land(host, record.branch, flight.branch)) ?? { commit: (await gitIn(host, tree, 'rev-parse', '--short', 'HEAD')).stdout.trim() }

      return at.landed !== 'moved' && 'commit' in at.landed ? conclude(host, settings, feature, ticket, { ...at.landed, changed }) : undefined
    })

    if (at.landed !== 'moved' && 'commit' in at.landed) {
      await unplant(host, flight)

      return said(text)
    }

    if (at.landed !== 'moved') failure = at.landed
    else {
      failure =
        landings >= LANDINGS ? { reason: `${record.branch} kept moving under it`, isLanding: true } : await catchUp(host, feature, record.branch, tree)
    }
  }

  // Work that did not pass stays in its worktree for the ticket's one retry to put right; anything else goes, before
  // the ticket can be taken again, and outside a step: removing a worktree may take a while
  const isLast = (record.attempts[label(flight.ticket)] ?? 0) >= ATTEMPTS
  const outcome: { tooLarge: number } | Failure =
    'tooLarge' in failure || failure.isKept !== true || !isLast ? failure : { reason: failure.reason, ...(failure.output !== undefined ? { output: failure.output } : {}) }

  if ('tooLarge' in outcome || outcome.isKept !== true) await unplant(host, flight)
  said(await stepOn(host, settings, feature, () => conclude(host, settings, feature, ticket, outcome)))
}
