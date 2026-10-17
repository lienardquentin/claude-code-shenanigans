import { UNMODDED, secretsIn } from './change'
import type { Shell } from './forge'

// What a quest asks of git in its worktrees: committing a task's change as its own, and landing a lane's commit on its
// quest's branch. Each runs through a shell in the worktree it is about, and answers what came of it for the quest to
// act on.

/** A git command's end: whether it ended well, and what it said (its error when it did not). */
export const git = async (shell: Shell, args: readonly string[]): Promise<{ ok: boolean; out: string }> => {
  const ran = await shell.run(['git', ...args])

  return { ok: ran.exitCode === 0, out: (ran.exitCode === 0 ? ran.stdout : ran.stderr || ran.stdout).trim() }
}

// The config by which a git command runs code of the repository's: its hooks, its filters, what it includes, what it
// watches the tree with. A builder's change can set none of it (the config is outside its worktree, `git config` is
// refused it), so a commit made after it changed was not the person's to make
const GIT_RUNS = '^(core\\.(hookspath|fsmonitor|sshcommand|attributesfile)|include(if)?\\..*|filter\\..*|diff\\..*\\.(command|textconv))$'

/** What git's config says of the code a git command run in the shell's folder would run. */
export const gitRunsOf = async (shell: Shell): Promise<string> =>
  // None of it set is no error: git answers 1, and nothing
  (await git(shell, ['config', '--show-origin', '--get-regexp', GIT_RUNS])).out

/**
 * Why a commit in a tree is not the mod's to make: what git's config runs changed since the quest set out (`gitRuns`,
 * as it was then), or the change touches the hooks the commit would run. Nothing when it may be made.
 */
export const commitRefusal = async (shell: Shell, tree: string, gitRuns: string | undefined): Promise<string | undefined> => {
  const runs = await gitRunsOf(shell)

  if (gitRuns !== undefined && runs !== gitRuns) return `git's config of what a commit runs (hooks, filters, includes) changed in ${tree} since the quest set out, so its commit is not made: look at \`git config --show-origin --get-regexp '${GIT_RUNS}'\` there, and once it is as it should be, put the task before the Argonath again.`

  const hooks = (await git(shell, ['rev-parse', '--path-format=absolute', '--git-path', 'hooks'])).out
  const touched = hooks.startsWith(`${tree}/`) ? (await git(shell, ['status', '--porcelain', '--', hooks])).out : ''

  return touched === '' ? undefined : `The change touches the git hooks its own commit would run (${hooks}), so it is not committed by the mod: look at them, and commit it by hand if they are as they should be.`
}

/** What came of committing a task's change. */
export type Committed = { kind: 'clean' } | { kind: 'committed'; sha: string } | { kind: 'refused'; why: string }

/**
 * Commits the change in a tree as a task's own, the mods' folders left out: nothing where the tree holds no change;
 * refused where the commit is not the mod's to make, where what is staged looks like it holds a secret (unstaged
 * again, as a secret in a commit outlives the commit), or where git would not commit it.
 */
export const commitTask = async (shell: Shell, asked: { tree: string; taskId: number; message: string; gitRuns: string | undefined }): Promise<Committed> => {
  const dirty = await git(shell, ['status', '--porcelain', ...UNMODDED])

  if (dirty.out === '') return { kind: 'clean' }

  const refused = await commitRefusal(shell, asked.tree, asked.gitRuns)

  if (refused !== undefined) return { kind: 'refused', why: refused }

  const added = await git(shell, ['add', '-A', ...UNMODDED])
  const staged = added.ok ? await git(shell, ['diff', '--cached', '--no-color', '--no-ext-diff']) : added
  const leaked = staged.ok ? secretsIn(staged.out) : []

  if (staged.ok && leaked.length > 0) {
    await git(shell, ['reset', '-q'])

    return { kind: 'refused', why: `Task ${asked.taskId}'s change adds what looks like a secret (${leaked.join('; ')}), so it is not committed: take it out of ${asked.tree}, then put the task before the Argonath again.` }
  }

  const done = staged.ok ? await git(shell, ['commit', '-m', asked.message]) : staged

  if (!done.ok) return { kind: 'refused', why: `Task ${asked.taskId} could not be committed: ${done.out}` }

  return { kind: 'committed', sha: (await git(shell, ['rev-parse', 'HEAD'])).out }
}

/** What came of landing a lane's commit on its quest's branch. */
export type Landed =
  | { kind: 'landed'; sha: string }
  | { kind: 'rebased'; onto: string }
  | { kind: 'conflicts'; onto: string }
  | { kind: 'stop'; why: string }

