import type { MountdoomKeeper, MountdoomRelic } from '../../types'

export const HOW_TO = 'Nothing is kept of any quest. Mount Doom watches what the Fellowship and the Black Gate keep, and once a pull request is merged, /mountdoom cast throws all of it into the fire: its worktree, its branch, and what every part remembers of it.'

/** What a part keeps of a branch's work. */
type Kept = { ref?: unknown; branch?: unknown; base?: unknown; pr?: unknown; tree?: unknown }

/** What the parts keep, one relic a branch: a quest and the gate open on its pull request are one. */
export const gathered = (answers: readonly { keeper: MountdoomKeeper; kept: readonly Kept[] }[]): MountdoomRelic[] => {
  const relics: MountdoomRelic[] = []

  for (const { keeper, kept } of answers) {
    for (const one of kept) {
      const branch = typeof one.branch === 'string' ? one.branch : ''

      if (branch === '') continue

      const was = relics.find(relic => relic.branch === branch)
      const pr = typeof one.pr === 'string' ? one.pr : ''
      const tree = typeof one.tree === 'string' ? one.tree : ''

      const quests = keeper === 'fellowship' && typeof one.ref === 'string' && one.ref !== '' ? [one.ref] : []

      if (was !== undefined) {
        if (!was.keepers.includes(keeper)) was.keepers.push(keeper)
        for (const ref of quests) if (!(was.quests ?? []).includes(ref)) was.quests = [...(was.quests ?? []), ref]
        if (was.pr === '') was.pr = pr
        if (was.tree === '') was.tree = tree
        // The issue's ref, as Elrond writes it, is the one a plan is kept by: it wins over a gate's own
        if (keeper !== 'blackgate' && typeof one.ref === 'string') was.ref = one.ref
        continue
      }

      relics.push({ ref: typeof one.ref === 'string' ? one.ref : '', branch, base: typeof one.base === 'string' ? one.base : '', tree, pr, keepers: [keeper], ...(quests.length > 0 ? { quests } : {}), isMerged: false })
    }
  }

  return relics
}

/** The forge's CLI that finds a merged pull request by the branch it came from. */
export const findArgv = (forge: 'github' | 'gitlab', branch: string): string[] =>
  forge === 'github' ? ['gh', 'pr', 'list', '--head', branch, '--state', 'merged', '--json', 'url', '--limit', '1'] : ['glab', 'mr', 'list', '--source-branch', branch, '--merged', '--output', 'json']

/** The URL of the merged pull request the forge found, if any. */
export const foundUrl = (answer: string): string => {
  try {
    const held = JSON.parse(answer) as { url?: unknown; web_url?: unknown }[]

    return String(held[0]?.url ?? held[0]?.web_url ?? '')
  } catch {
    return ''
  }
}

/** Whether a ref is an issue as Elrond writes it, which a plan is kept by. */
export const isIssueRef = (ref: string): boolean => /^(github|gitlab):.+#\d+$/.test(ref)

/** A relic in a line. */
export const relicLine = (relic: MountdoomRelic): string =>
  `${relic.isMerged ? '🔥' : '·'} ${relic.ref !== '' ? relic.ref : relic.branch} on ${relic.branch} (${relic.keepers.join(', ')})${relic.pr !== '' ? ` · ${relic.pr}` : ' · no pull request known'}${relic.isMerged ? ' · merged' : ''}`

/** What Mount Doom watches, for Claude. */
export const relicsText = (relics: readonly MountdoomRelic[]): string =>
  relics.length === 0
    ? HOW_TO
    : [
        `Mount Doom watches ${relics.length} ${relics.length === 1 ? 'relic' : 'relics'}; ${relics.filter(one => one.isMerged).length} merged, ready for the fire.`,
        ...relics.map(relicLine),
        ...(relics.some(one => one.isMerged) ? ['', 'The person casts them with /mountdoom cast: no tool offers it to Claude.'] : []),
      ].join('\n')
