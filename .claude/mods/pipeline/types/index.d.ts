// --- the planner: the plan of an issue ----------------------------------------------------------------------------------------

/** Where an issue lives: the forge that serves it, which says the CLI and the API it is read through. */
export type PlanForge = 'github' | 'gitlab'

/** One issue, by where it lives. */
export type PlanRef = {
  forge: PlanForge
  /** The host that serves it, `github.com`, `gitlab.com` or a self-hosted one. */
  server: string
  /** The repository's path on that host: `owner/repo`, or `group/sub/project` on GitLab. */
  repo: string
  number: number
}

/** Where a task stands. */
export type PlanTaskState = 'todo' | 'doing' | 'done'

/**
 * How much a task asks of whoever builds it: `light` for docs, config, a rename or a test to adjust; `standard` for
 * one module's change and its test; `heavy` for one that crosses targets or touches what is risky to change.
 */
export type PlanWeight = 'light' | 'standard' | 'heavy'

/** One step of the run: something a single change can do and a reviewer can check. */
export type PlanTask = {
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
  weight: PlanWeight
  /** Whether the planner named no weight that reads, so that its `standard` is no one's choice. */
  isUnweighed?: boolean
  state: PlanTaskState
}

/** Something the issue leaves open, for the person to decide. */
export type PlanQuestion = {
  text: string
  /** Short answers the planner offers to pick from; the person may write their own. */
  options: string[]
  /** What the person answered; empty while unanswered. */
  answer: string
}

/** How much a risk could hurt the change: what breaks or is lost if it comes true. */
export type RiskSeverity = 'high' | 'medium' | 'low'

/** Something that could go wrong with the change, and what the person chose to do about it. */
export type PlanRisk = {
  text: string
  severity: RiskSeverity
  /** How to make it less likely or less harmful; empty when the planner named no way. */
  mitigation: string
  /** The tasks it threatens, by id. */
  tasks: number[]
  /** The person wants the next revision to cover it with a task. */
  wantsTask: boolean
}

/** A question the person answered: decided, and carried into every plan of the issue after it. */
export type PlanDecision = { text: string; answer: string }

/** The plan the planner made of one issue. */
export type IssuePlan = {
  /** The issue as written short, `github:owner/repo#12`. */
  ref: string
  url: string
  title: string
  /** What the issue asks for, in the planner's words. */
  summary: string
  /** How it will be done, in a paragraph. */
  approach: string
  tasks: PlanTask[]
  /** What the issue leaves open, for the person to answer. */
  questions: PlanQuestion[]
  /** What the person decided in this plan's revisions before it: handed to the planner, and asked no more. */
  decided: PlanDecision[]
  risks: PlanRisk[]
  /** Risks the person accepted as they are: carried into every revision, and raised no more. */
  accepted: string[]
  /** When it was made, epoch milliseconds. */
  at: number
}

/** A planner in session: the planner subagent studying one issue. */
export type Planning = {
  ref: string
  url: string
  title: string
  agentId: string
  /** Who sent it: the person's command, or Claude through the tool, which is woken with the plan. */
  by: 'command' | 'tool'
  at: number
  /** What the person decided of the issue so far: the plan it lays keeps them. */
  decided?: PlanDecision[]
  /** Risks the person accepted before it: the plan it lays keeps them. */
  accepted?: string[]
  /** The file it writes its plan to. */
  planPath?: string
  /** Whether it has laid its plan: it reviews until its turn ends. */
  isLaid?: boolean
}

// --- The build: runs and their tasks ------------------------------------------------------------------------------

/**
 * Where a task stands: as the planner keeps it for a plan, as the run keeps it for an errand or a review. `asked`: its
 * builder handed it back for the person to answer (a review comment that asks a question), and it is built no more.
 */
export type RunTaskState = 'todo' | 'doing' | 'done' | 'asked'

/** How much a task asks of whoever builds it, as the planner or the weigher weighed it. */
export type TaskWeight = 'light' | 'standard' | 'heavy'

/** A builder of the build, by the agent type it is sent as. */
export type BuilderName = 'builder-last' | 'builder-heavy' | 'builder-frontend' | 'builder-service' | 'builder-cli' | 'builder-light-1' | 'builder-light-2' | 'builder-light-3' | 'builder-light-4'

