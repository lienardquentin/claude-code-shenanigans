import type { Host } from './host'
import { specOf } from './run'
import type { Failure, Flight, UsageReading } from './run'
import { isWindowsPath, shellArgv } from './shell'
import { setupOf, verificationOf } from './spec'

// A verification command may run as long as the host lets a process run
const VERIFY_TIMEOUT_MS = 10 * 60 * 1000

// How much of a failing command's output is kept for the next attempt and for the person
const OUTPUT_KEPT = 4000

/** The end of a long output: what a failure usually says last. */
export const tail = (text: string): string => (text.length > OUTPUT_KEPT ? `…${text.slice(-OUTPUT_KEPT)}` : text)

export const git = (host: Host, ...args: string[]) => host.run(['git', ...args])

/** Git in a ticket's worktree, given absolute. */
export const gitIn = (host: Host, tree: string, ...args: string[]) => host.run(['git', ...args], { cwd: tree })

/** A flight's worktree, absolute. */
export const treeAt = async (host: Host, flight: Pick<Flight, 'tree'>): Promise<string> => `${await host.repo()}/${flight.tree}`

/**
 * Makes a ticket's worktree, on a branch of its own cut from the run's branch as it is now. What an earlier attempt
 * left there, and its branch, are replaced. Answers why it could not, or undefined.
 */
export const plant = async (host: Host, flight: Pick<Flight, 'tree' | 'branch'>, from: string): Promise<string | undefined> => {
  const tree = await treeAt(host, flight)

  await git(host, 'worktree', 'remove', '--force', tree)
  await git(host, 'worktree', 'prune')

  const added = await git(host, 'worktree', 'add', '-B', flight.branch, tree, from)

  return added.exitCode === 0 ? undefined : `its worktree could not be made: ${tail(added.stderr || added.stdout).trim()}`
}

/** Removes a ticket's worktree and its branch, with whatever is in them: landed, the work is on the run's branch. */
export const unplant = async (host: Host, flight: Pick<Flight, 'tree' | 'branch'>): Promise<void> => {
  await git(host, 'worktree', 'remove', '--force', await treeAt(host, flight))
  await git(host, 'worktree', 'prune')
  await git(host, 'branch', '-D', flight.branch)
}

/** Whether a flight's worktree is there: what an attempt left in it can then be taken up by the next. */
export const isPlanted = (host: Host, flight: Pick<Flight, 'tree'>): Promise<boolean> => host.exists(`${flight.tree}/.git`)

/** The files the last commit of a worktree changed, as git names them from the repo's root. */
export const changedIn = async (host: Host, tree: string): Promise<string[]> => {
  const listed = await gitIn(host, tree, 'diff', '--name-only', 'HEAD~1', 'HEAD')

  return listed.exitCode === 0 ? listed.stdout.split(/\r?\n/).filter(file => file !== '') : []
}

/**
 * Puts the commits of a worktree's branch on the run's branch, when that branch still ends where they began: the
 * branch takes them as they are. Answers nothing when it did, why it could not, or `moved` when the run's branch
 * has gone on since.
 */
export const land = async (host: Host, branch: string, from: string): Promise<undefined | Failure | 'moved'> => {
  if ((await git(host, 'merge-base', '--is-ancestor', branch, from)).exitCode !== 0) return 'moved'

  // The person may have left the run's branch for another: it is moved all the same, where it is not checked out
  const isCheckedOut = (await git(host, 'rev-parse', '--abbrev-ref', 'HEAD')).stdout.trim() === branch
  const moved = isCheckedOut ? await git(host, 'merge', '--ff-only', from) : await git(host, 'fetch', '.', `${from}:${branch}`)

  return moved.exitCode === 0
    ? undefined
    : { reason: `its commit could not be put on ${branch}`, output: tail(moved.stderr || moved.stdout), isLanding: true }
}

/** The session's own figures now, stamped with the time they were read. */
export const readUsage = async (host: Host): Promise<UsageReading> => ({ at: await host.now(), ...(await host.usage()) })

// Runs shell lines in order, in `cwd` or else where the session is; the first that fails is the failure
const runAll = async (
  host: Host,
  commands: readonly string[],
  cwd: string | undefined,
): Promise<{ reason: string; output: string } | undefined> => {
  const isWindows = isWindowsPath(await host.cwd())

  for (const command of commands) {
    const ran = await host
      .run(shellArgv(command, isWindows), { timeoutMs: VERIFY_TIMEOUT_MS, ...(cwd !== undefined ? { cwd } : {}) })
      .catch((error: unknown) => ({ exitCode: 1, stdout: '', stderr: error instanceof Error ? error.message : String(error) }))

    if (ran.exitCode !== 0) {
      return { reason: `\`${command}\` failed`, output: tail([ran.stdout, ran.stderr].filter(Boolean).join('\n')) }
    }
  }

  return undefined
}

/**
 * Runs the spec's verification commands in order, in a ticket's worktree when one is given; the first that fails
 * is the failure, undefined when none does.
 */
export const verify = async (host: Host, feature: string, tree?: string) =>
  runAll(host, verificationOf(await host.read(specOf(feature))), tree)

/** Runs the spec's setup commands, if it has any, in a ticket's fresh worktree; the first that fails is the failure. */
export const setUp = async (host: Host, feature: string, tree: string) => runAll(host, setupOf(await host.read(specOf(feature))), tree)

/**
 * Starts a subagent of one of the mod's types and answers its id, or why it has none. Where the spawn's answer
 * carries no id, the newest running agent of that type is the one just started.
 */
export const launch = async (
  host: Host,
  agent: { subagentType: string; description: string; model: string; prompt: string; cwd?: string },
): Promise<{ agentId: string; model: string } | { why: string }> => {
  const spawned = await host.spawn(agent)
  const agentId =
    spawned.agentId ??
    (spawned.deny === undefined
      ? (await host.agents()).filter(other => other.type === agent.subagentType && other.isRunning).at(-1)?.id
      : undefined)

  return agentId === undefined
    ? { why: spawned.deny ?? 'it was given no id' }
    : { agentId, model: spawned.model ?? agent.model }
}
