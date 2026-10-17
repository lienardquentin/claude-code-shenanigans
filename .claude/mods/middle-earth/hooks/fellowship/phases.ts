import type { FellowshipPhase } from '../../types'

// Where a quest can go from where it stands: the Fellowship's whole course, in one table. A quest is kept only as it
// moves along it, so a step that would take it elsewhere (a commit of a change no statue judged, a pull request opened
// from a march) is refused, however the code that asked for it came to ask. Text in, text out.

/**
 * Each phase, and those a quest goes on to from it. It may stay where it is; and it may stop for the person (`stuck`)
 * from any phase before it has sailed.
 */
export const MOVES: Readonly<Record<FellowshipPhase, readonly FellowshipPhase[]>> = {
  // A task is sent (its tests written first, where they are owed), or every task is behind it
  ready: ['gazing', 'marching', 'arrived'],
  // Her tests are shown, and the task is sent on them
  gazing: ['ready'],
  // The member is back, and its change goes before the Argonath; a review comment it hands back, having changed
  // nothing, is the person's, and the quest goes on to the next
  marching: ['proving', 'ready'],
  // Settled, the statues judge it; or the member is sent back, or a fresh one a rung up
  proving: ['judging', 'marching'],
  // Passed, it is committed; moved, it is proved afresh; blocked, the member goes back to it
  judging: ['ready', 'proving', 'marching'],
  // The person sends it again, puts it before the Argonath, or has it go on
  stuck: ['ready', 'gazing', 'marching', 'proving', 'arrived'],
  // The whole branch is judged before it sails; a review handed over again has more to build
  arrived: ['warding', 'sailed', 'ready'],
  // The statues passed it or held it back: either way it stands arrived, to sail or be mended
  warding: ['arrived'],
  // Set out on again, as a new quest
  sailed: ['ready'],
}

/** Whether a quest may go from one phase to another. */
export const canMove = (from: FellowshipPhase, to: FellowshipPhase): boolean => from === to || (to === 'stuck' && from !== 'sailed') || MOVES[from].includes(to)

/**
 * Where a quest kept from before a reload, or taken up again, stands now: no agent it had out is out any more, so one
 * that was gazing, marching, proving or judging is stuck, to be sent again; one whose whole branch was being judged
 * has arrived, to sail again.
 */
export const restingPhase = (was: FellowshipPhase): FellowshipPhase =>
  was === 'gazing' || was === 'marching' || was === 'proving' || was === 'judging' ? 'stuck' : was === 'warding' ? 'arrived' : was