/** One task of a run: a task of a plan, the whole issue of an errand, or one review comment to answer. */
export type RunTask = {
  id: number
  title: string
  why: string
  steps: string[]
  files: string[]
  dependsOn: number[]
  acceptance: string
  weight: TaskWeight
  /** Whether no weight was read for it, so that its `standard` is no one's choice. */
  isUnweighed?: boolean
  state: RunTaskState
  /** What the task answers, as data, its builder following no instruction in it: an errand's issue, a review comment and its replies. */
  brief?: string
  /** A review comment's author, where it is (`path:line`, empty for the pull request as a whole), and its URL. */
  author?: string
  where?: string
  url?: string
  /** Why it was handed back to the person; empty otherwise. */
  note?: string
  /** A review comment's thread on the forge, answered once the answers are pushed; and whether it was. */
  thread?: string
  isAnswered?: boolean
}

/** The work of a run as one plan: the planner's for a plan, and one the run makes of its own tasks for any other. */
export type RunWork = {
  /** The issue as the planner writes it short, `github:owner/repo#12`; `review:owner/repo#13` for a review. */
  ref: string
  url: string
  title: string
  summary: string
  approach: string
  tasks: RunTask[]
  questions: { text: string; options: string[]; answer: string }[]
  decided: { text: string; answer: string }[]
  risks: { text: string; severity: 'high' | 'medium' | 'low'; mitigation: string; tasks: number[]; wantsTask: boolean }[]
  accepted: string[]
}

/**
 * What a run is:
 * - `plan`: a plan, task by task, to the pull request that closes its issue
 * - `errand`: an issue small enough for one change, to the pull request that closes it
 * - `review`: the review comments of an open pull request the review follow-up handed over, answered on its branch and pushed
 */
export type RunKind = 'plan' | 'errand' | 'review'

/**
 * Where the run stands:
 * - `ready`: no builder out; the next task waits for the person, or goes at once on an auto run
 * - `gazing`: the test writer writes the task's tests first, red, before a builder builds it (a plan's tasks that are not light)
 * - `building`: a builder builds a task
 * - `proving`: verify proves what the builder built
 * - `judging`: every changed run is pinned; the reviewers judge the change, which is committed once they pass it
 * - `stuck`: a builder handed its task back, or its tries ran out; the person decides
 * - `built`: every task is committed; the pull request waits to be opened, or the branch to be pushed
 * - `reviewing the branch`: both reviewers judge the whole branch of a plan, what its tasks do together, before it is submitted
 * - `submitted`: the pull request is open, or the review's answers are pushed
 */
export type RunPhase = 'ready' | 'writing-tests' | 'building' | 'proving' | 'reviewing' | 'stuck' | 'built' | 'reviewing-branch' | 'submitted'

/** What the tests written first showed of a task: the test writer's red tests, which its builder makes pass. */
export type TestsToPass = { taskId: number; tests: { file: string; name: string }[]; unrun?: { file: string; name: string; why: string }[]; red: string }

/** One builder out on a task. */
export type CurrentTry = {
  taskId: number
  title: string
  builder: BuilderName
  /** The id its spawn answered; empty where the spawn answered none, and the builder is known by its type. */
  agentId: string
  /** Which try this is, from 1. */
  attempt: number
  at: number
  /** What the builder answered when its turn ended. */
  answer: string
  /** HEAD when the task was first sent: a commit past it was made past the proof and the reviewers. */
  head?: string
  /** Whether this try's builder was already sent back once with its proof, rather than a builder a rung up. */
  isResumed?: boolean
  /** Whether this try's builder was already sent back once to tidy the minor findings of a pass. */
  isTidied?: boolean
  /** Whether the person put this try's change up for verification, after its builder was back: its account came first. */
  isPutBefore?: boolean
  /**
   * Whether a lane's change, passed by the reviewers, was rebased onto its run's branch since: it is proved again, and
   * lands with the minor findings it passed with, no reviewer sent anew.
   */
  isRebased?: boolean
  /** The minor findings a rebased change passed with. */
  minor?: string[]
  /** How full the builder's context was, in tokens, when it was stopped past its budget: the task is too large for one. */
  tooLarge?: number
}

