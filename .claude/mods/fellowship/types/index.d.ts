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

declare module 'claude-code' {
  interface PluginState {
    fellowship: {
      /** Every quest under way, by its ref. */
      quests: Record<string, FellowshipQuest>
      /** Each quest's work as last read, by its ref, for the pane. */
      plans: Record<string, FellowshipPlan>
      /** What stood in each quest's way, or what came of the last thing asked of it, by its ref; '' for the Fellowship as a whole. */
      notes: Record<string, string>
      /** What each quest is doing right now, in a line, by its ref. */
      working: Record<string, string>
      /** What the clock is asked to do, in order: for a quest by its ref, or ('' ref) to set one out, with what it is set out on. */
      wanted: { ref: string; what: FellowshipWanted; arg?: string }[]
      /** The quest the pane shows and a command acts on when it names none, by its ref. */
      selected: string
    }
  }
}
