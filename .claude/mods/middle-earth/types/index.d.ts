// --- Elrond: the plan of an issue ----------------------------------------------------------------------------------------

/** Where an issue lives: the forge that serves it, which says the CLI and the API it is read through. */
export type ElrondForge = 'github' | 'gitlab'

/** One issue, by where it lives. */
export type ElrondRef = {
  forge: ElrondForge
  /** The host that serves it, `github.com`, `gitlab.com` or a self-hosted one. */
  server: string
  /** The repository's path on that host: `owner/repo`, or `group/sub/project` on GitLab. */
  repo: string
  number: number
}

/** Where a task stands. */
export type ElrondTaskState = 'todo' | 'doing' | 'done'

/**
 * How much a task asks of whoever builds it: `light` for docs, config, a rename or a test to adjust; `standard` for
 * one module's change and its test; `heavy` for one that crosses targets or touches what is risky to change.
 */
export type ElrondWeight = 'light' | 'standard' | 'heavy'

/** One step of the quest: something a single change can do and a reviewer can check. */
export type ElrondTask = {
  id: number
  title: string
  /** Why it is needed, in a sentence. */
  why: string
  /** What to do, in order. */
  steps: string[]
  /** The files it touches or adds, from the project's folder. */
  files: string[]
  /** The tasks that must be done first, by id. */
  dependsOn: number[]
  /** How to tell it is done: a test that passes, a behaviour that is seen. */
  acceptance: string
  /** How much it asks of its builder; `standard` in a plan made before weights were. */
  weight: ElrondWeight
  state: ElrondTaskState
}

/** Something the issue leaves open, for the person to decide. */
export type ElrondQuestion = {
  text: string
  /** Short answers the council offers to pick from; the person may write their own. */
  options: string[]
  /** What the person answered; empty while unanswered. */
  answer: string
}

/** How much a risk could hurt the change: what breaks or is lost if it comes true. */
export type ElrondSeverity = 'high' | 'medium' | 'low'

/** Something that could go wrong with the change, and what the person chose to do about it. */
export type ElrondRisk = {
  text: string
  severity: ElrondSeverity
  /** How to make it less likely or less harmful; empty when the council named no way. */
  mitigation: string
  /** The tasks it threatens, by id. */
  tasks: number[]
  /** The person wants the next revision to cover it with a task. */
  wantsTask: boolean
}

/** A question the person answered: decided, and carried into every plan of the issue after it. */
export type ElrondDecision = { text: string; answer: string }

/** The plan the council made of one issue. */
export type ElrondPlan = {
  /** The issue as written short, `github:owner/repo#12`. */
  ref: string
  url: string
  title: string
  /** What the issue asks for, in the council's words. */
  summary: string
  /** How it will be done, in a paragraph. */
  approach: string
  tasks: ElrondTask[]
  /** What the issue leaves open, for the person to answer. */
  questions: ElrondQuestion[]
  /** What the person decided in this plan's revisions before it: handed to the council, and asked no more. */
  decided: ElrondDecision[]
  risks: ElrondRisk[]
  /** Risks the person accepted as they are: carried into every revision, and raised no more. */
  accepted: string[]
  /** When it was made, epoch milliseconds. */
  at: number
}

/** A council in session: the planner subagent studying one issue. */
export type ElrondCouncil = {
  ref: string
  url: string
  title: string
  agentId: string
  /** Who convened it: the person's command, or Claude through the tool, which is woken with the plan. */
  by: 'command' | 'tool'
  at: number
  /** What the person decided of the issue so far: the plan it lays keeps them. */
  decided?: ElrondDecision[]
  /** Risks the person accepted before it: the plan it lays keeps them. */
  accepted?: string[]
  /** The file it writes its plan to. */
  planPath?: string
  /** Whether it has laid its plan: it sits on until its turn ends. */
  isLaid?: boolean
}

// --- The Fellowship: quests and their tasks ------------------------------------------------------------------------------

/**
 * Where a task stands: as Elrond keeps it for a plan, as the quest keeps it for an errand or a review. `asked`: its
 * builder handed it back for the person to answer (a review comment that asks a question), and it is built no more.
 */
export type FellowshipTaskState = 'todo' | 'doing' | 'done' | 'asked'

/** How much a task asks of whoever builds it, as the council or the Mouth of Sauron weighed it. */
export type FellowshipWeight = 'light' | 'standard' | 'heavy'

