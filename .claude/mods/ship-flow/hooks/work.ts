import type { Host } from './host'
import { specOf } from './run'
import type { UsageReading } from './run'
import { isWindowsPath, shellArgv } from './shell'
import { verificationOf } from './spec'

// A verification command may run as long as the host lets a process run
const VERIFY_TIMEOUT_MS = 10 * 60 * 1000

// How much of a failing command's output is kept for the next attempt and for the person
const OUTPUT_KEPT = 4000

/** The end of a long output: what a failure usually says last. */
export const tail = (text: string): string => (text.length > OUTPUT_KEPT ? `…${text.slice(-OUTPUT_KEPT)}` : text)

export const git = (host: Host, ...args: string[]) => host.run(['git', ...args])

/** Leaves the working tree as the last commit has it: what an agent changed and what it created. */
export const discard = async (host: Host) => {
  await git(host, 'reset', '--hard', 'HEAD')
  await git(host, 'clean', '-fd')
}

/** The session's own figures now, stamped with the time they were read. */
export const readUsage = async (host: Host): Promise<UsageReading> => ({ at: await host.now(), ...(await host.usage()) })

/** Runs the spec's verification commands in order; the first that fails is the failure, undefined when none does. */
export const verify = async (host: Host, feature: string): Promise<{ reason: string; output: string } | undefined> => {
  const isWindows = isWindowsPath(await host.cwd())

  for (const command of verificationOf(await host.read(specOf(feature)))) {
    const ran = await host
      .run(shellArgv(command, isWindows), { timeoutMs: VERIFY_TIMEOUT_MS })
      .catch((error: unknown) => ({ exitCode: 1, stdout: '', stderr: error instanceof Error ? error.message : String(error) }))

    if (ran.exitCode !== 0) {
      return { reason: `\`${command}\` failed`, output: tail([ran.stdout, ran.stderr].filter(Boolean).join('\n')) }
    }
  }

  return undefined
}

/**
 * Starts a subagent of one of the mod's types and answers its id, or why it has none. Where the spawn's answer
 * carries no id, the newest running agent of that type is the one just started.
 */
export const launch = async (
  host: Host,
  agent: { subagentType: string; description: string; model: string; prompt: string },
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
