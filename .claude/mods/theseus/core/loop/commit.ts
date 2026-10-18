import type { Run, RunCommit, RunTask } from '../../types'
import { UNMODDED } from '../change'
import { applyAfresh, commitTask, gitRunsOf, landLane } from '../git'
import { inTurn } from '../kit'
import { HOW_TO, BUILDERS, commitMessage, conflictPrompt, isAllDone, issueRefOf } from '../run'
import { gitAt, workOf, mark } from './ports'
import type { Ports } from './ports'
import { headMoved, stop } from './send'
import { untickedOf } from './prove'

// A passed change committed on the run's branch, a lane's landed on it, and a change put up for verification again.

/** Commits the change the reviewers passed as the task's own, and goes on. Answers what was done, in a sentence. */
export async function commitNow(p: Ports, ref: string, minor: readonly string[]): Promise<string> {
  const held = await p.runs.at(ref)

  if (held === null || held.current === null) return 'There is nothing to commit.'

  const out = held.current
  const made = await workOf(p, held)
  const task = typeof made === 'string' ? undefined : made.tasks.find(one => one.id === out.taskId)

  if (task === undefined || typeof made === 'string') {
    await p.runs.keep(ref, was => ({ ...was, phase: 'stuck' }))

    return `Task ${out.taskId} is not in the work of ${ref} any more: ${typeof made === 'string' ? made : 'started again.'}`
  }

  // The reviewers judged the change against HEAD as it was sent: a commit made since was judged by no one
  const moved = await headMoved(p, held)

  if (moved !== undefined) {
    await stop(p, held, moved)

    return moved
  }

  await p.board.working(ref, `Committing task ${task.id}…`)

  const by = BUILDERS[out.builder].title
  const unproven = held.unproven ?? []
  // What the mods keep in the tree (the recorder's builds, verify's trees) is none of the change
  const committed = await commitTask(p.machine.shell(held.tree), { tree: held.tree, taskId: task.id, message: commitMessage({ ...held, ref: issueRefOf(held) }, made, task, by, minor, unproven), gitRuns: held.gitRuns })

  // An errand is the whole issue in one change: none at all means it was built somewhere else, or not at all
  if (committed.kind === 'clean' && held.kind === 'errand') {
    const why = `${by} left no change in ${held.tree} for ${ref}: it is not done. Look at what it says it built, then send it again.`

    await stop(p, held, why)

    return why
  }

  if (committed.kind === 'refused') {
    await stop(p, held, committed.why)

    return committed.why
  }

  // A task that needed no change is done with no commit
  const sha = committed.kind === 'committed' ? committed.sha : ''
  // What the pull request says of the task: how long it took, what it changed beyond its files, what its builder left undone
  const written = sha === '' ? [] : (await gitAt(p, ['show', '--name-only', '--format=', sha], held.tree)).out.split('\n').map(one => one.trim()).filter(one => one !== '')
  const outside = written.filter(file => !task.files.includes(file))
  const unticked = untickedOf(out.answer)
  const told = { took: Math.max(p.clock.now() - out.at, 0), ...(outside.length > 0 ? { outside } : {}), ...(unticked.length > 0 ? { unticked } : {}) }

  // A lane's commit is its run's once it lands on the run's branch
  if (held.lane !== undefined) return land(p, ref, { taskId: task.id, title: task.title, sha, by, minor: [...minor], unproven: [...unproven], answer: out.answer, proof: held.proofLine, ...told, ...(out.isPutBefore === true ? { isPutBefore: true } : {}) })

  await mark(p, held, task.id, 'done')

  const after = await p.runs.keep(ref, was => ({ ...was, phase: 'ready', current: null, testsToPass: null, proof: '', proofLine: '', verdictLine: '', unproven: [], isBranchReviewed: false, commits: [...was.commits, { taskId: task.id, title: task.title, sha, by, ...told, minor: [...minor], unproven: [...unproven], answer: out.answer, proof: was.proofLine, ...(out.isPutBefore === true ? { isPutBefore: true } : {}) }] }))
  const left = after === null ? made : await workOf(p, after)
  const isArrived = typeof left !== 'string' && isAllDone(left)
  const said = `Task ${task.id} of ${ref}, "${task.title}", built by ${by}, passed verification and is committed${sha === '' ? ' (it changed nothing, so it is marked done with no commit)' : ` as ${sha.slice(0, 7)}`}.`

  if (isArrived || after?.isAuto === true) await p.board.want(ref, 'next')
  else await p.board.tell(`${said} The next task waits for you.`)

  return said
}

