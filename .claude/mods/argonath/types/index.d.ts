/** What a target is, which says the handler that finds what changed in what it does. */
export type ArgonathKind = 'cli' | 'service' | 'frontend'

/** One thing the project builds, as `.claude/argonath` names it. */
export type ArgonathTarget = {
  /** Its name: for a CLI, the one anduril watches it under. */
  label: string
  kind: ArgonathKind
  /** The source folders whose edits are edits of it, absolute. */
  roots: string[]
  /** The files and folders that hold its integration tests, absolute; none when the project names none. */
  tests: string[]
  /** The command that runs them from the project's folder, naming each test as it ends; empty when none is named. */
  test: string
  /** A service's app as Python imports it, `gondor.app:app`; empty for any other kind. */
  app: string
  /** A service's Python folder from the project's folder: put on the path, and its uv project when it has one. */
  python: string
  /** The environment a service is played in, the same on both builds. */
  env: Record<string, string>
  /** Regular expressions, as Python reads them: what each matches in an answer is left out of a comparison. */
  masks: string[]
  /** A service's kept requests, each as `label METHOD /path [json]`, played in order. */
  requests: string[]
  /** Where a service is deployed, to play its requests on both builds against its real dependencies; none when not said. */
  live: ArgonathLive | null
}

/** A service's live stage: its deployed workload, what to forward to it, and how to leave its database as it was. */
export type ArgonathLive = {
  /** The workload, `context/namespace/kind/name`: its environment is the one played with. A context naming prod is refused. */
  workload: string
  /** The services reached through a port-forward, `service:port`; the workload's variables are pointed at the forwarded ones. */
  forward: string[]
  /** What is laid over the workload's variables. */
  env: Record<string, string>
  /** The database's workload in the same namespace, `deployment/postgres`, whose psql runs the statements below; empty for none. */
  db: string
  /** What is read before a build plays, for `restore` to put back: its rows fill `{rows}`. */
  before: string
  /** Run after each build, `{rid}` the run's own request id: what the run wrote, taken out. */
  cleanup: string[]
  /** Run after each build: what `before` read, put back. */
  restore: string
  /**
   * The variable that holds the database's address, `DATABASE_URL`: each build then plays against a copy of the
   * database of its own, made in `db`'s pod and dropped after, its schema migrated by that build alone. The shared
   * database is only read; `before`, `cleanup` and `restore` are not run. Empty to play against the shared one.
   */
  scratch: string
}

/** How a test ended on one side of a proof; `none` when that side did not run it. */
export type ArgonathOutcome = 'pass' | 'fail' | 'none'

/** One test a changed run is marked on, and how it ended on each side once proved. */
export type ArgonathTest = {
  name: string
  /** On the source of the commit compared against, with the working tree's tests. */
  from: ArgonathOutcome
  /** On the working tree. */
  to: ArgonathOutcome
}

/**
 * Where a changed run stands: `bare` with no test marked on it, `marked` with one not proved yet, `pinned` when a
 * test of its own fails on the commit and passes on the working tree, `loose` when its tests pass on both, `broken`
 * when one fails on the working tree.
 */
export type ArgonathState = 'bare' | 'marked' | 'pinned' | 'loose' | 'broken'

/** One kept run or request whose answer changed: a part of the radius. */
export type ArgonathSeam = {
  /** The run or the request as the project keeps it. */
  line: string
  /** How it changed: its ending or status, and a diff of what it wrote or answered. */
  evidence: string
  tests: ArgonathTest[]
  state: ArgonathState
}

/** What a change reached in one target, by the kept runs or requests that changed, and what of it a test pins. */
export type ArgonathRadius = {
  label: string
  kind: ArgonathKind
  /** When it was made, milliseconds since the epoch. */
  at: number
  /** The two builds compared and how many of the kept ones changed, in a line. */
  summary: string
  seams: ArgonathSeam[]
  /** The kept runs or requests that did not change: outside the radius, and owed no test. */
  unchanged: string[]
  /** Whether the tests were run on both sides since the radius was made. */
  isProved: boolean
  /** Why a proof asked for was not made, or made on one side alone; empty otherwise. */
  unproved: string
  /** The tests that pass on the commit's source and fail on the working tree, marked or not. */
  turned: string[]
  /** Whether a file of the target was edited since: the radius is of an earlier working tree. */
  isStale: boolean
  /** What the live stage found or why it did not run, in a line; empty for a target with none. */
  live: string
}

/** One of the two statues of the Argonath, which judge a settled change. */
export type ArgonathStatue = 'isildur' | 'anarion'

/** Something a statue found in the change: `blocking` keeps it from being committed, `minor` does not. */
export type ArgonathFinding = { severity: 'blocking' | 'minor'; where: string; text: string }

/** One statue sitting in judgement: the reviews it carries and what it found. */
export type ArgonathSeat = {
  statue: ArgonathStatue
  title: string
  /** The reviews it carries, as slash commands. */
  reviews: string[]
  /** The id its spawn answered; empty where it answered none, and the statue is known by its type. */
  agentId: string
  /** `sitting` while it judges; `pass` with no blocking finding, `fail` with one; `silent` when it gave no findings that read. */
  state: 'sitting' | 'pass' | 'fail' | 'silent'
  findings: ArgonathFinding[]
  /** Why it is silent; empty otherwise. */
  why: string
}

/** The statues together: sitting, or what they found. */
export type ArgonathVerdict = 'sitting' | 'pass' | 'fail' | 'silent'

/** The judgement of one settled change. */
export type ArgonathJudgement = {
  /** The change judged: HEAD, the diff against it and the new files, as one fingerprint. */
  fingerprint: string
  at: number
  /** Who convened it: the end of the session's turn, whose Claude is told the verdict, or a mod through the tool. */
  by: 'turn' | 'tool'
  seats: ArgonathSeat[]
}

declare module 'claude-code' {
  interface PluginState {
    argonath: {
      targets: ArgonathTarget[]
      /** The last radius of each target that has one, in the order the project names them. */
      radii: ArgonathRadius[]
      /** The targets whose folders were edited and not yet looked at again, by label. */
      touched: string[]
      /** What is being done now, for the pane to say; empty when nothing is. */
      working: string
      /** What stood in the way of the last look, a sentence a target; empty when nothing did. */
      note: string
      /** The changed run the pane shows the evidence of, `label line`; empty for none. */
      selected: string
      /** Whether the band above the prompt is hidden until the next radius. */
      isHidden: boolean
      /** The beat of the band's glow, which swells and fades while the band is lit. */
      glow: number
      /** The folder the session started in, absolute: where the project's file and the checkouts are. */
      home: string
      /** The fingerprint of the change last handed to the reviews: the same change is not reviewed twice. */
      reviewed: string
      /** The statues' judgement of the last settled change; null before any. */
      judgement: ArgonathJudgement | null
    }
  }
}
