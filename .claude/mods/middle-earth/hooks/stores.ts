import type { EngineInterface } from 'claude-code'

// Elrond's plans and the build's runs were kept, before the mods were one, in a store of each mod's own: a JSON
// file under the configuration folder, named by the plugin's id. This carries what they keep into the plugin's own
// store, once; a key the plugin already holds is never overwritten, and the old files are left as they are.
// A helper that takes `$` is a function declaration: past an import, the engine follows `$` into no other kind.

type $ = EngineInterface

// Set once what the old stores held is carried
const CARRIED = 'carried:mods'

/** The old stores, by the plugin they were each kept by, and the keys each held that are carried. */
const OLD = [
  { file: /^elrond_middle-earth-[0-9a-f]{12}\.json$/, prefix: 'plan:' },
  { file: /^fellowship_middle-earth-[0-9a-f]{12}\.json$/, prefix: 'quest:' },
] as const

/** Which of a store's keys are carried: those of the prefix, not held already. */
export const carriedOf = (text: string, prefix: string, held: readonly string[]): [string, unknown][] => {
  try {
    const store = JSON.parse(text) as unknown

    return typeof store === 'object' && store !== null && !Array.isArray(store) ? Object.entries(store as Record<string, unknown>).filter(([key]) => key.startsWith(prefix) && !held.includes(key)) : []
  } catch {
    return []
  }
}

/** Carries the plans and runs the old stores keep into this plugin's own, once. */
export async function carryStores($: $): Promise<void> {
  if ((await $.store.get(CARRIED)) === true) return

  const config = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${(await $.env.get('HOME')) ?? ''}/.claude`
  const folder = `${config.replace(/\/+$/, '')}/plugins/store`
  // A folder that cannot be read is tried again at the next session's start
  const entries = await $.fs.list(folder).catch(() => undefined)

  if (entries === undefined) return

  for (const { file, prefix } of OLD) {
    for (const entry of entries.filter(one => one.kind === 'file' && file.test(one.name))) {
      const held = await $.store.keys()

      for (const [key, value] of carriedOf(String(await $.fs.read(`${folder}/${entry.name}`).catch(() => '')), prefix, held)) await $.store.set(key, value)
    }
  }

  await $.store.set(CARRIED, true)
}