// One landing at a time: each lane lands on its run's branch as the one before left it
export const oneLanding = inTurn()

/**
 * Lands a lane's commit on its run's branch: as it is, where nothing landed there since the lane started; else taken
 * onto what landed, and proved there again before it lands, or, where it no longer applies, sent back to its builder to
 * resolve. Once the run's branch holds it, its task is done, and the lane is cleared. Answers what was done.
 */
export function land(p: Ports, ref: string, commit: RunCommit): Promise<string> {
  return oneLanding(() => landNow(p, ref, commit))
}

export async function landNow(p: Ports, ref: string, commit: RunCommit): Promise<string> {
  const held = await p.runs.at(ref)
  const quest = held?.lane === undefined ? null : await p.runs.at(held.lane.of)

  if (held === null || held.current === null) return 'There is nothing to land.'

  if (quest === null) {
    const why = `The run ${issueRefOf(held)} this lane builds for is under way no more: abandon the lane.`

    await stop(p, held, why)

    return why
  }

  const landing = await landLane(p.machine.shell(held.tree), p.machine.shell(quest.tree), { taskId: commit.taskId, sha: commit.sha, branch: quest.branch, laneTree: held.tree, questTree: quest.tree })

  if (landing.kind === 'stop') {
    await stop(p, held, landing.why)

    return landing.why
  }
  if (landing.kind === 'conflicts') return conflicted(p, held, quest, landing.onto, commit)
  if (landing.kind === 'rebased') return reproved(p, held, quest, landing.onto, commit)

  const landed = { ...commit, sha: landing.sha }

  await mark(p, quest, commit.taskId, 'done')

  const after = await p.runs.keep(quest.ref, was => ({ ...was, isBranchReviewed: false, commits: [...was.commits, landed] }))
  const left = after === null ? null : await workOf(p, after)
  const uncleared = await clearLane(p, held)
  const said = `Task ${commit.taskId} of ${quest.ref}, "${commit.title}", built by ${commit.by} in a lane, passed verification and landed on ${quest.branch}${landed.sha === '' ? ' (it changed nothing, so it is marked done with no commit)' : ` as ${landed.sha.slice(0, 7)}`}.${uncleared}`

  await p.board.say(quest.ref, said)
  if ((left !== null && typeof left !== 'string' && isAllDone(left)) || quest.isAuto) await p.board.want(quest.ref, 'next')
  else await p.board.tell(`${said} The next task waits for you.`)

  return said
}

/**
 * Where a lane's change no longer applies on its run's branch: the lane is put on that branch as it stands, the change
 * applied on it with git's conflict markers where the two meet, and its builder sent back to resolve them; where it
 * cannot be reached, the lane stops for the person. Answers what was done.
 */
export async function conflicted(p: Ports, held: Run, quest: Run, onto: string, commit: RunCommit): Promise<string> {
  const sha = commit.sha
  const applied = await applyAfresh(p.machine.shell(held.tree), onto, sha)
  const out = held.current

  if (out === null) return 'There is nothing to land.'

  const after = await p.runs.keep(held.ref, was => ({ ...was, proof: '', proofLine: '', verdictLine: '', current: { ...out, head: onto, isRebased: false, answer: '' } }))

  if (after === null) return 'There is nothing to land.'

  if (applied.kind === 'applies') return reproved(p, held, quest, onto, commit)

  if (applied.kind === 'failed') {
    const why = `Task ${out.taskId} could not be taken onto ${quest.branch}, which moved while it was built: ${applied.why}. Its change is ${sha.slice(0, 7)}: apply it in ${held.tree} by hand, then put it up for verification.`

    await stop(p, after, why)

    return why
  }

  const files = applied.files

  if (await p.agents.sendBack(out.agentId, out.builder, conflictPrompt(quest.branch, files))) {
    await p.runs.keep(held.ref, was => ({ ...was, phase: 'building', current: was.current === null ? null : { ...was.current, isResumed: true } }))

    const said = `Task ${out.taskId} conflicts with what landed on ${quest.branch} (${files.join(', ')}): ${BUILDERS[out.builder].title} is sent back to resolve it.`

    await p.board.say(held.ref, said)

    return said
  }

  const why = `Task ${out.taskId} conflicts with what landed on ${quest.branch} (${files.join(', ')}), and ${BUILDERS[out.builder].title} could not be sent back: its change is in ${held.tree} with git's conflict markers. Resolve them there, then put it up for verification.`

  await stop(p, after, why)

  return why
}