/**
 * A run's task built beside the others, in a worktree and on a branch of its own off the run's: its own run, of
 * the plan of the one it lands on once its change passed.
 */
export type RunLane = {
  /** The run it lands on, by its ref. */
  of: string
  taskId: number
}

/** A task the build committed. */
export type RunCommit = {
  taskId: number
  title: string
  sha: string
  /** Who built it. */
  by: string
  /** What the reviewers found that did not block it, a line each. */
  minor: string[]
  /** The targets the change reached that nothing proves (a frontend): the reviewers judged them alone. */
  unproven?: string[]
  /** What its builder said of it: an errand's pull request opens on it. */
  answer?: string
  /** The the proof of it, in a line. */
  proof?: string
  /** Whether the person put it up for verification after its builder was back: the builder's account came before the proof. */
  isPutBefore?: boolean
}

/** A run:its work taken to a pull request (or a push), one committed task at a time, in a git worktree of its own. */
export type Run = {
  kind: RunKind
  ref: string
  url: string
  title: string
  /** The branch the run commits on, and the one it started from, which the pull request targets. */
  branch: string
  base: string
  /** The folder it is built in, absolute: its worktree, or the project's own folder where its branch is checked out. */
  tree: string
  /** The tasks of an errand or a review, which the run keeps itself; a plan's are the planner's. */
  tasks?: RunTask[]
  /** Whether it goes on by itself: each task sent once the one before is committed, and a plan or an errand's pull request opened at the end. */
  isAuto: boolean
  phase: RunPhase
  current: CurrentTry | null
  /** verify's last proof of the change, whole. */
  proof: string
  /** Its verdict in a line. */
  proofLine: string
  /** The reviewers' verdict on the change, in a line; empty before they judge it. */
  verdictLine: string
  /** What the tests written first showed of the task at hand; null before it gazed, for a light task, or when it showed nothing. */
  testsToPass?: TestsToPass | null
  /** The task the tests written first last gazed on: a task tried again keeps its tests. */
  testsFor?: number
  commits: RunCommit[]
  /** The pull or merge request, once opened; a review's from the start. */
  pr: string
  /** Whether both reviewers passed the whole branch as it stands; a commit after it is judged again before submitting. */
  isBranchReviewed?: boolean
  /** The targets the task at hand reached that nothing proves, from its last proof. */
  unproven?: string[]
  /** What git's config says of the code a commit runs (hooks, filters, includes) as the run started; absent on a run started before it was kept. */
  gitRuns?: string
  /** A lane's: the run it is a task of, beside its others. */
  lane?: RunLane
  at: number
  /** Until when it waits for the quota before its next task, in the clock's milliseconds, and why; absent while it does not. */
  heldUntil?: number
  heldWhy?: string
}

/** Something a press, a command or a turn asked the clock to do for a run, outside the hook that asked. */
export type RunAsk = 'start' | 'start auto' | 'errand' | 'errand auto' | 'next' | 'prove' | 'submit' | 'abandon'

// --- tests first: the test writer's tests written first -------------------------------------------------------------------------

/**
 * Where a vision stands:
 * - `gazing`: the test writer writes the tests the purpose asks for
 * - `shown`: its tests are written and fail as they should, red; they are locked until HEAD moves past them
 * - `empty`: the purpose holds no behaviour a test can show; nothing was written
 * - `clouded`: she showed nothing that holds: no red tests, a file that is not a test, or no answer
 */
export type TestsFirstState = 'gazing' | 'shown' | 'empty' | 'clouded'

/** One test the test writer wrote. */
export type WrittenTest = { file: string; name: string }

/** A test the test writer wrote that cannot run where they were written (root alone, another system, ignored unless asked), and why. */
export type UnrunTest = WrittenTest & { why: string; by?: string }

/** Lines the test writer added to a test file, kept as they are until HEAD moves past them. */
export type LockedBlock = { file: string; lines: string[] }

/** A change to its tests, and why it was made. */
export type Amendment = { file: string; why: string; by: string; at: number }

