import type { EngineInterface } from 'claude-code'

import { CONFIG_FILE, LINES_FILE, projectOfLines, projectToml, proposeProject } from '../core/config'
import type { Found } from '../core/config'
import { rootOf } from './flow'

// /theseus init: the project's file, proposed from what the project holds, or carried from the line format, shown
// before it is written.
// A helper that takes `$` is a function declaration: past an import, the engine follows `$` into no other kind.

type $ = EngineInterface

const MANIFESTS = /(^|\/)(Cargo\.toml|pyproject\.toml|package\.json)$/
// How deep a manifest is looked for, and how many Python files are read for a FastAPI app
const DEPTH = 3
const PYTHON_FILES = 400

/** The project's file Theseus would write: from .claude/verify where it is there, else from the project's manifests. */
async function proposal($: $, root: string): Promise<{ text: string; from: string }> {
  if (await $.fs.exists(`${root}/${LINES_FILE}`)) {
    const read = projectOfLines(String(await $.fs.read(`${root}/${LINES_FILE}`)), root)

    return { text: projectToml(read, root), from: LINES_FILE }
  }

  const listed = await $.process.run(['git', 'ls-files', '--cached', '--others', '--exclude-standard'], { cwd: root })

  if (listed.exitCode !== 0) throw new Error(`git could not list the project's files: ${listed.stderr.trim()}`)
  const paths = listed.stdout.split('\n').filter(path => path !== '')
  const held = new Set(paths.flatMap(path => path.split('/').map((_, at, parts) => parts.slice(0, at + 1).join('/'))))
  const manifests = paths.filter(path => MANIFESTS.test(path) && path.split('/').length <= DEPTH + 1 && !path.includes('node_modules/'))
  const pythonRoots = manifests.filter(path => path.endsWith('pyproject.toml')).map(path => (path.includes('/') ? `${path.slice(0, path.lastIndexOf('/'))}/` : ''))
  const python = paths.filter(path => path.endsWith('.py') && pythonRoots.some(folder => path.startsWith(folder)) && !/(^|\/)tests?\//.test(path)).slice(0, PYTHON_FILES)
  const found: Found[] = []

  for (const path of [...manifests, ...python]) found.push({ path, text: String(await $.fs.read(`${root}/${path}`)) })

  return { text: projectToml(proposeProject(found, path => held.has(path), root, root.split('/').at(-1) ?? 'app'), root), from: 'the project' }
}

/** `/theseus init [--write] [--force]`: proposes the project's file, and writes it when asked. */
export async function initCommand($: $, args: string): Promise<{ text: string }> {
  const words = args.trim().split(/\s+/)
  const root = await rootOf($)
  const isThere = await $.fs.exists(`${root}/${CONFIG_FILE}`)

  if (isThere && !words.includes('--force')) return { text: `${CONFIG_FILE} is there already: /theseus doctor says whether it reads. /theseus init --force proposes it afresh.` }

  const { text, from } = await proposal($, root)

  if (!words.includes('--write')) return { text: `What Theseus would write to ${CONFIG_FILE}, read from ${from}:\n\n${text}\n/theseus init --write${isThere ? ' --force' : ''} writes it. docs/config.md says what each key does.` }

  await $.fs.write(`${root}/${CONFIG_FILE}`, text)

  return { text: `Wrote ${CONFIG_FILE}, read from ${from}.${from === LINES_FILE ? ` ${LINES_FILE} is no longer read: remove it once the new file reads as you want.` : ''} /theseus doctor checks what it needs.` }
}
