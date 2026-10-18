// Where work happens: the project's own folder, or a run's worktree. The build makes each run a git worktree of its
// own under RUN_TREES, and sends its builders, the test writer and the reviewers to work there; the mods whose tools
// they call (verify, the recorder, tests first) learn each agent's folder from its spawn, and do their work in it. This
// file is the same in each of them.

/** Where the build keeps its runs' worktrees, from the project's folder. */
export const RUN_TREES = '.theseus/trees'

/** The folder each agent a mod sent works in, by the agent's id: the `cwd` its spawn named. */
export type Trees = Record<string, string>

// How many agents' folders are kept: a run's agents are few, and an old one is never asked of again
const KEPT = 64

const tidy = (path: string): string => path.replace(/\/+$/, '')

/** The folders kept, with one more agent's. */
export const withTree = (trees: Trees, agentId: string, cwd: string): Trees =>
  Object.fromEntries([...Object.entries(trees).filter(([id]) => id !== agentId), [agentId, tidy(cwd)] as const].slice(-KEPT))

/** Whether a folder is one work may be done in: the project's own, or a run's worktree under it. */
export const isTree = (home: string, path: string): boolean => {
  const root = tidy(home)
  const tree = tidy(path)

  return tree === root || (tree.startsWith(`${root}/${RUN_TREES}/`) && !tree.slice(root.length + RUN_TREES.length + 2).includes('..'))
}

/**
 * The folder a tool call is about: the one a mod names outright (`tree`), else the one the calling agent was sent to
 * work in, else the project's. A folder that is neither the project's nor a run's is never taken.
 */
export const treeOf = (home: string, trees: Trees, agentId: string | undefined, named?: unknown): string => {
  if (typeof named === 'string' && named.trim() !== '' && isTree(home, named.trim())) return tidy(named.trim())

  const sent = agentId === undefined ? undefined : trees[agentId]

  return sent !== undefined && isTree(home, sent) ? sent : tidy(home)
}