/** One gaze into the tests written first: the tests a purpose asks for, written before what they test. */
export type TestsFirst = {
  purpose: string
  /** The issue it was gazed for, as the mod that asked names it (`github:owner/repo#12`); none from /tests. */
  ref?: string
  /** Who asked: a mod through the tool, or the person through /tests, whose Claude is told what it showed. */
  by: 'tool' | 'command'
  /** The id her spawn answered; empty where it answered none, and she is known by her type. */
  agentId: string
  state: TestsFirstState
  /** HEAD when they were written: once it moves, its tests are committed, and the lock is lifted. */
  head: string
  /** The tests she showed red: a change is owed their passing. */
  tests: WrittenTest[]
  /** The tests she wrote that cannot run here: locked as the others, but owed no passing. */
  unrun?: UnrunTest[]
  /** How the tests failed when she ran them: the red, in her words and the runner's. */
  red: string
  /** Why the purpose holds nothing to test, or why the vision is clouded; empty otherwise. */
  why: string
  /** What she added to test files, locked. */
  blocks: LockedBlock[]
  amendments: Amendment[]
  at: number
  /** The run's worktree they were written in, absolute; none for the project's own folder. */
  tree?: string
}

// --- Verify: what a change reached, its proof and its judgement ----------------------------------------------------

/** What a target is, which says the handler that finds what changed in what it does. */
export type TargetKind = 'cli' | 'service' | 'frontend'

/** One thing the project builds, as `.claude/argonath` names it. */
export type Target = {
  /** Its name: for a CLI, the one the recorder watches it under. */
  label: string
  kind: TargetKind
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
  live: LiveStage | null
  /** A service's database: each build of the fast stage plays against one of its own, in a warm container; none when not said. */
  db: Database | null
  /** The request a service is asked before it is played, until it answers 2xx with a body `match` finds; none when not said. */
  ready: { request: string; match: string } | null
  /** The command that runs the tests a change of the target can break, from the project's folder; empty when none is named. */
  affected: string
  /** The commands that run its lint, type and format checks, each one a change may not newly fail; none when none is named. */
  checks: string[]
  /** The command that audits its dependencies, run when a change touches a dependency manifest of it; empty when none is named. */
  audit: string
}

/** A service's database for the fast stage: a Postgres image, the variable its address is set in, and how it is made ready. */
export type Database = {
  /** A Postgres image, `postgres:18-alpine`: one container of it is started for the project and kept warm. */
  image: string
  /** The variable the build's database address is set in, `DATABASE_URL`. */
  env: string
  /** A command run in the build's folder before it plays, its address set: a migration. Empty when the app makes its own tables. */
  setup: string
}

