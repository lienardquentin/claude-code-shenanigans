import type { EngineInterface } from 'claude-code'

import { rootOf } from './flow'
import type { Section } from './flow'

type $ = EngineInterface

/**
 * A plugin of the pipeline marketplace whose installed copy is not what its folder holds. `sameVersion` is set when the
 * copy differs but carries the folder's version, which `claude plugin update` takes for up to date.
 */
export type Lag = { plugin: string; why: 'gone' | 'behind'; installed: string; sameVersion?: string }

const MARKETPLACE = 'pipeline'

// What the copies are compared on: everything the plugin ships, not its tests, caches, or the types the engine writes
// into .claude-plugin/types
const SKIPPED = ['tests', '__pycache__', 'node_modules']
const ENGINE_TYPES = /\/\.claude-plugin(\/types\b|: types$)/

/** Whether `diff -rq` output names a file the plugin ships: a line about the engine's types names none. */
export const differsIn = (diffOutput: string): boolean => diffOutput.split('\n').some(line => line.trim() !== '' && !ENGINE_TYPES.test(line))

/** The version a plugin.json names, or undefined when it names none or cannot be read. */
export const versionOf = (text: string): string | undefined => {
  try {
    const version = (JSON.parse(text) as { version?: unknown }).version

    return typeof version === 'string' ? version : undefined
  } catch {
    return undefined
  }
}

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
    'Some plugins of the pipeline marketplace are not what .claude/mods holds, so this session may run older code than the repository:',
    ...lags.map(lag =>
      lag.why === 'gone'
        ? `- ${lag.plugin}: installed, but no longer in .claude/mods. Uninstall it (claude plugin uninstall ${lag.plugin}) and drop it from enabledPlugins.`
        : lag.sameVersion !== undefined
          ? `- ${lag.plugin}: its installed copy (${lag.installed}) differs from .claude/mods but has the same version (${lag.sameVersion}), so claude plugin update will not take it: bump the version in .claude/mods/${lag.plugin.replace(/@.*$/, '')}/.claude-plugin/plugin.json first. /reload-plugins reads it afresh; a new session starts from the copy.`
          : `- ${lag.plugin}: its installed copy (${lag.installed}) differs from .claude/mods. /reload-plugins reads it afresh; a new session starts from the copy until claude plugin update ${lag.plugin} takes the new version.`,
    ),
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

    const excluded = SKIPPED.flatMap(name => ['-x', name])
    const compared = await $.process.run(['diff', '-rq', ...excluded, installPath, source], { cwd: mods }).catch(() => ({ exitCode: 2, stdout: '' }))

    // diff answers 1 when the folders differ; 2 is a trouble reading them, which says nothing of a lag
    if (compared.exitCode !== 1 || !differsIn(compared.stdout)) continue

    const installedVersion = versionOf(String(await $.fs.read(`${installPath}/.claude-plugin/plugin.json`).catch(() => '')))
    const sourceVersion = versionOf(String(await $.fs.read(`${source}/.claude-plugin/plugin.json`).catch(() => '')))

    lags.push({ plugin: id, why: 'behind', installed: installPath, ...(installedVersion !== undefined && installedVersion === sourceVersion ? { sameVersion: sourceVersion } : {}) })
  }

  return lags
}

/** What Claude is told at each turn while a plugin lags, read once when the session starts. */
let known: Lag[] = []

export async function startLag($: $): Promise<void> {
  known = await lagging($)

  if (known.length > 0) $.ui.toast(`Pipeline: ${known.map(lag => lag.plugin.replace(/@pipeline$/, '')).join(', ')} ${known.length === 1 ? 'lags' : 'lag'} .claude/mods`)
}

export const sectionOfLag = (): Section | undefined => (known.length === 0 ? undefined : { id: 'pipeline:lag', text: lagText(known) })
