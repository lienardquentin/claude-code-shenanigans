import type { Shell } from './forge'

// A proof for a project that names no target in .claude/theseus.toml: the commands its plan or its issue states for checking
// the change, run in the run's worktree. Its radius and pinning are an upgrade the project opts into by naming targets.

/**
 * The commands of one `## <name>` section of an issue's body, one a line, in order. A fenced block's fences are
 * dropped, as are list markers, a command's backticks and blank lines.
 */
const commandsOf = (body: string, name: string): string[] => {
  const section = new RegExp(`^##\\s+${name}\\s*$([\\s\\S]*?)(?=^##\\s|(?![\\s\\S]))`, 'mi').exec(body)?.[1] ?? ''

  return section
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '' && !line.startsWith('```'))
    .map(line => line.replace(/^[-*]\s+/, '').replace(/^`(.*)`$/, '$1'))
}

/** What checks the change, as an issue's `## Verification` section states it. */
export const verificationOf = (body: string): string[] => commandsOf(body, 'Verification')

/** What a fresh worktree needs before it is built in (installed dependencies, generated files), as `## Setup` states it. */
export const setupOf = (body: string): string[] => commandsOf(body, 'Setup')

// How long one command is given, and how much of what it wrote is kept to show
// The longest the engine lets a command run: a longer timeout is refused before the command starts
export const COMMAND_TIMEOUT_MS = 10 * 60 * 1000
const KEPT_OUTPUT = 4_000

/** What came of running commands in a folder, one after the other: each ran, or the first that failed, with what it wrote. */
export type CommandsRan = { ok: true; ran: number } | { ok: false; command: string; exitCode: number; output: string }

export const runCommands = async (shell: Shell, commands: readonly string[]): Promise<CommandsRan> => {
  for (const command of commands) {
    const done = await shell.run(['sh', '-c', command], { timeoutMs: COMMAND_TIMEOUT_MS })

    if (done.exitCode !== 0) {
      const output = `${done.stdout}\n${done.stderr}`.trim()

      return { ok: false, command, exitCode: done.exitCode, output: output.length > KEPT_OUTPUT ? `…${output.slice(-KEPT_OUTPUT)}` : output }
    }
  }

  return { ok: true, ran: commands.length }
}

/**
 * The proof the commands make, as the build reads any proof: settled when every one passed; what failed, for the
 * builder; or unlooked where a command could not be started at all (exit -1), which says nothing of the change and no
 * builder can mend: the run stops for the person.
 */
export const checksVerdict = (ran: CommandsRan, commands: readonly string[]): { verdict: 'settled' | 'unsettled' | 'unlooked'; line: string; text: string } =>
  ran.ok
    ? { verdict: 'settled', line: `the ${commands.length} verification ${commands.length === 1 ? 'command passes' : 'commands pass'}`, text: `Every verification command passed:\n${commands.map(one => `- ${one}`).join('\n')}` }
    : ran.exitCode === -1
      ? { verdict: 'unlooked', line: `\`${ran.command}\` could not be started: ${ran.output.split('\n')[0] ?? ''}`, text: `The verification command \`${ran.command}\` could not be started, so nothing was proved of the change. ${ran.output}` }
      : { verdict: 'unsettled', line: `\`${ran.command}\` fails (exit ${ran.exitCode})`, text: `The verification command \`${ran.command}\` failed (exit ${ran.exitCode}). What it wrote:\n\n${ran.output}` }