/** A lane's change standing uncommitted on what landed on its run's branch: proved there again, and landed as it passed. */
export async function reproved(p: Ports, held: Run, quest: Run, onto: string, commit: RunCommit): Promise<string> {
  const out = held.current

  if (out === null) return 'There is nothing to land.'

  await p.runs.keep(held.ref, was => ({ ...was, phase: 'proving', proof: '', proofLine: '', current: { ...out, head: onto, isRebased: true, minor: commit.minor } }))
  await p.board.want(held.ref, 'prove')

  const said = `${quest.branch} moved while task ${commit.taskId} was built: its change is taken onto it, and proved there again before it lands.`

  await p.board.say(held.ref, said)

  return said
}

/** Clears a lane once it landed: its worktree removed, its branch deleted, and the lane forgotten. Says what could not be cleared. */
export async function clearLane(p: Ports, held: Run): Promise<string> {
  const root = await p.machine.root()
  // What is left in it is what the mods kept there (the recorder's runs, verify's trees): its change is landed
  const left = (await gitAt(p, ['status', '--porcelain', ...UNMODDED], held.tree)).out
  const removed = left === '' ? await p.machine.removeTree(root, held.tree) : { ok: false, out: `it holds changes that did not land (${left.split('\n')[0] ?? ''})` }
  const deleted = removed.ok ? await gitAt(p, ['branch', '-D', held.branch], root) : { ok: true, out: '' }

  await p.runs.drop(held.ref)
  await p.board.forget(held.ref)

  return removed.ok && deleted.ok ? '' : ` Its lane is not cleared: ${removed.ok ? `${held.branch} could not be deleted: ${deleted.out}` : `${held.tree} is left: ${removed.out}`}.`
}

/** Puts a stuck task's change up for verification again: proved, judged, and committed once the reviewers pass it. */
export async function resubmit(p: Ports, ref: string): Promise<string> {
  const held = await p.runs.at(ref)

  if (held === null) return HOW_TO
  if (held.current === null || held.phase !== 'stuck') return `There is nothing to put up for verification: the run on ${ref} is ${held.phase}.`

  // The person puts it there having looked: git's config as it now stands is theirs
  const gitRuns = await gitRunsOf(p.machine.shell(held.tree))

  await p.runs.keep(ref, was => ({ ...was, phase: 'proving', gitRuns, current: was.current === null ? null : { ...was.current, isPutBefore: true } }))
  await p.board.want(ref, 'prove')

  return `Task ${held.current.taskId}'s change goes up for verification: it is proved, judged by the reviewers, and committed once they pass it.`
}

/**
 * A commit as its branch holds it: the one recorded, while the branch holds it, else, where it was rewritten since (an
 * amended commit lives on outside its branch), the one that names its comment.
 */
export async function landedSha(p: Ports, tree: string, sha: string, task: RunTask): Promise<string> {
  if (sha !== '' && (await gitAt(p, ['merge-base', '--is-ancestor', sha, 'HEAD'], tree)).ok) return sha
  if (task.url === undefined || task.url === '') return sha

  const found = (await gitAt(p, ['log', '-n', '1', '--format=%H', '--fixed-strings', `--grep=${task.url}`], tree)).out.split('\n')[0] ?? ''

  return found !== '' ? found : sha
}
