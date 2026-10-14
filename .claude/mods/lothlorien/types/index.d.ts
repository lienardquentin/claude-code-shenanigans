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
}

declare module 'claude-code' {
  interface PluginState {
    lothlorien: {
      vision: LothlorienVision | null
      note: string
    }
  }
}
