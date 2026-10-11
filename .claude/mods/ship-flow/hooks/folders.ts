import type { Host } from './host'
import { SCRATCH, issuesOf, parseRecord, recordOf, recordText } from './run'
import type { RunRecord } from './run'
import type { Folder } from './status'
import { parseTicket, withStatus } from './tickets'
import type { State, Ticket } from './tickets'

// Every feature folder of the repo that holds tickets, read whole. A folder with no `issues` is not a run.
export const readFolders = async (host: Host): Promise<Folder[]> => {
  if (!(await host.exists(SCRATCH))) return []

  const folders: Folder[] = []
  const features = (await host.list(SCRATCH)).filter(entry => entry.isDir).map(entry => entry.name)

  for (const feature of features.sort()) {
    const issues = issuesOf(feature)

    if (!(await host.exists(issues))) continue

    const files = (await host.list(issues))
      .filter(entry => !entry.isDir && entry.name.endsWith('.md'))
      .map(entry => entry.name)
      .sort()
    const tickets = await Promise.all(
      files.map(async file => parseTicket(file, await host.read(`${issues}/${file}`))),
    )

    const record = await readRecord(host, feature)

    folders.push({ feature, tickets, ...(record ? { record } : {}) })
  }

  return folders
}

/** A feature's run record, or undefined when it has none yet. */
export async function readRecord(host: Host, feature: string): Promise<RunRecord | undefined> {
  return (await host.exists(recordOf(feature))) ? parseRecord(await host.read(recordOf(feature))) : undefined
}

export const writeRecord = (host: Host, record: RunRecord): Promise<void> =>
  host.write(recordOf(record.feature), recordText(record))

/** Rewrites one ticket file's `Status:` line. */
export const writeStatus = async (host: Host, feature: string, ticket: Ticket, status: State) => {
  const path = `${issuesOf(feature)}/${ticket.file}`

  await host.write(path, withStatus(await host.read(path), status))
}
