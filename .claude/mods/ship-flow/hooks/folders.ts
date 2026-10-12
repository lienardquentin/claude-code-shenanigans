import type { Host } from './host'
import { SCRATCH, issuesOf, parseRecord, recordOf, recordText } from './run'
import type { RunRecord } from './run'
import type { Folder } from './status'
import { parseTicket, withStatus } from './tickets'
import type { State, Ticket } from './tickets'

/** One feature's folder read whole, or undefined when it is no run: it holds neither tickets nor a run record. */
export const readFolder = async (host: Host, feature: string): Promise<Folder | undefined> => {
  const issues = issuesOf(feature)
  const hasTickets = await host.exists(issues)
  const record = await readRecord(host, feature)

  // A run exists from its record on, before it has a ticket: the attended phase writes them last
  if (!hasTickets && !record) return undefined

  const files = hasTickets
    ? (await host.list(issues))
        .filter(entry => !entry.isDir && entry.name.endsWith('.md'))
        .map(entry => entry.name)
        .sort()
    : []
  const tickets = await Promise.all(
    files.map(async file => parseTicket(file, await host.read(`${issues}/${file}`))),
  )

  return { feature, tickets, ...(record ? { record } : {}) }
}

// Every feature folder of the repo that is a run, read whole: one that holds tickets, or a run record.
export const readFolders = async (host: Host): Promise<Folder[]> => {
  if (!(await host.exists(SCRATCH))) return []

  const folders: Folder[] = []
  const features = (await host.list(SCRATCH)).filter(entry => entry.isDir).map(entry => entry.name)

  for (const feature of features.sort()) {
    const folder = await readFolder(host, feature)

    if (folder) folders.push(folder)
  }

  return folders
}

/**
 * The run a command is for: the one named, or the only one when none is named. Otherwise what to tell the person,
 * with `usage` as the command to type.
 */
export const pick = (folders: readonly Folder[], wanted: string, usage: string): Folder | string => {
  if (folders.length === 0) return 'No run in this repo: there is no .scratch/<feature>/issues folder.'

  const folder = wanted === '' && folders.length === 1 ? folders[0] : folders.find(f => f.feature === wanted)

  if (folder) return folder

  const names = folders.map(f => f.feature).join(', ')

  return wanted === '' ? `Several runs here: ${names}. Name one: ${usage}.` : `No run named ${wanted}. Here: ${names}.`
}

/** A feature's run record, or undefined when it has none yet. */
export async function readRecord(host: Host, feature: string): Promise<RunRecord | undefined> {
  return (await host.exists(recordOf(feature))) ? parseRecord(await host.read(recordOf(feature))) : undefined
}

// The write of each record still under way. Two hooks may write one record at the same moment (a response is
// measured while the tool call it carries is checked), and two writes at once leave a file that is neither.
const writing = new Map<string, Promise<void>>()

// How many records this module has written: what was found of the records before a write may no longer hold
const written = { count: 0 }

/** How many times a record was written so far: a reading of the records is good for as long as this stands. */
export const writes = (): number => written.count

/** Writes a run's record, after any write of it still under way: a record's file is never written twice at once. */
export const writeRecord = async (host: Host, record: RunRecord): Promise<void> => {
  const path = recordOf(record.feature)
  const write = (writing.get(path) ?? Promise.resolve()).catch(() => undefined).then(() => host.write(path, recordText(record)))

  writing.set(path, write)
  written.count += 1
  await write
  written.count += 1
  host.changed()
}

/** Rewrites one ticket file's `Status:` line. */
export const writeStatus = async (host: Host, feature: string, ticket: Ticket, status: State) => {
  const path = `${issuesOf(feature)}/${ticket.file}`

  await host.write(path, withStatus(await host.read(path), status))
  host.changed()
}

// The step of each run still under way. Tickets built side by side end when they end, and two steps at once
// would each write the record over the other's.
const steps = new Map<string, Promise<unknown>>()

/**
 * Runs one step of a run after any step of it still under way. A step is kept short: nothing that takes minutes
 * (a verification, a worktree's setup) runs inside one while tickets are being built, so that no other ticket's end
 * waits long on it.
 */
export const locked = <T>(feature: string, step: () => Promise<T>): Promise<T> => {
  const run = (steps.get(feature) ?? Promise.resolve()).catch(() => undefined).then(step)

  steps.set(feature, run)

  return run
}
