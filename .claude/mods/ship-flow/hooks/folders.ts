import type { Host } from './host'
import { SCRATCH, issuesOf, parseRecord, recordOf, recordText } from './run'
import type { RunRecord } from './run'
import type { Folder } from './status'
import { parseTicket, withStatus } from './tickets'
import type { State, Ticket } from './tickets'

// Every feature folder of the repo that is a run, read whole: one that holds tickets, or a run record.
export const readFolders = async (host: Host): Promise<Folder[]> => {
  if (!(await host.exists(SCRATCH))) return []

  const folders: Folder[] = []
  const features = (await host.list(SCRATCH)).filter(entry => entry.isDir).map(entry => entry.name)

  for (const feature of features.sort()) {
    const issues = issuesOf(feature)
    const hasTickets = await host.exists(issues)
    const record = await readRecord(host, feature)

    // A run exists from its record on, before it has a ticket: the attended phase writes them last
    if (!hasTickets && !record) continue

    const files = hasTickets
      ? (await host.list(issues))
          .filter(entry => !entry.isDir && entry.name.endsWith('.md'))
          .map(entry => entry.name)
          .sort()
      : []
    const tickets = await Promise.all(
      files.map(async file => parseTicket(file, await host.read(`${issues}/${file}`))),
    )

    folders.push({ feature, tickets, ...(record ? { record } : {}) })
  }

  return folders
}

/** A feature's run record, or undefined when it has none yet. */
export async function readRecord(host: Host, feature: string): Promise<RunRecord | undefined> {
  return (await host.exists(recordOf(feature))) ? parseRecord(await host.read(recordOf(feature))) : undefined
}

// The write of each record still under way. Two hooks may write one record at the same moment (a response is
// measured while the tool call it carries is checked), and two writes at once leave a file that is neither.
const writing = new Map<string, Promise<void>>()

/** Writes a run's record, after any write of it still under way: a record's file is never written twice at once. */
export const writeRecord = async (host: Host, record: RunRecord): Promise<void> => {
  const path = recordOf(record.feature)
  const write = (writing.get(path) ?? Promise.resolve()).catch(() => undefined).then(() => host.write(path, recordText(record)))

  writing.set(path, write)
  await write
  host.changed()
}

/** Rewrites one ticket file's `Status:` line. */
export const writeStatus = async (host: Host, feature: string, ticket: Ticket, status: State) => {
  const path = `${issuesOf(feature)}/${ticket.file}`

  await host.write(path, withStatus(await host.read(path), status))
  host.changed()
}
