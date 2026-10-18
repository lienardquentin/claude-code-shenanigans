import type { Run } from '../../types'
import { forgeOfUrl, refOf } from '../forge'
import { leakOf } from '../git'
import { errorText } from '../kit'
import { HOW_TO, BUILDERS, WARDING, afterWard, issueRefOf, parseJudgement, requestOf, wardModelFor, wardPurpose, whyNotSail } from '../run'
import { OUT, gitAt, pushAt, openAt, workOf, lastLineOf } from './ports'
import type { Ports } from './ports'
import { followBase } from './start'
import { lanesOf } from './send'
import { landedSha } from './commit'

// A built run submitted (its whole branch judged, pushed, its pull request opened or its review answered), or abandoned.

/** What a run that is out waits on before it may be abandoned; nothing when it waits on nothing. */
export const waitBeforeAbandon = (held: Run): string | undefined =>
  OUT.includes(held.phase)
    ? `The run on ${held.ref} is ${held.phase}: wait until ${held.phase === 'writing-tests' ? 'the test writer has shown the tests' : held.phase === 'reviewing' || held.phase === 'reviewing-branch' ? 'the reviewers have judged' : held.phase === 'proving' ? 'the proof is made' : `${held.current === null ? 'the builder' : BUILDERS[held.current.builder].title} is back`}, then abandon it.`
    : undefined

/** A worktree of the run's own, not the person's checkout; nothing for a run built where the person works. */
export const ownTreeOf = (held: Run, root: string): string | undefined => (held.tree !== undefined && held.tree !== '' && held.tree !== root ? held.tree : undefined)

/**
 * Why a run may not be abandoned yet: it, or a lane of it, is out, or a worktree of theirs holds work that is the
 * person's to keep or drop first. Nothing when it may: what the command says at once, before the clock gives it up.
 */
export async function abandonRefusal(p: Ports, held: Run): Promise<string | undefined> {
  const lanes = held.lane === undefined ? await lanesOf(p, held.ref) : []
  const waiting = [held, ...lanes].map(waitBeforeAbandon).find(one => one !== undefined)

  if (waiting !== undefined) return waiting

  const root = await p.machine.root()

  for (const one of [...lanes, held]) {
    const tree = ownTreeOf(one, root)

    if (tree !== undefined && (await gitAt(p, ['status', '--porcelain'], tree)).out !== '') return `${tree} holds uncommitted changes: commit, stash or drop them there, then abandon the run.`
  }

  return undefined
}

/**
 * Gives a run up: its worktree removed, its own branch deleted (a review's is the pull request's, and is left), a
 * plan's tasks reopened in the planner, and the run forgotten here and across sessions. Nothing on the forge is touched.
 */
export async function abandon(p: Ports, ref: string): Promise<string> {
  const held = (await p.runs.at(ref)) ?? (await p.runs.stored(ref)) ?? null

  if (held === null) return `No run on ${ref} is kept: there is nothing to abandon.`

  const lanes = held.lane === undefined ? await lanesOf(p, ref) : []
  const refused = await abandonRefusal(p, held)

  if (refused !== undefined) return refused

  // Its lanes are given up first: each is a task of it, in a worktree of its own
  for (const lane of lanes) {
    const said = await abandon(p, lane.ref)

    if ((await p.runs.at(lane.ref)) !== null) return `The run on ${ref} is not abandoned, as its lane on task ${lane.lane?.taskId ?? ''} is not: ${said}`
  }

  const root = await p.machine.root()
  const isOwnTree = ownTreeOf(held, root) !== undefined
  const said: string[] = [`The run on ${ref} is abandoned.`]

  if (isOwnTree) {
    const removed = await gitAt(p, ['worktree', 'remove', held.tree], root)

    if (!removed.ok) return `The worktree ${held.tree} could not be removed: ${removed.out}`
    said.push(`Its worktree is removed.`)
  }

  if (held.kind !== 'review' && isOwnTree) {
    const exists = await gitAt(p, ['rev-parse', '--verify', '--quiet', `refs/heads/${held.branch}`], root)
    const deleted = exists.ok ? await gitAt(p, ['branch', '-D', held.branch], root) : { ok: true, out: '' }

    said.push(deleted.ok ? (exists.ok ? `${held.branch} is deleted, with its ${held.commits.length} ${held.commits.length === 1 ? 'commit' : 'commits'}.` : `${held.branch} was already gone.`) : `${held.branch} could not be deleted: ${deleted.out}.`)
  } else if (held.commits.length > 0) said.push(`${held.branch} is left as it is, with its ${held.commits.length} ${held.commits.length === 1 ? 'commit' : 'commits'}.`)

  // The tasks a plan's run took up are open again in the plan, which can be started on as it is; a lane's one task alone
  if (held.kind === 'plan') {
    const made = await workOf(p, held)
    const reopened = typeof made === 'string' ? [] : made.tasks.filter(task => task.state !== 'todo' && (held.lane === undefined || task.id === held.lane.taskId))

    for (const task of reopened) await p.parts.markTask(task.id, 'todo', issueRefOf(held))
    if (reopened.length > 0) said.push(`${reopened.length} ${reopened.length === 1 ? 'task is' : 'tasks are'} open again in the plan.`)
  }

  if (held.pr !== '' && held.kind !== 'review') said.push(`Its pull request, ${held.pr}, is left as it is on the forge.`)

  await p.runs.drop(ref)
  await p.board.unwant(ref)
  await p.board.forget(ref)

  return said.join(' ')
}

