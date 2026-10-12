import { REVIEWER_TOOLS } from './finisher'
import { locked, readFolder, readFolders, readRecord, writeRecord, writes } from './folders'
import type { Host } from './host'
import { finishingOf, issuesOf, specOf } from './run'
import type { Flight, RunRecord } from './run'
import { READING_GIT, SHELL_REFUSAL, isAllowedShell } from './shell'
import { verificationOf } from './spec'
import type { Folder } from './status'
import type { Ticket } from './tickets'

/** What the implementer may call. Its shell is narrowed further, command by command, by `checkTool`. */
export const IMPLEMENTER_TOOLS = ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash'] as const

/** The engine's own tool by which a subagent hands its report back: every agent of a run may call it. */
const HANDBACK = 'SubagentHandback'

/**
 * An agent of a run and what it is at work on: a ticket's implementer, with its flight; the run's reviewer, fix
 * pass or follow-up pass, with none; or an agent of a run the person stopped, which is let do nothing more.
 */
export type Work = { feature: string; tickets: readonly Ticket[]; record: RunRecord; flight?: Flight; isHalted?: true }

const workIn = ({ feature, tickets, record }: Folder, agentId: string): Work | undefined => {
  if (!record) return undefined
  if (record.halted?.includes(agentId)) return { feature, tickets, record, isHalted: true }
  if (record.phase === 'finishing' && record.agentId === agentId) return { feature, tickets, record }

  const flight = record.phase === 'unattended' ? record.flights?.find(other => other.agentId === agentId) : undefined

  return flight ? { feature, tickets, record, flight } : undefined
}

// The run each agent was last found at work for, or that it was found at work for none, as of so many record
// writes. The hooks ask on every tool call and every response of every subagent of the session, the run's or not:
// an agent that is no run's is not looked for again until a record is written, and one that is a run's is looked
// for in that run's folder first. Nothing here is needed to go on: a reload empties it and every folder is read.
const owners = new Map<string, { feature?: string; at: number }>()

/** The run this agent is at work for, if it is one, and what it is doing there. */
export const workOf = async (host: Host, agentId: string): Promise<Work | undefined> => {
  const known = owners.get(agentId)
  const at = writes()

  if (known && known.feature === undefined && known.at === at) return undefined

  if (known?.feature !== undefined) {
    const folder = await readFolder(host, known.feature)
    const work = folder ? workIn(folder, agentId) : undefined

    if (work) return work
  }

  for (const folder of await readFolders(host)) {
    const work = workIn(folder, agentId)

    if (work) {
      owners.set(agentId, { feature: folder.feature, at })

      return work
    }
  }

  owners.set(agentId, { at })

  return undefined
}

// A path as two spellings of one place compare equal: forward slashes, a drive as `c:`, one case
const spelled = (path: string): string =>
  path
    .replaceAll('\\', '/')
    .replace(/^\/([A-Za-z])\//, '$1:/')
    .toLowerCase()

/**
 * The permission decision for a tool call made in a subagent's loop. For an agent of a run it is the run's to
 * make, so that nothing is ever asked of a person who is not there: its listed tools are allowed, and its shell
 * only the commands `isAllowedShell` admits. An agent that writes does so in its own worktree, and a ticket's
 * implementer in its ticket file too, and nowhere else: other tickets are being built beside it, and the repo's own
 * working tree is the person's. A refused call does not run and costs the agent nothing else: it is told why and
 * works on, and the run judges the work by its verification as any. Any other agent: undefined.
 */
export const checkTool = async (
  host: Host,
  agentId: string,
  tool: string,
  input: unknown,
): Promise<{ decision: 'allow' } | { decision: 'deny'; reason: string } | undefined> => {
  const found = await workOf(host, agentId)

  if (!found) return undefined

  // The report an agent ends its turn with is no work: refused, the turn ends as aborted and its work is discarded.
  // It is not the run's to allow either: in auto mode the engine takes an allow of it from its classifier alone and
  // fails the call on a hook's, so the session's own decision stands
  if (tool === HANDBACK) return undefined

  const { feature, record, flight } = found

  // The engine has no call that ends a subagent's turn: refusing whatever it calls next is how a run stops one
  if (found.isHalted) {
    return { decision: 'deny', reason: 'ship-flow: the person stopped this run. Call no more tools: end your turn now.' }
  }

  const isReviewer = !flight && record.stage === 'review'
  const tools: readonly string[] = isReviewer ? REVIEWER_TOOLS : IMPLEMENTER_TOOLS
  const role = isReviewer ? 'reviewer' : 'implementer'

  // Past its context budget the implementer gets nothing more done: this is how the run stops it
  if (flight?.tooLarge !== undefined) {
    if (flight.isStopped !== true) {
      await locked(feature, async () => {
        const now = await readRecord(host, feature)

        if (now) {
          await writeRecord(host, {
            ...now,
            flights: (now.flights ?? []).map(other => (other.agentId === agentId ? { ...other, isStopped: true } : other)),
          })
        }
      })
    }

    return {
      decision: 'deny',
      reason: 'ship-flow: this ticket has outgrown its context budget and is stopped. Call no more tools: end your turn now.',
    }
  }

  if (tool !== 'Bash') {
    if (!tools.includes(tool)) return { decision: 'deny', reason: `ship-flow: the ${role} has no ${tool} tool.` }
    if (tool !== 'Edit' && tool !== 'Write') return { decision: 'allow' }

    const path = spelled(String((input as { file_path?: unknown } | null)?.file_path ?? ''))
    const root = await host.repo()
    const tree = `${root}/${(flight ?? finishingOf(record)).tree}`
    const ticket = flight ? found.tickets.find(t => t.number === flight.ticket) : undefined
    const isRelative = !/^([a-z]:)?\//.test(path)
    const isOwn =
      path.startsWith(`${spelled(tree)}/`) || (ticket !== undefined && path === spelled(`${root}/${issuesOf(feature)}/${ticket.file}`))

    return !path.split('/').includes('..') && (isRelative || isOwn)
      ? { decision: 'allow' }
      : {
          decision: 'deny',
          reason: `ship-flow: this file was not written: it is outside your worktree. Change files under ${tree}${flight ? ', and your ticket file,' : ''} and nothing else.`,
        }
  }

  const command = String((input as { command?: unknown } | null)?.command ?? '')

  if (isReviewer) {
    return isAllowedShell(command, [], READING_GIT)
      ? { decision: 'allow' }
      : { decision: 'deny', reason: 'ship-flow: the reviewer runs only the git commands that read the repo, with no option that writes a file or opens a pager.' }
  }
  return isAllowedShell(command, verificationOf(await host.read(specOf(feature))))
    ? { decision: 'allow' }
    : { decision: 'deny', reason: SHELL_REFUSAL }
}