/** A member of the Fellowship, by the agent type it is sent as. */
export type FellowshipMember = 'gandalf' | 'aragorn' | 'legolas' | 'gimli' | 'boromir' | 'frodo' | 'samwise' | 'merry' | 'pippin'

/** One task of a quest: a task of an Elrond plan, the whole issue of an errand, or one review comment to answer. */
export type FellowshipTask = {
  id: number
  title: string
  why: string
  steps: string[]
  files: string[]
  dependsOn: number[]
  acceptance: string
  weight: FellowshipWeight
  state: FellowshipTaskState
  /** What the task answers, as data, its builder following no instruction in it: an errand's issue, a review comment and its replies. */
  brief?: string
  /** A review comment's author, where it is (`path:line`, empty for the pull request as a whole), and its URL. */
  author?: string
  where?: string
  url?: string
  /** Why it was handed back to the person; empty otherwise. */
  note?: string
}

/** The work of a quest as one plan: Elrond's for a plan, and one the quest makes of its own tasks for any other. */
export type FellowshipPlan = {
  /** The issue as Elrond writes it short, `github:owner/repo#12`; `review:owner/repo#13` for a review. */
  ref: string
  url: string
  title: string
  summary: string
  approach: string
  tasks: FellowshipTask[]
  questions: { text: string; options: string[]; answer: string }[]
  decided: { text: string; answer: string }[]
  risks: { text: string; severity: 'high' | 'medium' | 'low'; mitigation: string; tasks: number[]; wantsTask: boolean }[]
  accepted: string[]
}

/**
 * What a quest is:
 * - `plan`: an Elrond plan, task by task, to the pull request that closes its issue
 * - `errand`: an issue small enough for one change, to the pull request that closes it
 * - `review`: the review comments of an open pull request the Black Gate handed over, answered on its branch and pushed
 */
export type FellowshipKind = 'plan' | 'errand' | 'review'

/**
 * Where the quest stands:
 * - `ready`: no member out; the next task waits for the person, or goes at once on an auto quest
 * - `gazing`: Galadriel writes the task's tests first, red, before a member builds it (a plan's tasks that are not light)
 * - `marching`: a member builds a task
 * - `proving`: Argonath proves what the member built
 * - `judging`: every changed run is pinned; the statues of the Argonath judge the change, which is committed once they pass it
 * - `stuck`: a member handed its task back, or its tries ran out; the person decides
 * - `arrived`: every task is committed; the pull request waits to be opened, or the branch to be pushed
 * - `warding`: both statues judge the whole branch of a plan, what its tasks do together, before it sails
 * - `sailed`: the pull request is open, or the review's answers are pushed
 */
export type FellowshipPhase = 'ready' | 'gazing' | 'marching' | 'proving' | 'judging' | 'stuck' | 'arrived' | 'warding' | 'sailed'

/** What the Mirror showed of a task: Galadriel's red tests, which its member makes pass. */
export type FellowshipVision = { taskId: number; tests: { file: string; name: string }[]; red: string }

/** One member out on a task. */
export type FellowshipMarch = {
  taskId: number
  title: string
  member: FellowshipMember
  /** The id its spawn answered; empty where the spawn answered none, and the member is known by its type. */
  agentId: string
  /** Which try this is, from 1. */
  attempt: number
  at: number
  /** What the member answered when its turn ended. */
  answer: string
  /** HEAD when the task was first sent: a commit past it was made past the proof and the statues. */
  head?: string
  /** Whether this try's member was already sent back once with its proof, rather than a member a rung up. */
  isResumed?: boolean
  /** Whether the person put this try's change before the Argonath, after its member was back: its account came first. */
  isPutBefore?: boolean
}

/** A task the Fellowship committed. */
export type FellowshipCommit = {
  taskId: number
  title: string
  sha: string
  /** Who built it. */
  by: string
  /** What the statues found that did not block it, a line each. */
  minor: string[]
  /** The targets the change reached that nothing proves (a frontend): the statues judged them alone. */
  unproven?: string[]
  /** What its builder said of it: an errand's pull request opens on it. */
  answer?: string
  /** The Argonath's proof of it, in a line. */
  proof?: string
  /** Whether the person put it before the Argonath after its builder was back: the builder's account came before the proof. */
  isPutBefore?: boolean
}

