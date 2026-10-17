import type { RunPhase } from '../types'

// Where a run can go from where it stands: the build's whole course, in one table. A run is kept only as it
// moves along it, so a step that would take it elsewhere (a commit of a change no reviewer judged, a pull request opened
// from a build) is refused, however the code that asked for it came to ask. Text in, text out.

/**
 * Each phase, and those a run goes on to from it. It may stay where it is; and it may stop for the person (`stuck`)
 * from any phase before it has submitted.
 */
export const MOVES: Readonly<Record<RunPhase, readonly RunPhase[]>> = {
  // A task is sent (its tests written first, where they are owed), or every task is behind it
  ready: ['writing-tests', 'building', 'built'],
  // Her tests are shown, and the task is sent on them
  'writing-tests': ['ready'],
  // The builder is back, and its change goes up for verification; a review comment it hands back, having changed
  // nothing, is the person's, and the run goes on to the next
  'building': ['proving', 'ready'],
  // Settled, the reviewers judge it; or the builder is sent back, or a fresh one a rung up
  proving: ['reviewing', 'building'],
  // Passed, it is committed; moved, it is proved afresh; blocked, the builder goes back to it
  'reviewing': ['ready', 'proving', 'building'],
  // The person sends it again, puts it up for verification, or has it go on
  stuck: ['ready', 'writing-tests', 'building', 'proving', 'built'],
  // The whole branch is judged before it is submitted; a review handed over again has more to build
  'built': ['reviewing-branch', 'submitted', 'ready'],
  // The reviewers passed it or held it back: either way it stands built, to submit or be mended
  'reviewing-branch': ['built'],
  // Start on again, as a new run
  'submitted': ['ready'],
}

/** Whether a run may go from one phase to another. */
export const canMove = (from: RunPhase, to: RunPhase): boolean => from === to || (to === 'stuck' && from !== 'submitted') || MOVES[from].includes(to)

/**
 * Where a run kept from before a reload, or taken up again, stands now: no agent it had out is out any more, so one
 * that was gazing, building, proving or judging is stuck, to be sent again; one whose whole branch was being judged
 * has built, to submit again.
 */
export const restingPhase = (was: RunPhase): RunPhase =>
  was === 'writing-tests' || was === 'building' || was === 'proving' || was === 'reviewing' ? 'stuck' : was === 'reviewing-branch' ? 'built' : was
