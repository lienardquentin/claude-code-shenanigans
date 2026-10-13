/** The integration tests of a command-line tool, as the project's `.claude/sting` names them. */
export type StingSuite = {
  /** The tool, by the name it is run by: the one anduril watches it under. */
  label: string
  /** The files and folders that hold its integration tests, absolute. */
  tests: string[]
  /** The command that runs them, from the project's folder or from a checkout of it, naming each test as it ends. */
  test: string
}

/** How a test ended on one side of a proof; `none` when that side did not run it. */
export type StingOutcome = 'pass' | 'fail' | 'none'

/** One test a changed run is marked on, and how it ended on each side once proved. */
export type StingTest = {
  name: string
  /** On the source of the commit compared against, with the working tree's tests. */
  from: StingOutcome
  /** On the working tree. */
  to: StingOutcome
}

/**
 * Where a changed run stands: `bare` with no test marked on it, `marked` with one not proved yet, `pinned` when a
 * test of its own fails on the commit and passes on the working tree, `loose` when its tests pass on both and so do
 * not see the change, `broken` when one fails on the working tree.
 */
export type StingState = 'bare' | 'marked' | 'pinned' | 'loose' | 'broken'

/** One kept run whose behaviour changed: a part of the radius. */
export type StingSeam = {
  /** The run as the project keeps it. */
  line: string
  /** How it changed, as anduril says it: its ending and a diff of each stream. */
  evidence: string
  tests: StingTest[]
  state: StingState
}

/** What a change reached, by the kept runs that changed, and what of it a test pins. */
export type StingRadius = {
  label: string
  /** When it was made, milliseconds since the epoch. */
  at: number
  /** The two builds compared and how many kept runs changed, as anduril says it in a line. */
  summary: string
  seams: StingSeam[]
  /** The kept runs that did not change: outside the radius, and owed no test. */
  unchanged: string[]
  /** Whether the tests were run on both sides since the radius was made. */
  isProved: boolean
  /** Why a proof asked for was not made, or was made on one side alone; empty otherwise. */
  unproved: string
  /** The tests that pass on the commit's source and fail on the working tree, marked or not. */
  turned: string[]
  /** Whether a file was edited since: the radius is of an earlier working tree. */
  isStale: boolean
}

declare module 'claude-code' {
  interface PluginState {
    sting: {
      suites: StingSuite[]
      /** The last radius made, or none yet. */
      radius: StingRadius | null
      /** What is being done now, for the pane to say; empty when nothing is. */
      working: string
      /** What stood in the way of the last radius or proof; empty when nothing did. */
      note: string
      /** The changed run the pane shows the evidence of; empty for none. */
      selected: string
      /** The beat of the band's glow, which swells and fades while the band is lit. */
      glow: number
      /** Whether the band above the prompt is hidden until the next radius. */
      isHidden: boolean
      /** The folder the session started in, absolute: where the project's file and the checkouts are. */
      home: string
    }
  }
}
