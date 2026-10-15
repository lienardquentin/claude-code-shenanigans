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

declare module 'claude-code' {
  interface PluginState {
    blackgate: {
      gate: BlackgateGate | null
      note: string
      /** What a command asked the clock to do, outside its hooks: open the gate on a pull request, or hand it over. */
      wanted: { what: 'open' | 'hand' | 'hand auto'; arg?: string } | null
      working: string
    }
  }
}