/** A service's live stage: its deployed workload, what to forward to it, and how to leave its database as it was. */
export type LiveStage = {
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

/** How a test ended on one side of a proof; `skip` when its runner said it skipped it, `none` when that side did not name it. */
export type Outcome = 'pass' | 'fail' | 'skip' | 'none'

/** One test a changed run is marked on, and how it ended on each side once proved. */
export type TestResult = {
  name: string
  /** On the source of the commit compared against, with the working tree's tests. */
  from: Outcome
  /** On the working tree. */
  to: Outcome
}

/**
 * Where a changed run stands: `bare` with no test marked on it, `marked` with one not proved yet, `pinned` when a
 * test of its own fails on the commit and passes on the working tree, `loose` when its tests pass on both, `broken`
 * when one fails on the working tree.
 */
export type RunState = 'bare' | 'marked' | 'pinned' | 'loose' | 'broken'

/** One kept run or request whose answer changed: a part of the radius. */
export type ChangedRun = {
  /** The run or the request as the project keeps it. */
  line: string
  /** How it changed: its ending or status, and a diff of what it wrote or answered. */
  evidence: string
  tests: TestResult[]
  state: RunState
}

/** What a change reached in one target, by the kept runs or requests that changed, and what of it a test pins. */
export type Radius = {
  label: string
  kind: TargetKind
  /** When it was made, milliseconds since the epoch. */
  at: number
  /** The two builds compared and how many of the kept ones changed, in a line. */
  summary: string
  seams: ChangedRun[]
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
  /** The tests the caller requires to pass on the working tree (written before the change, as the test writer does), and how each ended. */
  required?: TestResult[]
  /** Why the change fails its target's check or audit, which passed on the commit's source: each owed by the change. */
  gates?: string[]
  /** The check or audit that failed on the commit's source too: said, and not owed by the change. */
  gatesBefore?: string[]
  /** What the change does to its target's tests that weakens them: a file deleted, tests taken out, a test skipped. */
  weakened?: string[]
  /** The dependency manifests of the target the change touches. */
  manifests?: string[]
  /** Whether no kept run of the target is compared (a frontend): its tests and checks alone were run on the change. */
  isUnhandled?: boolean
}

/** One of the two reviewers of verify, which judge a settled change. */
export type ReviewerName = 'reviewer-correctness' | 'reviewer-security'

/** Something a reviewer found in the change: `blocking` keeps it from being committed, `minor` does not. */
export type Finding = { severity: 'blocking' | 'minor'; where: string; text: string }

/** One reviewer reviewing in judgement: the reviews it carries and what it found. */
export type ReviewSeat = {
  reviewer: ReviewerName
  title: string
  /** The reviews it carries, as slash commands. */
  reviews: string[]
  /** The id its spawn answered; empty where it answered none, and the reviewer is known by its type. */
  agentId: string
  /** `reviewing` while it judges; `pass` with no blocking finding, `fail` with one; `silent` when it gave no findings that read. */
  state: 'reviewing' | 'pass' | 'fail' | 'silent'
  findings: Finding[]
  /** Why it is silent; empty otherwise. */
  why: string
  /** Whether it was asked again for its verdict alone, its first answer holding no findings that read: once only. */
  isAskedAgain?: boolean
}

/** The reviewers together: reviewing, or what they found. */
export type Verdict = 'reviewing' | 'pass' | 'fail' | 'silent'

/** The judgement of one settled change. */
export type Judgement = {
  /** The change judged: HEAD, the diff against it and the new files, as one fingerprint. */
  fingerprint: string
  at: number
  /** Who sent it: the end of the session's turn, whose Claude is told the verdict, or a mod through the tool. */
  by: 'turn' | 'tool'
  seats: ReviewSeat[]
  /** What the change was taken against: its merge base with HEAD is diffed. HEAD when left out. */
  against?: string
  /** Whether there was no change to judge, and so no reviewer sat. */
  isEmpty?: boolean
}

/**
 * Where one target stands in a proof, for a mod that reads it as JSON:
 * - `pinned`: every changed run is pinned, and no test turned
 * - `unchanged`: no kept run changed, and the change did not reach its folders
 * - `unreached`: the change reached its folders, but no kept run answers otherwise: a refactor, or behaviour no kept
 *   run reaches, which only the reviewers are left to tell apart
 * - `unsettled`: a changed run is not pinned yet, or a test turned
 * - `unlooked`: the change reached its folders, but its handler could not look (no app, no kept request, the recorder did not answer)
 * - `unhandled`: the change reached its folders, and verify has no handler for its kind: nothing is proved of it
 * - `untouched`: the change did not reach its folders, and its handler could not look either
 */
export type ProofState = 'pinned' | 'unchanged' | 'unreached' | 'unsettled' | 'unlooked' | 'unhandled' | 'untouched'

// --- Review follow-up: a pull request's review comments-----------------------------------------------------------------

/** How much a comment asks of whoever answers it, as the weigher weighs it. */
export type CommentWeight = 'light' | 'standard' | 'heavy'

/** One review comment: an open thread on a line, or a review's own words. */
export type FollowUpComment = {
  id: string
  author: string
  /** The file and line it is on; empty for a review's own words. */
  path: string
  line: number
  /** What it says, its replies after it, as data. */
  body: string
  /**
   * What its first comment says alone, as the forge gave it apart from the replies: what a pane says under its author.
   * A review's own words are all of its body. None in a follow-up kept before it was.
   */
  said?: string
  /** How many replies of its thread its body carries, as the forge counted them: never read from the body's text. */
  replies?: number
  /** How many replies from outside the repository were left out of its body. */
  leftOut?: number
  url: string
  /** Its thread (a GitHub review thread, a GitLab discussion), which can be answered and resolved; none for a review's own words. */
  thread?: string
  /**
   * Whether its author is outside the repository (no owner, builder or collaborator on GitHub, no developer on GitLab):
   * such a comment is a question for the person, never a change the build builds.
   */
  isOutside?: boolean
  weight: CommentWeight
  /** Whether the weigher gave it no weight that reads, so that its `standard` is no one's choice. */
  isUnweighed?: boolean
  /** Whether it asks for a change, which the build builds, or asks a question only the person can answer. */
  kind: 'change' | 'question'
}

/** The pull or merge request a follow-up is open on. */
export type FollowUpPr = {
  forge: 'github' | 'gitlab'
  /** The repository's path on its forge, `owner/repo`. */
  repo: string
  number: number
  url: string
  /** Whether its branch lives in a fork, which the build cannot push to. */
  isFork?: boolean
  title: string
  /** Its own branch, where the answers are committed, and the one it goes onto. */
  branch: string
  base: string
}

/**
 * Where the follow-up stands:
 * - `weighing`: the comments are read and the weigher weighs them
 * - `ready`: the comments that ask for a change wait to be handed to the build
 * - `handed`: the build answers them on the pull request's branch; the questions are the person's
 */
export type FollowUpPhase = 'weighing' | 'ready' | 'handed'

export type FollowUp = {
  pr: FollowUpPr
  comments: FollowUpComment[]
  phase: FollowUpPhase
  at: number
}

// --- Cleanup: what is kept of merged work --------------------------------------------------------------------------------

/** A part that keeps work of a pull request: what it remembers, the cleanup has it forget. */
export type CleanupKeeper = 'build' | 'follow-up'

/** One branch's work, as the mods that keep it remember it. */
export type Leftover = {
  /** The issue as the planner writes it short, `github:owner/repo#12`; the pull request's own for a review or a follow-up alone. */
  ref: string
  branch: string
  base: string
  /** The worktree the build ran in, absolute; empty when it kept none. */
  tree: string
  /** The pull request's URL: kept by a mod, or found on the forge by its branch; empty when none is known. */
  pr: string
  keepers: CleanupKeeper[]
  /** Every run the build keeps on the branch, by its ref: an errand and the review of its pull request share one. */
  quests?: string[]
  /** Whether the forge says it is merged, when last looked. */
  isMerged: boolean
  /** Whether the forge says its pull request, still open, is in conflict with its base, when last looked. */
  isConflicting?: boolean
  /** Why the forge could not say where its pull request stands, when last looked; absent when it said. */
  unknown?: string
  /** The commit the forge says the pull request was of, when last looked: a local branch past it holds work the merge did not take. */
  head?: string
}

// --- The plugin as a whole --------------------------------------------------------------------------------------------

/**
 * What an agent is to the mod:
 * - `planner`: the planner's planner, which reads and writes its plan file alone
 * - `builder`: a builder of the build, building one task in its run's worktree
 * - `test-writer`: writing a task's tests first, and only tests
 * - `reviewer`: the correctness reviewer or the security reviewer, judging a change and changing nothing
 * - `other`: an agent the mod did not send, known only by the folder its spawn named
 */
export type AgentRole = 'planner' | 'builder' | 'test-writer' | 'reviewer' | 'other'

/** One agent, as the mod sent it or saw it spawned: what it is, and the folder it works in. */
export type SentAgent = {
  role: AgentRole
  /** The project's folder when it was sent, absolute. */
  root: string
  /** The folder it works in, absolute: the project's own, or a run's worktree. */
  tree: string
  /** A builder's: the files its task names, which may be a mod's source. The planner's: the plan file it writes. */
  files?: string[]
  /** The issue it works for, as the planner spells it, where the part that sent it knew: what its turns cost is counted to it. */
  ref?: string
  /** Why it may call no more tools, and must end its turn: a builder past its context budget. */
  stopped?: string
}

/** One turn of an agent the mod sent, as `.fellowship/spend.jsonl` keeps it a line each: what it cost, and for what. */
export type SpentTurn = {
  role: AgentRole
  /** The issue it worked for, where its part knew it. */
  ref?: string
  /** The folder it worked in, absolute. */
  tree: string
  /** The model that answered, by the id the API reports. */
  model: string
  /** Input tokens neither read from nor written to the prompt cache. */
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
  durationMs: number
  at: number
}

// --- Issues: the open issues, each to an errand or to the planner --------------------------------------------------------

/** An open issue as the issues pane lists it. */
export type ListedIssue = {
  /** The ref the planner and the build know it by: `github:owner/repo#12`. */
  ref: string
  number: number
  title: string
  url: string
  labels: string[]
  author: string
  updatedAt: string
  /** Its body's start, for the pane to show of the issue it opens. */
  body: string
}

declare module 'claude-code' {
  interface PluginState {
    'pipeline': {
      /** Every agent the mod sent, and every other whose spawn named a folder, by agent id: the one guard reads it. */
      agents: Record<string, SentAgent>

      plannerPlan: IssuePlan | null
      plannerAtWork: Planning | null
      plannerNote: string
      plannerSelected: number
      /** The issue a press asked to send again on: the clock sends it, outside the press. */
      plannerWanted: string
      /** How a press asked the build to started, stopping after each task or going on by itself: the clock asks it. */
      plannerSetOut: '' | 'step' | 'auto'

      /** Every run under way, by its ref. */
      buildRuns: Record<string, Run>
      /** Each run's work as last read, by its ref, for the pane. */
      buildWork: Record<string, RunWork>
      /** What stood in each run's way, or what came of the last thing asked of it, by its ref; '' for the build as a whole. */
      buildNotes: Record<string, string>
      /** What each run is doing right now, in a line, by its ref. */
      buildWorking: Record<string, string>
      /** What the clock is asked to do, in order: for a run by its ref, or ('' ref) to set one out, with what it is start on. */
      buildWanted: { ref: string; what: RunAsk; arg?: string }[]
      /** The run the pane shows and a command acts on when it names none, by its ref. */
      buildSelected: string
      /** What each run's agents have cost so far, in a line, by its ref: the pane shows it without reading the record. */
      buildSpent: Record<string, string>

      /** What the tests written first shows of the project's own folder. */
      testsFirst: TestsFirst | null
      /** What it shows of each run's worktree, by its folder. */
      testsFirstByTree: Record<string, TestsFirst>
      testsFirstNote: string

      verifyTargets: Target[]
      /** The last radius of each target that has one, in the order the project names them. */
      verifyRadii: Radius[]
      /** The targets whose folders were edited and not yet looked at again, by label. */
      verifyTouched: string[]
      /** What is being done now, for the pane to say; empty when nothing is. */
      verifyWorking: string
      /** What stood in the way of the last look, a sentence a target; empty when nothing did. */
      verifyNote: string
      /** The changed run the pane shows the evidence of, `label line`; empty for none. */
      verifySelected: string
      /** Whether the band above the prompt is hidden until the next radius. */
      verifyIsHidden: boolean
      /** The beat of the band's glow, which swells and fades while the band is lit. */
      verifyGlow: number
      /** The folder the session started in, absolute: where the project's file and the checkouts are. */
      verifyHome: string
      /** The fingerprint of the change last handed to the reviews: the same change is not reviewed twice. */
      verifyReviewed: string
      /** The reviewers' judgement of the last settled change; null before any. */
      verifyJudgement: Judgement | null
      /** The reviewers' judgement of the last change in each run's worktree, by its folder. */
      verifyTreeJudgements: Record<string, Judgement>

      followUpReview: FollowUp | null
      followUpNote: string
      /** What a command asked the clock to do, outside its hooks: open a follow-up on a pull request, or hand it over. */
      followUpWanted: { what: 'open' | 'hand' | 'hand auto'; arg?: string } | null
      followUpWorking: string

      /** The open issues as last read, the most recently updated first. */
      issuesIssues: ListedIssue[]
      /** The repository they were read from, `owner/repo`; empty before any read. */
      issuesRepo: string
      /** What came of the last read or press; empty when nothing is to say. */
      issuesNote: string
      issuesWorking: string
      /** The issue the pane opens, by its number; 0 for none. */
      issuesSelected: number

      cleanupLeftovers: Leftover[]
      /** The pull requests the person was told are merged: each is told once. */
      cleanupTold: string[]
      cleanupNote: string
      /** What /cleanup asked the clock for: `look`, or `clean` and what to clean up. */
      cleanupWanted: string
      cleanupWorking: string
    }
  }
}
