import type { EngineInterface, Register } from 'claude-code'

import { statusText } from './status'
import type { Folder } from './status'
import { parseTicket } from './tickets'

// Where a run keeps its working files, relative to the session's working directory
const SCRATCH = '.scratch'

const USAGE = 'Usage: /ship status. Starting and resuming a run are not built yet.'

// Every feature folder of the repo that holds tickets, read whole. A folder with no `issues` is not a run.
const readFolders = async ($: EngineInterface): Promise<Folder[]> => {
  if (!(await $.fs.exists(SCRATCH))) return []

  const folders: Folder[] = []
  const features = (await $.fs.list(SCRATCH)).filter(entry => entry.kind === 'dir').map(entry => entry.name)

  for (const feature of features.sort()) {
    const issues = `${SCRATCH}/${feature}/issues`

    if (!(await $.fs.exists(issues))) continue

    const files = (await $.fs.list(issues))
      .filter(entry => entry.kind === 'file' && entry.name.endsWith('.md'))
      .map(entry => entry.name)
      .sort()
    const tickets = await Promise.all(
      files.map(async file => parseTicket(file, await $.fs.read(`${issues}/${file}`))),
    )

    folders.push({ feature, tickets })
  }

  return folders
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'ship',
      description: 'Takes one feature from an idea or an issue to a pull request',
      argumentHint: 'status',
    })

    return next(e)
  })

  on('command.run', { command: 'ship' }, async ($, e) => {
    if (e.args.trim() !== 'status') return { text: USAGE }

    return { text: statusText(await readFolders($)) }
  })
    // A folder that cannot be read is said in the answer: a hook that throws is skipped without a word
    .catch(() => ({ text: `ship-flow could not read the ticket folders under ${SCRATCH}.` }))
}