/** A quest:its work taken to a pull request (or a push), one committed task at a time, in a git worktree of its own. */
export type FellowshipQuest = {
  kind: FellowshipKind
  ref: string
  url: string
  title: string
  /** The branch the quest commits on, and the one it set out from, which the pull request targets. */
  branch: string
  base: string
  /** The folder it is built in, absolute: its worktree, or the project's own folder where its branch is checked out. */
  tree: string
  /** The tasks of an errand or a review, which the quest keeps itself; a plan's are Elrond's. */
  tasks?: FellowshipTask[]
  /** Whether it goes on by itself: each task sent once the one before is committed, and a plan or an errand's pull request opened at the end. */
  isAuto: boolean
  phase: FellowshipPhase
  march: FellowshipMarch | null
  /** Argonath's last proof of the change, whole. */
  proof: string
  /** Its verdict in a line. */
  proofLine: string
  /** The statues' verdict on the change, in a line; empty before they judge it. */
  verdictLine: string
  /** What the Mirror showed of the task at hand; null before it gazed, for a light task, or when it showed nothing. */
  vision?: FellowshipVision | null
  /** The task the Mirror last gazed on: a task tried again keeps its tests. */
  gazed?: number
  commits: FellowshipCommit[]
  /** The pull or merge request, once opened; a review's from the start. */
  pr: string
  /** Whether both statues passed the whole branch as it stands; a commit after it is judged again before sailing. */
  isWarded?: boolean
  /** The targets the task at hand reached that nothing proves, from its last proof. */
  unproven?: string[]
  at: number
}

/** Something a press, a command or a turn asked the clock to do for a quest, outside the hook that asked. */
export type FellowshipWanted = 'set out' | 'set out auto' | 'errand' | 'errand auto' | 'next' | 'prove' | 'sail' | 'abandon'

// --- Lothlórien: Galadriel's tests written first -------------------------------------------------------------------------

/**
 * Where a vision stands:
 * - `gazing`: Galadriel writes the tests the purpose asks for
 * - `shown`: her tests are written and fail as they should, red; they are locked until HEAD moves past them
 * - `empty`: the purpose holds no behaviour a test can show; nothing was written
 * - `clouded`: she showed nothing that holds: no red tests, a file that is not a test, or no answer
 */
export type LothlorienState = 'gazing' | 'shown' | 'empty' | 'clouded'

/** One test Galadriel wrote. */
export type LothlorienTest = { file: string; name: string }

/** Lines Galadriel added to a test file, kept as they are until HEAD moves past them. */
export type LothlorienBlock = { file: string; lines: string[] }

/** A change to her tests, and why it was made. */
export type LothlorienAmendment = { file: string; why: string; by: string; at: number }

/** One gaze into the Mirror: the tests a purpose asks for, written before what they test. */
export type LothlorienVision = {
  purpose: string
  /** The issue it was gazed for, as the mod that asked names it (`github:owner/repo#12`); none from /mirror. */
  ref?: string
  /** Who asked: a mod through the tool, or the person through /mirror, whose Claude is told what she showed. */
  by: 'tool' | 'command'
  /** The id her spawn answered; empty where it answered none, and she is known by her type. */
  agentId: string
  state: LothlorienState
  /** HEAD when she gazed: once it moves, her tests are committed, and the lock is lifted. */
  head: string
  tests: LothlorienTest[]
  /** How the tests failed when she ran them: the red, in her words and the runner's. */
  red: string
  /** Why the purpose holds nothing to test, or why the vision is clouded; empty otherwise. */
  why: string
  /** What she added to test files, locked. */
  blocks: LothlorienBlock[]
  amendments: LothlorienAmendment[]
  at: number
  /** The quest's worktree she gazed in, absolute; none for the project's own folder. */
  tree?: string
}

// --- The Argonath: what a change reached, its proof and its judgement ----------------------------------------------------

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
  /** A service's database: each build of the fast stage plays against one of its own, in a warm container; none when not said. */
  db: ArgonathDb | null
  /** The request a service is asked before it is played, until it answers 2xx with a body `match` finds; none when not said. */
  ready: { request: string; match: string } | null
  /** The command that runs the tests a change of the target can break, from the project's folder; empty when none is named. */
  affected: string
}

