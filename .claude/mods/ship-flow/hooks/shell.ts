// What of git the implementer may run: reading the repo, and moving, removing and staging files. The run itself
// commits, discards and pushes; the implementer never does.
const GIT = ['status', 'diff', 'log', 'show', 'blame', 'ls-files', 'grep', 'rev-parse', 'mv', 'rm', 'add']

/** What of git the reviewer may run: reading the repo, and nothing that changes it. */
export const READING_GIT = ['status', 'diff', 'log', 'show', 'blame', 'ls-files', 'grep', 'rev-parse']

// Anything that would let one allowed command carry another: chaining, pipes, substitution, redirection
const JOINS = /[;&|`<>\n]|\$\(/

/**
 * Whether an agent of the run may run this shell command: one git command from its list (the implementer's,
 * unless another is given), or one of the spec's verification commands exactly as written. Everything else is
 * refused, never asked about.
 */
export const isAllowedShell = (
  command: string,
  verification: readonly string[],
  gitCommands: readonly string[] = GIT,
): boolean => {
  const line = command.trim()

  if (verification.includes(line)) return true
  if (JOINS.test(line)) return false

  const [program, subcommand] = line.split(/\s+/)

  return program === 'git' && gitCommands.includes(subcommand ?? '')
}

/** Whether a working directory is spelled the way Windows spells one. */
export const isWindowsPath = (cwd: string): boolean => /^[A-Za-z]:[\\/]/.test(cwd)

/**
 * A command line as the arguments a process is started with. The host starts processes without a shell, and a
 * verification command is a shell line (it may name a script, or a program the shell finds), so it is handed to one.
 */
export const shellArgv = (line: string, isWindows: boolean): string[] =>
  isWindows ? ['cmd', '/d', '/s', '/c', line] : ['sh', '-c', line]