/**
 * Lands a lane's commit (`sha`, empty for a task that changed nothing) on its quest's branch: fast-forwarded there as it
 * is, where nothing landed since the lane set out; else taken onto what landed and left uncommitted on it, to be proved
 * there again; or found in conflict with it. `lane` runs in the lane's worktree, `quest` in its quest's.
 */
export const landLane = async (lane: Shell, quest: Shell, asked: { taskId: number; sha: string; branch: string; laneTree: string; questTree: string }): Promise<Landed> => {
  const tip = await git(lane, ['rev-parse', `refs/heads/${asked.branch}`])
  const onto = tip.out
  const base = asked.sha === '' ? tip : await git(lane, ['merge-base', 'HEAD', onto])

  if (!tip.ok || !base.ok) return { kind: 'stop', why: `Task ${asked.taskId} cannot land: git could not say where ${asked.branch} stands against the lane (${(tip.ok ? base : tip).out || 'it said nothing'}).` }

  if (base.out !== onto) {
    const rebased = await git(lane, ['rebase', onto])

    if (!rebased.ok) return { kind: 'conflicts', onto }

    // The change stands uncommitted on what landed, as it is proved, and is committed again once the proof settles
    const reset = await git(lane, ['reset', '-q', '--soft', 'HEAD~1'])

    if (!reset.ok) return { kind: 'stop', why: `Task ${asked.taskId} was taken onto ${asked.branch}, but could not be uncommitted there to be proved again: ${reset.out}. Its change is the last commit in ${asked.laneTree}.` }

    return { kind: 'rebased', onto }
  }

  if (asked.sha === '') return { kind: 'landed', sha: '' }

  const merged = await git(quest, ['merge', '--ff-only', asked.sha])

  if (!merged.ok) return { kind: 'stop', why: `Task ${asked.taskId} could not land on ${asked.branch} in ${asked.questTree}: ${merged.out}. Once that worktree is clean, put the task before the Argonath again.` }

  return { kind: 'landed', sha: (await git(quest, ['rev-parse', 'HEAD'])).out }
}

/**
 * Where a lane's change no longer applies on its quest's branch: the lane put on that branch as it stands (`onto`), and
 * the change applied on it with no commit, git's conflict markers in the files where the two meet. Answers that it
 * applies after all, the files in conflict, or why it could not be applied.
 */
export const applyAfresh = async (lane: Shell, onto: string, sha: string): Promise<{ kind: 'applies' } | { kind: 'conflicts'; files: string[] } | { kind: 'failed'; why: string }> => {
  await git(lane, ['rebase', '--abort'])

  const reset = await git(lane, ['reset', '-q', '--hard', onto])
  // The change applied with no commit: git stops on what conflicts, marked in the files, which is what is resolved
  const picked = reset.ok ? await git(lane, ['cherry-pick', '--no-commit', sha]) : reset
  const files = (await git(lane, ['diff', '--name-only', '--diff-filter=U'])).out.split('\n').filter(line => line !== '')

  await git(lane, ['cherry-pick', '--quit'])
  await git(lane, ['reset', '-q'])

  // The rebase stopped on something else, and the change applies on what landed after all
  if (reset.ok && picked.ok) return { kind: 'applies' }
  if (!reset.ok || files.length === 0) return { kind: 'failed', why: (reset.ok ? picked : reset).out }

  return { kind: 'conflicts', files }
}

/**
 * Why a quest's branch may not leave the machine: what it adds over the branch it is pushed onto (`onto`'s on origin
 * where it is fetched, else the local base; a review's own branch on origin, which it cannot do without) holds what
 * looks like a secret, or could not be read. Nothing when it may.
 */
export const leakOf = async (shell: Shell, quest: { kind: string; branch: string; base: string }): Promise<string | undefined> => {
  const onto = `origin/${quest.kind === 'review' ? quest.branch : quest.base}`
  const isFetched = (await git(shell, ['rev-parse', '--verify', '--quiet', `refs/remotes/${onto}`])).ok
  const from = isFetched ? onto : quest.kind === 'review' ? '' : quest.base

  if (from === '') return `${onto} is not known here, so what ${quest.branch} adds cannot be read for secrets: fetch it, then push again.`

  const added = await git(shell, ['diff', '--no-color', '--no-ext-diff', `${from}...HEAD`])

  if (!added.ok) return `What ${quest.branch} adds over ${from} could not be read for secrets: ${added.out}`

  const leaked = secretsIn(added.out)

  return leaked.length === 0 ? undefined : `${quest.branch} adds what looks like a secret (${leaked.join('; ')}), so it does not leave the machine: take it out of the branch's history, then push again.`
}
