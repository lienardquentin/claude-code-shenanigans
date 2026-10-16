import type { EngineInterface } from 'claude-code'

import { rootOf } from './flow'
import type { Section } from './flow'

type $ = EngineInterface

/** A plugin of the middle-earth marketplace whose installed copy is not what its folder holds. */
export type Lag = { plugin: string; why: 'gone' | 'behind'; installed: string }

const MARKETPLACE = 'middle-earth'

// What the copies are compared on: the code that runs, not its tests or the types the engine writes into it
const COMPARED = 'hooks'

/** The plugins installed from the marketplace, by id, with the folder each was copied to: from installed_plugins.json. */
export const installedOf = (text: string): { id: string; name: string; installPath: string }[] => {
  let held: unknown

  try {
    held = JSON.parse(text)
  } catch {
    return []
  }

  const all = (typeof held === 'object' && held !== null && 'plugins' in held ? (held as { plugins: unknown }).plugins : held) as Record<string, unknown>

  return Object.entries(typeof all === 'object' && all !== null ? all : {})
    .filter(([id]) => id.endsWith(`@${MARKETPLACE}`))
    .map(([id, entries]) => ({ id, name: id.slice(0, -`@${MARKETPLACE}`.length), installPath: String((Array.isArray(entries) ? (entries[0] as { installPath?: unknown } | undefined)?.installPath : '') ?? '') }))
}

/** What the session is told of the plugins that lag: which, why, and how each is brought level. */
export const lagText = (lags: readonly Lag[]): string =>
  [
    'Some plugins of the middle-earth marketplace are not what .claude/mods holds, so this session may run older code than the repository:',
    ...lags.map(lag => (lag.why === 'gone' ? `- ${lag.plugin}: installed, but no longer in .claude/mods. Uninstall it (claude plugin uninstall ${lag.plugin}) and drop it from enabledPlugins.` : `- ${lag.plugin}: its installed copy (${lag.installed}) differs from .claude/mods. /reload-plugins reads it afresh; a new session starts from the copy.`)),
    'Say so to the person before trusting what these plugins do.',
  ].join('\n')

/**
 * The plugins of the marketplace that lag their folder: gone from it, or installed as a copy whose code differs from
 * it. A plugin read from its folder lags nothing; an install record that cannot be read names none.
 */
export async function lagging($: $): Promise<Lag[]> {
  let config = '/.claude'

  // A host with no environment to read (the test kit's) looks under no home
  try {
    config = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${(await $.env.get('HOME')) ?? ''}/.claude`
  } catch {
    // no environment
  }

  const text = await $.fs.read(`${config.replace(/\/+$/, '')}/plugins/installed_plugins.json`).catch(() => '')
  const mods = `${await rootOf($)}/.claude/mods`
  const lags: Lag[] = []

  for (const { id, name, installPath } of installedOf(typeof text === 'string' ? text : '')) {
    const source = `${mods}/${name}`
    const isThere = await $.fs
      .read(`${source}/.claude-plugin/plugin.json`)
      .then(() => true)
      .catch(() => false)

    if (!isThere) {
      lags.push({ plugin: id, why: 'gone', installed: installPath })
      continue
    }

    if (installPath === '' || installPath === source) continue

    const compared = await $.process.run(['diff', '-rq', `${installPath}/${COMPARED}`, `${source}/${COMPARED}`], { cwd: mods }).catch(() => ({ exitCode: 2 }))

    // diff answers 1 when the folders differ; 2 is a trouble reading them, which says nothing of a lag
    if (compared.exitCode === 1) lags.push({ plugin: id, why: 'behind', installed: installPath })
  }

  return lags
}

/** What Claude is told at each turn while a plugin lags, read once when the session starts. */
let known: Lag[] = []

export async function startLag($: $): Promise<void> {
  known = await lagging($).catch(() => [])

  if (known.length > 0) $.ui.toast(`Middle-earth: ${known.map(lag => lag.plugin.replace(/@middle-earth$/, '')).join(', ')} ${known.length === 1 ? 'lags' : 'lag'} .claude/mods`)
}

export const sectionOfLag = (): Section | undefined => (known.length === 0 ? undefined : { id: 'middle-earth:lag', text: lagText(known) })