/** A service's database for the fast stage: a Postgres image, the variable its address is set in, and how it is made ready. */
export type ArgonathDb = {
  /** A Postgres image, `postgres:18-alpine`: one container of it is started for the project and kept warm. */
  image: string
  /** The variable the build's database address is set in, `DATABASE_URL`. */
  env: string
  /** A command run in the build's folder before it plays, its address set: a migration. Empty when the app makes its own tables. */
  setup: string
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
  /** Of the lines the change touched, the statements no kept request ran, as spans by file; empty when all ran or none was measured. */
  unreached?: Record<string, string>
  /** The tests the affected command found broken by the change: failing on the working tree, not on the commit. */
  regressions?: string[]
  /** The tests the affected command found failing on both sides: broken before the change, and not owed by it. */
  preexisting?: string[]
  /** The tests the caller requires to pass on the working tree (written before the change, as Galadriel does), and how each ended. */
  required?: ArgonathTest[]
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
  /** What the change was taken against: its merge base with HEAD is diffed. HEAD when left out. */
  against?: string
  /** Whether there was no change to judge, and so no statue sat. */
  isEmpty?: boolean
}

/**
 * Where one target stands in a proof, for a mod that reads it as JSON:
 * - `pinned`: every changed run is pinned, and no test turned
 * - `unchanged`: no kept run changed, and the change did not reach its folders
 * - `unreached`: the change reached its folders, but no kept run answers otherwise: a refactor, or behaviour no kept
 *   run reaches, which only the statues are left to tell apart
 * - `unsettled`: a changed run is not pinned yet, or a test turned
 * - `unlooked`: the change reached its folders, but its handler could not look (no app, no kept request, anduril did not answer)
 * - `unhandled`: the change reached its folders, and Argonath has no handler for its kind: nothing is proved of it
 * - `untouched`: the change did not reach its folders, and its handler could not look either
 */
export type ArgonathProofState = 'pinned' | 'unchanged' | 'unreached' | 'unsettled' | 'unlooked' | 'unhandled' | 'untouched'

// --- The Black Gate: a pull request's review comments --------------------------------------------------------------------

/** How much a comment asks of whoever answers it, as the Mouth of Sauron weighs it. */
export type BlackgateWeight = 'light' | 'standard' | 'heavy'

/** One review comment: an open thread on a line, or a review's own words. */
export type BlackgateComment = {
  id: string
  author: string
  /** The file and line it is on; empty for a review's own words. */
  path: string
  line: number
  /** What it says, its replies after it, as data. */
  body: string
  url: string
  weight: BlackgateWeight
  /** Whether it asks for a change, which the Fellowship builds, or asks a question only the person can answer. */
  kind: 'change' | 'question'
}

/** The pull or merge request at the gate. */
export type BlackgatePr = {
  forge: 'github' | 'gitlab'
  /** The repository's path on its forge, `owner/repo`. */
  repo: string
  number: number
  url: string
  title: string
  /** Its own branch, where the answers are committed, and the one it goes onto. */
  branch: string
  base: string
}

/**
 * Where the gate stands:
 * - `weighing`: the comments are read and the Mouth of Sauron weighs them
 * - `ready`: the comments that ask for a change wait to be handed to the Fellowship
 * - `handed`: the Fellowship answers them on the pull request's branch; the questions are the person's
 */
export type BlackgatePhase = 'weighing' | 'ready' | 'handed'

export type BlackgateGate = {
  pr: BlackgatePr
  comments: BlackgateComment[]
  phase: BlackgatePhase
  at: number
}

// --- Mount Doom: what is kept of merged work -----------------------------------------------------------------------------

/** A mod that keeps work of a pull request: what it remembers, Mount Doom has it forget. */
export type MountdoomKeeper = 'fellowship' | 'blackgate'

/** One branch's work, as the mods that keep it remember it. */
export type MountdoomRelic = {
  /** The issue as Elrond writes it short, `github:owner/repo#12`; the pull request's own for a review or a gate alone. */
  ref: string
  branch: string
  base: string
  /** The worktree the Fellowship built it in, absolute; empty when it kept none. */
  tree: string
  /** The pull request's URL: kept by a mod, or found on the forge by its branch; empty when none is known. */
  pr: string
  keepers: MountdoomKeeper[]
  /** Whether the forge says it is merged, when last looked. */
  isMerged: boolean
}

// --- The plugin as a whole --------------------------------------------------------------------------------------------

