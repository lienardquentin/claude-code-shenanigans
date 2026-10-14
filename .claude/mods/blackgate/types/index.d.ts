/** How much a comment asks of whoever answers it, as the Mouth of Sauron weighs it. */
export type BlackgateWeight = 'light' | 'standard' | 'heavy'

/**
 * Where a comment stands:
 * - `todo`: waiting for a member
 * - `doing`: a member is on it, or the Argonath is proving or judging what was built
 * - `done`: answered and committed
 * - `asked`: it asks a question or needs a decision: the person answers it, no builder is sent
 * - `stuck`: the tries ran out; the person decides
 */
export type BlackgateCommentState = 'todo' | 'doing' | 'done' | 'asked' | 'stuck'

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
  /** Whether it asks for a change, or asks a question only the person can answer. */
  kind: 'change' | 'question'
  state: BlackgateCommentState
  /** Who answered it, and the commit. */
  by: string
  sha: string
  /** Why it is asked or stuck. */
  note: string
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
 * - `ready`: the next comment waits for the person, or goes at once when the gate goes on by itself
 * - `marching`, `proving`, `judging`: a comment is being answered, proved, judged
 * - `stuck`: a comment's tries ran out; the person decides
 * - `done`: every comment that asked for a change is answered; the person pushes
 */
export type BlackgatePhase = 'weighing' | 'ready' | 'marching' | 'proving' | 'judging' | 'stuck' | 'done'

/** A member out on a comment. */
export type BlackgateMarch = { commentId: string; member: string; agentId: string; attempt: number; answer: string; at: number }

export type BlackgateGate = {
  pr: BlackgatePr
  comments: BlackgateComment[]
  phase: BlackgatePhase
  isAuto: boolean
  march: BlackgateMarch | null
  proof: string
  proofLine: string
  verdictLine: string
  at: number
}

/** Something a turn or a press asked the clock to do, outside the hook that asked. */
export type BlackgateWanted = '' | 'next' | 'prove'

declare module 'claude-code' {
  interface PluginState {
    blackgate: {
      gate: BlackgateGate | null
      note: string
      wanted: BlackgateWanted
      working: string
    }
  }
}
