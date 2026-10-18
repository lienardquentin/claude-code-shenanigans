import type { EngineInterface } from 'claude-code'

import { rootOf } from './flow'
import { reported } from './trouble'

// Theseus was the `pipeline` plugin until 0.3.0. A plugin's store is a JSON file under the configuration folder, named
// by its id, and a project's own files sat in .pipeline/: what the pipeline kept is carried over once, here. A key
// Theseus already holds is never overwritten, and the old store files are left as they are.
// A helper that takes `$` is a function declaration: past an import, the engine follows `$` into no other kind.

type $ = EngineInterface

// Set once what the old stores held is carried
const CARRIED = 'carried:pipeline'

/** The pipeline's store files: the installed plugin's, and the one it kept when loaded from its folder. */
const OLD_STORE = /^pipeline_(pipeline|inline)-[0-9a-f]{12}\.json$/

/** The keys carried: the plans and the runs. */
const PREFIXES = ['plan:', 'run:'] as const

/** The project's folder of the pipeline's own, and Theseus's. */
const OLD_FOLDER = '.pipeline'
const FOLDER = '.theseus'

/**
 * Which of an old store's keys are carried, as Theseus keeps them: those of the prefixes it does not hold already, with
 * every path into the old folder pointed into the new one. `undefined` when the text is not a store.
 */
export const carriedOf = (text: string, held: readonly string[]): [string, unknown][] | undefined => {
  let store: unknown

  try {
    store = JSON.parse(text)
  } catch {
    return undefined
  }

  if (typeof store !== 'object' || store === null || Array.isArray(store)) return undefined

  return Object.entries(store as Record<string, unknown>)
    .filter(([key]) => PREFIXES.some(prefix => key.startsWith(prefix)) && !held.includes(key))
    .map(([key, value]): [string, unknown] => [key, JSON.parse(JSON.stringify(value).replaceAll(`/${OLD_FOLDER}/`, `/${FOLDER}/`)) as unknown])
}

/** Carries the plans and runs the pipeline's stores keep into Theseus's own, once. */
export async function carryStores($: $): Promise<void> {
  if ((await $.store.get(CARRIED)) === true) return

  const config = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${(await $.env.get('HOME')) ?? ''}/.claude`
  const folder = `${config.replace(/\/+$/, '')}/plugins/store`
  // No store folder yet: nothing was ever kept
  if (!(await $.fs.exists(folder))) return $.store.set(CARRIED, true)

  for (const entry of (await $.fs.list(folder)).filter(one => one.kind === 'file' && OLD_STORE.test(one.name))) {
    const carried = carriedOf(String(await $.fs.read(`${folder}/${entry.name}`)), await $.store.keys())

    if (carried === undefined) {
      reported($, 'the store carry')(new Error(`${folder}/${entry.name} is not a store that reads: its plans and runs were not carried`))
      continue
    }

    for (const [key, value] of carried) await $.store.set(key, value)
  }

  await $.store.set(CARRIED, true)
}

/**
 * Moves the project's .pipeline/ folder to .theseus/ when only the old one is there, and has git repair the worktrees
 * it holds (the runs' trees, the proof's), which it still knows by their old paths.
 */
export async function carryFolder($: $): Promise<void> {
  const root = await rootOf($)

  if (!(await $.fs.exists(`${root}/${OLD_FOLDER}`)) || (await $.fs.exists(`${root}/${FOLDER}`))) return

  const listed = await $.process.run(['git', 'worktree', 'list', '--porcelain'], { cwd: root })
  const moved = listed.stdout
    .split('\n')
    .filter(line => line.startsWith(`worktree ${root}/${OLD_FOLDER}/`))
    .map(line => `${root}/${FOLDER}/${line.slice(`worktree ${root}/${OLD_FOLDER}/`.length)}`)
  const renamed = await $.process.run(['mv', `${root}/${OLD_FOLDER}`, `${root}/${FOLDER}`], { cwd: root })

  if (renamed.exitCode !== 0) throw new Error(`${OLD_FOLDER}/ could not be moved to ${FOLDER}/: ${renamed.stderr.trim()}`)
  if (moved.length === 0) return

  const repaired = await $.process.run(['git', 'worktree', 'repair', ...moved], { cwd: root })

  if (repaired.exitCode !== 0) throw new Error(`git could not repair the worktrees moved into ${FOLDER}/: ${repaired.stderr.trim()}`)
}
