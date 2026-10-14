/** Where a task of the plan stands, as Elrond keeps it. */
export type FellowshipTaskState = 'todo' | 'doing' | 'done'

/** How much a task asks of whoever builds it, as the council weighed it. */
export type FellowshipWeight = 'light' | 'standard' | 'heavy'

/** A member of the Fellowship, by the agent type it is sent as. */
export type FellowshipMember = 'gandalf' | 'aragorn' | 'legolas' | 'gimli' | 'boromir' | 'frodo' | 'samwise' | 'merry' | 'pippin'

/** One task of the Elrond plan, as Fellowship reads it through `mcp__elrond__plan`. */
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
}

/** The Elrond plan, as much of it as the Fellowship works from. */
export type FellowshipPlan = {
  /** The issue as Elrond writes it short, `github:owner/repo#12`. */
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
 * Where the quest stands:
 * - `ready`: no companion out; the next task waits for the person, or goes at once on an auto quest
 * - `gazing`: Galadriel writes the task's tests first, red, before a member builds it (a light task has none)
 * - `marching`: a companion builds a task
 * - `proving`: Argonath proves what the companion built
 * - `judging`: every changed run is pinned; the statues of the Argonath judge the change, which is committed once they pass it
 * - `stuck`: a companion gave up, or its tries ran out; the person decides
 * - `arrived`: every task is committed; the pull request waits to be opened
 * - `sailed`: the pull request is open
 */
export type FellowshipPhase = 'ready' | 'gazing' | 'marching' | 'proving' | 'judging' | 'stuck' | 'arrived' | 'sailed'

/** What the Mirror showed of a task: Galadriel's red tests, which its member makes pass. */
export type FellowshipVision = { taskId: number; tests: { file: string; name: string }[]; red: string }

/** One member out on a task. */
export type FellowshipMarch = {
  taskId: number
  title: string
  member: FellowshipMember
  /** The id its spawn answered; empty where the spawn answered none, and the companion is known by its type. */
  agentId: string
  /** Which try this is, from 1. */
  attempt: number
  at: number
  /** What the companion answered when its turn ended. */
  answer: string
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
}

/** The quest: one Elrond plan taken to a pull request, one committed task at a time. */
export type FellowshipQuest = {
  ref: string
  url: string
  title: string
  /** The branch the quest commits on, and the one it set out from, which the pull request targets. */
  branch: string
  base: string
  /** Whether it goes on by itself: each task sent once the one before is committed, and the pull request opened at the end. */
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
  /** The pull or merge request, once opened. */
  pr: string
  at: number
}

/** Something a press or a turn asked the clock to do, outside the hook that asked. */
export type FellowshipWanted = '' | 'set out' | 'set out auto' | 'next' | 'prove' | 'sail' | 'abandon'

declare module 'claude-code' {
  interface PluginState {
    fellowship: {
      quest: FellowshipQuest | null
      /** The plan as last read from Elrond, for the pane. */
      plan: FellowshipPlan | null
      note: string
      wanted: FellowshipWanted
      /** What the Fellowship is doing right now, in a line; empty when idle. */
      working: string
    }
  }
}
