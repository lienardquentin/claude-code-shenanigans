/**
 * Where an errand stands:
 * - `singing`: Bombadil builds the change
 * - `proving`: Argonath proves what he built
 * - `judging`: every changed run is pinned; Isildur judges the change
 * - `home`: Isildur passed it and it is committed; the pull request waits for the person's go
 * - `stuck`: his tries ran out, or the judgement could not be made; the person decides
 * - `refused`: Bombadil found it no errand, and said why: it goes to the Council of Elrond
 * - `sailed`: the pull request is open
 */
export type BombadilPhase = 'singing' | 'proving' | 'judging' | 'home' | 'stuck' | 'refused' | 'sailed'

/** One errand: an issue taken to a pull request in a single change. */
export type BombadilErrand = {
  /** The issue as Elrond writes it short, `github:owner/repo#12`. */
  ref: string
  url: string
  title: string
  /** What the issue says, as Elrond read it: handed to Bombadil and to Isildur as data. */
  body: string
  branch: string
  base: string
  phase: BombadilPhase
  /** The id his spawn answered; empty where it answered none, and he is known by his type. */
  agentId: string
  /** Which try this is, from 1. */
  tries: number
  /** HEAD when the errand set out on its branch: a commit past it was made past the proof and Isildur. */
  head?: string
  /** What he answered when his turn ended. */
  answer: string
  proof: string
  proofLine: string
  verdictLine: string
  /** What Isildur found that did not block the change, a line each. */
  minor: string[]
  /** The commit, once made; empty when the change needed none. */
  sha: string
  pr: string
  at: number
}

/** Something a turn or a press asked the clock to do, outside the hook that asked. */
export type BombadilWanted = '' | 'prove' | 'sail'

declare module 'claude-code' {
  interface PluginState {
    bombadil: {
      errand: BombadilErrand | null
      note: string
      wanted: BombadilWanted
      /** The issue /bombadil was given, for the clock to begin on: Elrond, who reads it, answers no call made beneath a command's hooks. */
      begin: string
      working: string
    }
  }
}