/**
 * Answers each review thread whose comment the run took up, once its answers are pushed: one built is told its commit
 * and resolved; one handed back is told why, and left open for the person. A thread is answered once. Says what was done.
 */
export async function answerThreads(p: Ports, ref: string): Promise<string> {
  const held = await p.runs.at(ref)
  const number = Number(/#(\d+)$/.exec(ref)?.[1] ?? NaN)

  if (held === null || !Number.isFinite(number)) return ''

  const forge = p.machine.forge(forgeOfUrl(held.pr !== '' ? held.pr : held.url), held.tree)
  let answered = 0
  let resolved = 0
  const failed: string[] = []

  for (const task of (held.tasks ?? []).filter(one => one.thread !== undefined && one.thread !== '' && one.isAnswered !== true)) {
    const commit = held.commits.find(one => one.taskId === task.id && one.sha !== '')
    const reply = commit !== undefined ? `Answered in ${(await landedSha(p, held.tree, commit.sha, task)).slice(0, 7)} by ${commit.by}.` : task.state === 'asked' ? `Handed back to the author: ${task.note ?? ''}` : undefined

    if (reply === undefined) continue

    const replied = await forge.replyToThread(number, task.thread ?? '', reply)

    // A thread left unanswered is said, and tried again at the next push
    if (replied.exitCode !== 0) {
      failed.push(`task ${task.id} (${lastLineOf(replied) || 'the forge said nothing'})`)
      continue
    }

    answered += 1
    if (commit !== undefined) {
      const done = await forge.resolveThread(number, task.thread ?? '')

      if (done.exitCode === 0) resolved += 1
      else failed.push(`task ${task.id}'s thread is answered but not resolved (${lastLineOf(done) || 'the forge said nothing'})`)
    }
    await p.runs.keep(ref, was => ({ ...was, tasks: (was.tasks ?? []).map(one => (one.id === task.id ? { ...one, isAnswered: true } : one)) }))
  }

  return [
    answered === 0 ? '' : ` ${answered} ${answered === 1 ? 'thread is' : 'threads are'} answered on the pull request, ${resolved} resolved.`,
    failed.length === 0 ? '' : ` Not answered on the forge: ${failed.join('; ')}.`,
  ].join('')
}

/** Pushes the branch and opens the pull request that closes the issue; a review's answers are pushed onto its pull request. */
export async function sail(p: Ports, ref: string): Promise<string> {
  const held = await p.runs.at(ref)

  if (held === null) return HOW_TO
  const unready = whyNotSail(held)

  if (unready !== undefined) return unready

  const made = await workOf(p, held)

  if (typeof made === 'string') return made

  // Nothing that looks like a secret leaves the machine, whoever committed it
  const leak = await leakOf(p.machine.shell(held.tree), held)

  if (leak !== undefined) {
    await p.board.say(ref, leak)

    return leak
  }

  if (held.kind === 'review') {
    await p.board.working(ref, `Pushing ${held.branch}…`)

    const pushed = await pushAt(p, held.branch, held.tree)

    if (!pushed.ok) return `${held.branch} could not be pushed: it may be behind its remote. ${pushed.out.split('\n').slice(-1)[0] ?? ''}`

    await p.runs.keep(ref, was => ({ ...was, phase: was.phase === 'built' ? 'submitted' : was.phase }))

    const told = await answerThreads(p, ref)

    return `${held.branch} is pushed: ${held.commits.length} answered ${held.commits.length === 1 ? 'comment is' : 'comments are'} on ${held.pr}.${told}`
  }

  // What the base gained since is taken in before the branch is judged whole and leaves the machine, so its pull request
  // does not open in conflict. A conflict leaves the run built: once it is merged by hand, it is submitted again
  if (held.isBranchReviewed !== true) {
    const behind = await followBase(p, held)

    if (behind !== undefined) return behind
  }

  // Each task of a plan was judged alone: both reviewers judge what the tasks do and let in together, once, before the
  // branch leaves the machine
  if (held.kind === 'plan' && held.isBranchReviewed !== true) {
    // The branch took in origin's base, just fetched: judged against a local base behind it, the reviewers would judge
    // the commits it took in as the branch's own
    const upstream = (await gitAt(p, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${held.base}`], held.tree)).ok ? `origin/${held.base}` : held.base
    const model = wardModelFor(made, held.commits)
    const judged = parseJudgement(await p.parts.judgementFor(held.tree, { start: true, reviewers: ['reviewer-correctness', 'reviewer-security'], against: upstream, about: wardPurpose(made), ref, ...(model !== undefined ? { model } : {}) }).catch((error: unknown) => errorText(error)))

    await p.runs.keep(ref, was => ({ ...was, phase: 'reviewing-branch', verdictLine: judged.line }))

    return ward(p, ref, judged)
  }

  // A local issue has no forge: the run stands built and reviewed, for the person to push
  if (refOf(held.ref)?.forge === 'local') return `${held.branch} is built and reviewed. Its issue is a local one, with no forge to open a pull request on: push it and open one where the code is kept (git push -u origin ${held.branch}).`

  await p.board.working(ref, `Pushing ${held.branch} and opening the pull request…`)

  // What the run spent is a line of the pull request's body, never a reason to open none
  const { forge, request } = requestOf(held, made, await p.parts.spentOn(held).catch(() => ''))
  const opened = await openAt(p, forge, request, held.tree)

  if (typeof opened !== 'object') return opened

  const url = opened.url

  await p.runs.keep(ref, was => ({ ...was, phase: 'submitted', pr: url }))
  await p.board.tell(`the pull request for ${ref} is open${url === '' ? '' : `: ${url}`}`)

  return `The run is submitted: ${held.branch} is pushed and the pull request that closes ${ref} is open${url === '' ? '' : ` at ${url}`}.`
}

/**
 * What the reviewers' judgement of a plan's whole branch comes to: it is submitted once they pass it; what they find blocking,
 * or a reviewer's silence, stops it for the person. Answers what was done, in a sentence.
 */
export async function ward(p: Ports, ref: string, judged: ReturnType<typeof parseJudgement>): Promise<string> {
  const held = await p.runs.at(ref)

  if (held === null || held.phase !== 'reviewing-branch') return ''
  const step = afterWard(judged, held)

  if (step.kind === 'wait') return step.said

  if (step.kind === 'submit') {
    await p.runs.keep(ref, was => ({ ...was, phase: 'built', isBranchReviewed: true, verdictLine: step.line }))

    return sail(p, ref)
  }

  await p.runs.keep(ref, was => ({ ...was, phase: 'built', isBranchReviewed: false, verdictLine: step.line }))
  await p.board.say(ref, step.why)
  await p.board.tell(step.why.split('\n')[0] ?? step.why)

  return step.why
}

/** Looks at the reviewers' judgement of a plan's whole branch, while they review. */
export async function watchWard(p: Ports, ref: string): Promise<void> {
  const held = await p.runs.at(ref)

  if (held === null) return

  const said = await ward(p, ref, parseJudgement(await p.parts.judgementFor(held.tree).catch((error: unknown) => errorText(error))))

  if (said !== '' && !said.startsWith(WARDING)) await p.board.say(ref, said)
}
