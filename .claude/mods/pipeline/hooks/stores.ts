import type { EngineInterface } from 'claude-code'

// The plans and runs were kept under other plugin ids before: in the stores of the six mods the pipeline was made from,
// then in the middle-earth plugin's, each a JSON file under the configuration folder, named by the plugin's id. This
// carries what they keep into the plugin's own store, once, a run under `run:` where it was kept under `quest:`; a key
// the plugin already holds is never overwritten, and the old files are left as they are.
// A helper that takes `$` is a function declaration: past an import, the engine follows `$` into no other kind.

type $ = EngineInterface

// Set once what the old stores held is carried
const CARRIED = 'carried:stores'

/** The old stores, by the plugin they were each kept by, the keys each held that are carried, and what they are kept as. */
const OLD = [
  { file: /^elrond_middle-earth-[0-9a-f]{12}\.json$/, prefix: 'plan:', as: 'plan:' },
  { file: /^fellowship_middle-earth-[0-9a-f]{12}\.json$/, prefix: 'quest:', as: 'run:' },
  { file: /^middle-earth_middle-earth-[0-9a-f]{12}\.json$/, prefix: 'plan:', as: 'plan:' },
  { file: /^middle-earth_middle-earth-[0-9a-f]{12}\.json$/, prefix: 'quest:', as: 'run:' },
] as const

/** Which of a store's keys are carried, as they are kept now (`as` for the prefix): those of the prefix, not held already. */
export const carriedOf = (text: string, prefix: string, held: readonly string[], as = prefix): [string, unknown][] => {
  try {
    const store = JSON.parse(text) as unknown

    return typeof store === 'object' && store !== null && !Array.isArray(store)
      ? Object.entries(store as Record<string, unknown>)
          .filter(([key]) => key.startsWith(prefix))
          .map(([key, value]): [string, unknown] => [`${as}${key.slice(prefix.length)}`, value])
          .filter(([key]) => !held.includes(key))
      : []
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

  for (const { file, prefix, as } of OLD) {
    for (const entry of entries.filter(one => one.kind === 'file' && file.test(one.name))) {
      const held = await $.store.keys()

      for (const [key, value] of carriedOf(String(await $.fs.read(`${folder}/${entry.name}`).catch(() => '')), prefix, held, as)) await $.store.set(key, value)
    }
  }

  await $.store.set(CARRIED, true)
}
