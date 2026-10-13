/** A command-line tool the session watches, as the project's `.claude/anduril` names it. */
export type AndurilTarget = {
  /** The name it is run by, and the name of its launcher. */
  label: string
  /** The built binary a run of it runs, absolute. */
  binary: string
  /** The source folders whose edits are edits of it, absolute; none when the file names none. */
  roots: string[]
}

/** One run of a watched tool, as the shim wrote it once the tool had exited. */
export type AndurilRun = {
  /** When it started and the process that recorded it: unique, and in order of start as text. */
  id: string
  label: string
  /** The tool's own arguments, without its name. */
  argv: string[]
  cwd: string
  /** Who ran it: Claude through its shell, or a person in a terminal of their own. */
  by: 'claude' | 'person'
  /** Milliseconds since the epoch. */
  startedAt: number
  /** The tool's own time, from its start to its exit: the shim's is not in it. */
  durationMs: number
  /** What it exited with; 128 and the signal's number when a signal ended it. */
  exitCode: number
  /** The signal that ended it (`SIGKILL`), empty when it exited by itself. */
  signal: string
  /** Processor time in its own code, and in the kernel on its behalf. */
  userMs: number
  sysMs: number
  /** The most memory it held, in kilobytes. */
  maxRssKb: number
  isStdinTty: boolean
  isStdoutTty: boolean
  isStderrTty: boolean
  /** How wide the terminal was, 0 when neither stream was one. */
  columns: number
  /** The variables that change how a tool draws (`NO_COLOR`, `TERM`), those that were set. */
  env: Record<string, string>
  binary: string
  /** When the binary that ran was last written, milliseconds since the epoch: which build this was. */
  builtAt: number
  /** The head of what it wrote to each stream; `stdoutBytes` and `stderrBytes` are the whole of it. */
  stdout: string
  stderr: string
  stdoutBytes: number
  stderrBytes: number
}

declare module 'claude-code' {
  interface PluginState {
    anduril: {
      targets: AndurilTarget[]
      /** The last runs, oldest first, each stream cut to what the pane draws. */
      runs: AndurilRun[]
      /** The id of the run the pane shows in full; empty for none. */
      selected: string
      /** Whether the pane lists only the runs that did not exit with 0. */
      isFailedOnly: boolean
      /** What stands in the way of recording, for the pane to say; empty when nothing does. */
      note: string
      /** The folder the session started in, absolute: where the project's file and the records are. */
      home: string
    }
  }
}