/**
 * What an agent is to the mod:
 * - `council`: Elrond's planner, which reads and writes its plan file alone
 * - `member`: a member of the Fellowship, building one task in its quest's worktree
 * - `galadriel`: writing a task's tests first, and only tests
 * - `statue`: Isildur or Anárion, judging a change and changing nothing
 * - `other`: an agent the mod did not send, known only by the folder its spawn named
 */
export type MiddleEarthRole = 'council' | 'member' | 'galadriel' | 'statue' | 'other'

/** One agent, as the mod sent it or saw it spawned: what it is, and the folder it works in. */
export type MiddleEarthAgent = {
  role: MiddleEarthRole
  /** The project's folder when it was sent, absolute. */
  root: string
  /** The folder it works in, absolute: the project's own, or a quest's worktree. */
  tree: string
  /** A member's: the files its task names, which may be a mod's source. The council's: the plan file it writes. */
  files?: string[]
}

declare module 'claude-code' {
  interface PluginState {
    'middle-earth': {
      /** Every agent the mod sent, and every other whose spawn named a folder, by agent id: the one guard reads it. */
      agents: Record<string, MiddleEarthAgent>

      elrondPlan: ElrondPlan | null
      elrondCouncil: ElrondCouncil | null
      elrondNote: string
      elrondSelected: number
      /** The issue a press asked to convene again on: the clock convenes it, outside the press. */
      elrondWanted: string
      /** How a press asked the Fellowship to set out, stopping after each task or going on by itself: the clock asks it. */
      elrondSetOut: '' | 'step' | 'auto'

      /** Every quest under way, by its ref. */
      fellowshipQuests: Record<string, FellowshipQuest>
      /** Each quest's work as last read, by its ref, for the pane. */
      fellowshipPlans: Record<string, FellowshipPlan>
      /** What stood in each quest's way, or what came of the last thing asked of it, by its ref; '' for the Fellowship as a whole. */
      fellowshipNotes: Record<string, string>
      /** What each quest is doing right now, in a line, by its ref. */
      fellowshipWorking: Record<string, string>
      /** What the clock is asked to do, in order: for a quest by its ref, or ('' ref) to set one out, with what it is set out on. */
      fellowshipWanted: { ref: string; what: FellowshipWanted; arg?: string }[]
      /** The quest the pane shows and a command acts on when it names none, by its ref. */
      fellowshipSelected: string

      /** What the Mirror shows of the project's own folder. */
      lothlorienVision: LothlorienVision | null
      /** What it shows of each quest's worktree, by its folder. */
      lothlorienVisions: Record<string, LothlorienVision>
      lothlorienNote: string

      argonathTargets: ArgonathTarget[]
      /** The last radius of each target that has one, in the order the project names them. */
      argonathRadii: ArgonathRadius[]
      /** The targets whose folders were edited and not yet looked at again, by label. */
      argonathTouched: string[]
      /** What is being done now, for the pane to say; empty when nothing is. */
      argonathWorking: string
      /** What stood in the way of the last look, a sentence a target; empty when nothing did. */
      argonathNote: string
      /** The changed run the pane shows the evidence of, `label line`; empty for none. */
      argonathSelected: string
      /** Whether the band above the prompt is hidden until the next radius. */
      argonathIsHidden: boolean
      /** The beat of the band's glow, which swells and fades while the band is lit. */
      argonathGlow: number
      /** The folder the session started in, absolute: where the project's file and the checkouts are. */
      argonathHome: string
      /** The fingerprint of the change last handed to the reviews: the same change is not reviewed twice. */
      argonathReviewed: string
      /** The statues' judgement of the last settled change; null before any. */
      argonathJudgement: ArgonathJudgement | null
      /** The statues' judgement of the last change in each quest's worktree, by its folder. */
      argonathTreeJudgements: Record<string, ArgonathJudgement>

      blackgateGate: BlackgateGate | null
      blackgateNote: string
      /** What a command asked the clock to do, outside its hooks: open the gate on a pull request, or hand it over. */
      blackgateWanted: { what: 'open' | 'hand' | 'hand auto'; arg?: string } | null
      blackgateWorking: string

      mountdoomRelics: MountdoomRelic[]
      /** The pull requests the person was told are merged: each is told once. */
      mountdoomTold: string[]
      mountdoomNote: string
      /** What /mountdoom asked the clock for: `look`, or `cast` and what to cast. */
      mountdoomWanted: string
      mountdoomWorking: string
    }
  }
}
