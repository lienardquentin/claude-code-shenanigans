import { locked, readFolders } from './folders'
import { requestOf } from './forge'
import type { Host } from './host'
import { finishingOf, folderOf, ticketBranchOf, treeOf } from './run'
import { isWindowsPath } from './shell'
import { tail, unplant } from './work'

// A feature's name as the mod makes one: nothing a shell or a path could read as anything else
const NAME = /^[a-z0-9][a-z0-9-]*$/

/**
 * `/ship clean <feature>`: removes everything a run keeps on this machine: its folder (the spec, the tickets, the
 * record), its worktrees, and the branches those were on. The run's own branch, and what it pushed and opened on
 * its forge, are left. The feature is always named: nothing here can be brought back. Refused while the run is at work.
 */
export const clean = async (host: Host, wanted: string): Promise<string> => {
  const folders = await readFolders(host)
  const names = folders.map(folder => folder.feature).join(', ')

  if (wanted === '') return `Name the run to clean: /ship clean <feature>.${names !== '' ? ` Here: ${names}.` : ''}`

  const folder = folders.find(other => other.feature === wanted)

  if (!folder) return names === '' ? 'No run in this repo.' : `No run named ${wanted}. Here: ${names}.`

  const { feature, record } = folder

  if (!NAME.test(feature)) return `${feature}: its folder is not named as a run's is. Remove ${folderOf(feature)}/ by hand.`

  return locked(feature, async () => {
    const running = new Set((await host.agents()).filter(agent => agent.isRunning).map(agent => agent.id))
    const atWork = [...(record?.flights ?? []).flatMap(flight => flight.agentId ?? []), ...(record?.agentId !== undefined ? [record.agentId] : [])]

    if ((record?.phase === 'unattended' || record?.phase === 'finishing') && atWork.some(agentId => running.has(agentId))) {
      return `${feature}: is at work. /ship stop ${feature} first.`
    }

    // Every worktree the run made is under its folder, each on a branch named for it
    const trees = `${folderOf(feature)}/trees`
    const made = (await host.exists(trees)) ? (await host.list(trees)).filter(entry => entry.isDir).map(entry => entry.name) : []

    if (record && record.branch !== '') {
      for (const key of made) await unplant(host, { tree: treeOf(feature, key), branch: ticketBranchOf(record.branch, key) })
      for (const flight of [...(record.flights ?? []), finishingOf(record)]) await unplant(host, flight)
    }

    const root = await host.repo()
    const removed = await host
      .run(
        isWindowsPath(root) ? ['cmd', '/d', '/s', '/c', `rmdir /s /q ${folderOf(feature).replaceAll('/', '\\')}`] : ['rm', '-rf', folderOf(feature)],
        { cwd: root },
      )
      .catch((error: unknown) => ({ exitCode: 1, stdout: '', stderr: error instanceof Error ? error.message : String(error) }))

    if (await host.exists(folderOf(feature))) {
      return `${feature}: ${folderOf(feature)}/ could not be removed: ${tail(removed.stderr || removed.stdout).trim() || 'it is still there'}.`
    }

    host.changed()

    return [
      made.length > 0
        ? `${feature}: its folder, ${made.length} ${made.length === 1 ? 'worktree and its branch' : 'worktrees and their branches'} are gone.`
        : `${feature}: its folder is gone.`,
      ...(record && record.branch !== ''
        ? [record.pr ? `The branch ${record.branch} and its ${requestOf(record)} ${record.pr.url} are left as they are.` : `The branch ${record.branch} is left as it is.`]
        : []),
    ].join(' ')
  })
}
