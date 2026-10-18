import type { CleanupKeeper, Leftover } from '../../types'

export const HOW_TO = 'Nothing is kept of any run. The cleanup watches what the build and the review follow-up keep, and once a pull request is merged, /theseus cleanup clean removes all of it: its worktree, its branch, and what every part remembers of it.'

/** What a part keeps of a branch's work. */
type Kept = { ref?: unknown; branch?: unknown; base?: unknown; pr?: unknown; tree?: unknown }

/** What the parts keep, one leftover a branch: a run and the review follow-up open on its pull request are one. */
export const gathered = (answers: readonly { keeper: CleanupKeeper; kept: readonly Kept[] }[]): Leftover[] => {
  const leftovers: Leftover[] = []

  for (const { keeper, kept } of answers) {
    for (const one of kept) {
      const branch = typeof one.branch === 'string' ? one.branch : ''

      if (branch === '') continue

      const was = leftovers.find(one => one.branch === branch)
      const pr = typeof one.pr === 'string' ? one.pr : ''
      const tree = typeof one.tree === 'string' ? one.tree : ''

      const quests = keeper === 'build' && typeof one.ref === 'string' && one.ref !== '' ? [one.ref] : []

      if (was !== undefined) {
        if (!was.keepers.includes(keeper)) was.keepers.push(keeper)
        for (const ref of quests) if (!(was.quests ?? []).includes(ref)) was.quests = [...(was.quests ?? []), ref]
        if (was.pr === '') was.pr = pr
        if (was.tree === '') was.tree = tree
        // The issue's ref, as the planner writes it, is the one a plan is kept by: it wins over a review's own
        if (keeper !== 'follow-up' && typeof one.ref === 'string') was.ref = one.ref
        continue
      }

      leftovers.push({ ref: typeof one.ref === 'string' ? one.ref : '', branch, base: typeof one.base === 'string' ? one.base : '', tree, pr, keepers: [keeper], ...(quests.length > 0 ? { quests } : {}), isMerged: false })
    }
  }

  return leftovers
}

/** Whether a ref is an issue as the planner writes it, which a plan is kept by. */
export const isIssueRef = (ref: string): boolean => /^(github|gitlab):.+#\d+$/.test(ref)

/** A leftover in a line. */
export const leftoverLine = (leftover: Leftover): string =>
  `${leftover.isMerged ? '●' : '·'} ${leftover.ref !== '' ? leftover.ref : leftover.branch} on ${leftover.branch} (${leftover.keepers.join(', ')})${leftover.pr !== '' ? ` · ${leftover.pr}` : ' · no pull request known'}${leftover.isMerged ? ' · merged' : ''}${leftover.isConflicting === true ? ' · in conflict with its base' : ''}${leftover.unknown !== undefined ? ` · the forge could not say whether it is merged: ${leftover.unknown}` : ''}`

/** What the cleanup watches, for Claude. */
export const leftoversText = (leftovers: readonly Leftover[]): string =>
  leftovers.length === 0
    ? HOW_TO
    : [
        `The cleanup watches ${leftovers.length} ${leftovers.length === 1 ? 'leftover' : 'leftovers'}; ${leftovers.filter(one => one.isMerged).length} merged, ready to clean up.`,
        ...leftovers.map(leftoverLine),
        ...(leftovers.some(one => one.isMerged) ? ['', 'The person cleans them up with /theseus cleanup clean: no tool offers it to Claude.'] : []),
      ].join('\n')
