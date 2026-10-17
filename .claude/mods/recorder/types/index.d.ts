/** A command-line tool the session watches, as the project's `.claude/recorder` names it. */
export type WatchedTool = {
  /** The name it is run by, and the name of its launcher. */
  label: string
  /** The built binary a run of it runs, absolute. */
  binary: string
  /** The source folders whose edits are edits of it, absolute; none when the file names none. */
  roots: string[]
  /** The command that builds it, run from the project's folder or from a checkout of it; empty when none is named. */
  build: string
  /** Regular expressions, as Python reads them: what each matches in a stream is left out of a comparison. */
  masks: string[]
}

/** One of the two builds a comparison plays the kept runs on. */
export type BuildSide = {
  /** `work` for the working tree, else the commit as it was named (`HEAD`, a tag, a branch). */
  ref: string
  /** The commit it names, whole; empty for the working tree. */
  sha: string
  /** Why it could not be played (no such commit, a build that fails); empty when it was. */
  error: string
}

/** How one kept run ended on one build. */
export type RunOutcome = {
  exitCode: number
  signal: string
  durationMs: number
  stdoutBytes: number
  stderrBytes: number
  /** Why it was not run to its end (no run of the tool, ended for taking too long); empty when it was. */
  error: string
}

/** One kept run played on both builds. */
export type RunCase = {
  /** The run as the project's file keeps it. */
  line: string
  isChanged: boolean
  from: RunOutcome
  to: RunOutcome
  /** What differs in each stream as a unified diff, the masks applied; empty where nothing does. */
  stdoutDiff: string
  stderrDiff: string
  /**
   * The files this run changed that are not the same on both builds once it was played, by their path in the place
   * the runs are played in (`root/…` the copy of the source folder, `home/…`, `tmp/…`). `added` is a file the second
   * build alone left. `diff` is a text file's lines, the masks applied, or a sentence for one that is no text.
   */
  files: { path: string; change: 'added' | 'removed' | 'changed'; diff: string }[]
  /** The files each build wrote outside the place it was played in, whole paths: they are on the machine. */
  outside: { from: string[]; to: string[] }
  /** The files each build wrote and removed again before the run ended. */
  transient: { from: string[]; to: string[] }
}

/** The kept runs of a tool played on two builds, and what differs. */
export type RunsDiff = {
  label: string
  /** When it was made, milliseconds since the epoch. */
  at: number
  from: BuildSide
  to: BuildSide
  /** Why nothing was played (no run kept, a mask that does not read); empty otherwise. */
  error: string
  /**
   * Why no run was traced (no strace on the machine); empty when each was. Untraced, what a run writes outside the
   * place it is played in, or writes and removes again, is not seen.
   */
  untraced: string
  cases: RunCase[]
}

/** One run of a watched tool, as the shim wrote it once the tool had exited. */
export type RecordedRun = {
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
  /**
   * What it wrote to each stream: all of it, or past 256 kB its start and its end with a line between saying what
   * was dropped. `stdoutBytes` and `stderrBytes` count the whole.
   */
  stdout: string
  stderr: string
  stdoutBytes: number
  stderrBytes: number
}

declare module 'claude-code' {
  interface PluginState {
    recorder: {
      targets: WatchedTool[]
      /** The last runs, oldest first, each stream cut to what the pane draws. */
      runs: RecordedRun[]
      /** The id of the run the pane shows in full; empty for none. */
      selected: string
      /** Whether the pane lists only the runs that did not exit with 0. */
      isFailedOnly: boolean
      /** What stands in the way of recording, for the pane to say; empty when nothing does. */
      note: string
      /** The folder the session started in, absolute: where the project's file and the records are. */
      home: string
      /** The runs the project keeps to play again, each as it is typed, in the order of its file. */
      corpus: string[]
      /** The last comparison made, or none yet. */
      diff: RunsDiff | null
      /** The tool a comparison is being made for now; empty when none is. */
      diffing: string
      /** The commit the pane compares the working tree with. */
      against: string
      /** The folder each agent a mod sent works in, by its id: a quest's worktree, whose own build its runs launch. */
      trees: Record<string, string>
    }
  }
}
