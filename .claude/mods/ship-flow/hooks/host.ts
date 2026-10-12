/**
 * What a run needs from the engine, as plain functions. The engine's `$` cannot leave the hooks module (it is
 * followed only inside the file that receives it), so `register.ts` builds one of these over it and every other
 * module of the mod is written against this.
 */
export type Host = {
  exists: (path: string) => Promise<boolean>
  read: (path: string) => Promise<string>
  write: (path: string, text: string) => Promise<void>
  /** The entries of a directory: each one's name, and whether it is a directory. */
  list: (path: string) => Promise<readonly { name: string; isDir: boolean }[]>
  /**
   * Runs a command by its arguments, with no shell, in `cwd` or else where the session is; `stdin` is written to
   * it. A command that cannot start rejects.
   */
  run: (
    argv: readonly string[],
    init?: { timeoutMs?: number; stdin?: string; cwd?: string },
  ) => Promise<{ exitCode: number; stdout: string; stderr: string }>
  /** Starts a subagent, in `cwd` or else where the session is; resolves once it started, with its id, or with why it did not. */
  spawn: (agent: {
    subagentType: string
    description: string
    model: string
    prompt: string
    cwd?: string
  }) => Promise<{ agentId?: string; model?: string; deny?: string }>
  /** The session's agents, oldest first: each one's id, its type, and whether its loop is running now. */
  agents: () => Promise<readonly { id: string; type: string; isRunning: boolean }[]>
  /** The main window's fill and each quota window, as the session last read them. */
  usage: () => Promise<{
    contextPercent?: number
    quota: readonly { kind: string; percentUsed: number; resetsAt?: string }[]
  }>
  now: () => Promise<number>
  cwd: () => Promise<string>
  /** The repo's root, absolute: what the run's own paths are under, its worktrees among them. */
  repo: () => Promise<string>
  /** The mod's own folder, absolute: where the texts it points the model at are. */
  root: string
  /** Hands the model a prompt as a turn of its own, once the session is idle. */
  prompt: (text: string) => void
  /** Compacts the main conversation, keeping what the instructions say; between turns, without being waited for. */
  compact: (instructions: string) => void
  /** Says that a run wrote a ticket's state or its record: whatever shows the runs draws them again. */
  changed: () => void
  /** One dim line in the transcript, which the model does not read. */
  log: (text: string) => void
  /** A notification on the person's desktop, by their own channel; nothing where they turned those off. */
  notify: (text: string) => void
  /** Calls `fn` once, `ms` milliseconds from now, for as long as the session and the module live. */
  after: (ms: number, fn: () => void) => void
}
