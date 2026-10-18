import type { Run, RunPhase, RunWork } from '../../types'
import { gitRunsOf } from '../git'
import { runCommands, setupOf, verificationOf } from '../verification'
import { restingPhase } from '../phases'
import { HOW_TO, branchOf, errandTask, isAllDone, ownPlan, parsePlan, parseWorktrees, tally, unsettledOf } from '../run'
import { FETCH_TIMEOUT_MS, gitAt, ranAt } from './ports'
import type { Ports, Spec } from './ports'
import { conflicted } from './commit'

// A run set out: its base, its worktree, and the first steps of a plan, an errand or a review.

/** The branch the person's checkout is on, else the remote's default, else main: what a run starts from. */
export async function baseOf(p: Ports, root: string, branch: string): Promise<string> {
  const current = await gitAt(p, ['rev-parse', '--abbrev-ref', 'HEAD'], root)

  if (current.ok && current.out !== '' && current.out !== 'HEAD' && current.out !== branch) return current.out

  const found = await gitAt(p, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], root)

  return found.ok && found.out !== '' ? found.out.replace(/^origin\//, '') : 'main'
}

/**
 * Where a run is built: the folder its branch is checked out in already (a worktree, or the person's own checkout),
 * else a worktree made for it under .theseus/trees, its branch made from its base when there is none. A review's
 * branch is the pull request's, fetched from the forge. Answers why there is none where it could not be made.
 */
export async function placeTree(p: Ports, branch: string, base: string | undefined, isFetched: boolean): Promise<{ tree: string; base: string; isNew?: true } | string> {
  const root = await p.machine.root()
  const from = base ?? (await baseOf(p, root, branch))
  const at = parseWorktrees((await gitAt(p, ['worktree', 'list', '--porcelain'], root)).out).find(one => one.branch === branch)

  if (at !== undefined) return { tree: at.path, base: from }

  const tree = p.machine.treePath(root, branch)

  // The folder ignores itself: no run's worktree is part of the project's checkout
  await p.machine.write(`${root}/.theseus/.gitignore`, '*\n')

  const fetched = isFetched ? await ranAt(p, ['git', 'fetch', 'origin', branch], FETCH_TIMEOUT_MS, root) : undefined
  const exists = await gitAt(p, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], root)

  // A review's branch lives on origin; one that is not there is a fork's, which the build cannot push to
  if (fetched !== undefined && !fetched.ok && !exists.ok) return `${branch} could not be fetched from origin (${fetched.out || 'git said nothing'}): a pull request from a fork is not answered here, as its branch cannot be pushed to from this repository.`

  const added = await gitAt(p, exists.ok || isFetched ? ['worktree', 'add', tree, branch] : ['worktree', 'add', '-b', branch, tree, from], root)

  return added.ok ? { tree, base: from, isNew: true } : `The worktree of ${branch} could not be made at ${tree}: ${added.out}`
}

/**
 * Takes in what its base gained since the run left it, so the tasks still to come are built on it and its pull
 * request does not fall into conflict. A worktree with work in it is only said to be behind; a merge that conflicts is
 * taken back. Answers what stops the run, or undefined when it may go on.
 */
export async function followBase(p: Ports, held: Run): Promise<string | undefined> {
  // A review is built on the pull request's own branch, which its author keeps
  if (held.kind === 'review' || held.base === '') return undefined

  const fetched = await ranAt(p, ['git', 'fetch', 'origin', held.base], FETCH_TIMEOUT_MS, held.tree)
  const upstream = fetched.ok ? `origin/${held.base}` : held.base

  if ((await gitAt(p, ['merge-base', '--is-ancestor', upstream, 'HEAD'], held.tree)).ok) return undefined

  if ((await gitAt(p, ['status', '--porcelain'], held.tree)).out !== '') {
    await p.board.say(held.ref, `${held.branch} is behind ${upstream}, but its worktree holds a change: it is taken in once the change is committed.`)

    return undefined
  }

  const merged = await gitAt(p, ['merge', '--no-edit', upstream], held.tree)

  if (merged.ok) {
    // The merge is no builder's commit: a task sent again after it is judged against HEAD as it now stands
    await p.runs.keep(held.ref, was => ({ ...was, current: was.current === null ? null : { ...was.current, head: '' } }))
    await p.board.say(held.ref, `${held.branch} took in what ${upstream} gained since it left it.`)

    return undefined
  }

  const conflicted = (await gitAt(p, ['diff', '--name-only', '--diff-filter=U'], held.tree)).out.split('\n').filter(line => line !== '')

  await gitAt(p, ['merge', '--abort'], held.tree)

  return `${held.branch} cannot take in ${upstream}: it conflicts in ${conflicted.join(', ') || 'the tree'}. Merge it in ${held.tree} by hand, then go on.`
}

/**
 * Sets a run out, or takes it up where it was left: in its worktree, its first task sent by the clock, outside the
 * call that asked. Answers what was done, in a sentence.
 */
export async function begin(p: Ports, spec: Spec, made: RunWork): Promise<string> {
  const held = (await p.runs.at(spec.ref)) ?? (await p.runs.stored(spec.ref)) ?? null

  if (held !== null && held.phase !== 'submitted' && (held.kind ?? 'plan') !== spec.kind) return `The build is on ${spec.ref} already, as ${held.kind === 'errand' ? 'an errand' : `a ${held.kind}`} (${held.phase}): finish or abandon it first.`

  const resumed = held !== null && held.phase !== 'submitted' ? held : undefined
  const branch = resumed?.branch ?? spec.branch
  // A review answers on the branch of a run that may be kept still: its commands prove the answers too
  const built = spec.kind === 'review' ? (await p.runs.all()).find(one => one.kind !== 'review' && one.branch === spec.branch) : undefined
  const checks = [...(resumed?.checks ?? spec.checks ?? built?.checks ?? [])]
  const setup = [...(resumed?.setup ?? spec.setup ?? built?.setup ?? [])]

  // Where the project names no target, the commands its plan or its issue states are the proof: with none, nothing
  // could prove a task. A review is the pull request's, which states none: it starts, and its proof says so
  if (spec.kind !== 'review' && checks.length === 0 && (await p.parts.targetsKnown()).length === 0) return noProofFor(spec)

  const placed = await placeTree(p, branch, resumed?.base ?? spec.base, spec.kind === 'review')

  if (typeof placed === 'string') return placed

  // A fresh worktree holds what git tracks alone: what it needs besides is put there first, as the plan or the issue says
  if (placed.isNew === true && setup.length > 0) {
    const ready = await runCommands(p.machine.shell(placed.tree), setup)

    if (!ready.ok) return `The worktree ${placed.tree} could not be set up: \`${ready.command}\` failed (exit ${ready.exitCode}).\n\n${ready.output}`
  }

  // A run left mid-march has no builder out any more, and the reviewers no longer judge its whole branch: the person
  // sends it again, or is submitted again
  const was = resumed?.phase
  const phase: RunPhase = was === undefined ? 'ready' : restingPhase(was)
  // A review handed over again brings the comments that came since: those already taken up keep where they stand. An
  // errand taken up again is the one task it was
  const tasks =
    spec.kind === 'plan'
      ? undefined
      : spec.kind === 'errand' && resumed?.tasks !== undefined && resumed.tasks.length > 0
        ? resumed.tasks
        : [
            // A comment taken up already keeps where it stands, and gains the thread it was handed over without
            ...(resumed?.tasks ?? []).map(task => ({ ...task, ...(task.thread === undefined ? { thread: (spec.tasks ?? []).find(one => one.url !== undefined && one.url === task.url)?.thread } : {}) })),
            ...(spec.tasks ?? []).filter(task => !(resumed?.tasks ?? []).some(one => one.url !== undefined && one.url === task.url)),
          ].map((task, at) => ({ ...task, id: at + 1 }))
  const work = tasks === undefined ? made : { ...made, tasks }
  const quest: Run = {
    kind: spec.kind,
    ref: spec.ref,
    url: spec.url,
    title: spec.title,
    branch,
    base: placed.base,
    tree: placed.tree,
    ...(tasks !== undefined ? { tasks } : {}),
    isAuto: spec.isAuto,
    // Every task behind it, it has built; a review handed over again with new comments has more to build
    phase: isAllDone(work) ? (phase === 'ready' || phase === 'stuck' ? 'built' : phase) : phase === 'built' ? 'ready' : phase,
    current: resumed?.current ?? null,
    proof: resumed?.proof ?? '',
    proofLine: resumed?.proofLine ?? '',
    verdictLine: resumed?.verdictLine ?? '',
    testsToPass: resumed?.testsToPass ?? null,
    testsFor: resumed?.testsFor,
    commits: resumed?.commits ?? [],
    pr: resumed?.pr ?? spec.pr ?? '',
    gitRuns: resumed?.gitRuns ?? (await gitRunsOf(p.machine.shell(placed.tree))),
    ...(checks.length > 0 ? { checks } : {}),
    ...(setup.length > 0 ? { setup } : {}),
    at: resumed?.at ?? p.clock.now(),
  }

  await p.runs.put(quest, work)
  await p.board.show(spec.ref)
  await p.board.say(spec.ref, '')

  // A run taken up again first takes in what its base gained meanwhile: the tasks still to come are built on it
  const behind = resumed !== undefined ? await followBase(p, quest) : undefined

  if (behind !== undefined) {
    await p.runs.keep(spec.ref, was => ({ ...was, phase: 'stuck' }))
    await p.board.say(spec.ref, behind)

    return `The build takes up its run on ${spec.ref}, but stops: ${behind}`
  }

  if (quest.phase === 'ready') await p.board.want(spec.ref, 'next')
  if (quest.phase === 'built' && quest.isAuto && quest.kind !== 'review') await p.board.want(spec.ref, 'submit')

  const how =spec.isAuto ? 'going on by itself' : 'stopping after each commit for you'
  const where = placed.tree === (await p.machine.root()) ? 'in your own checkout, where its branch is' : `in its worktree ${placed.tree}`

  return resumed !== undefined
    ? `The build takes up its run on ${spec.ref} (${tally(work)}, ${quest.phase}) on ${branch}, ${where}, ${how}.`
    : `The build starts on ${spec.ref}, "${spec.title}", on ${branch} from ${placed.base}, ${where}, ${how}: the first task is sent.`
}

/** Sets out on the plan in force, or the one of the issue named. */
export async function setOut(p: Ports, isAuto: boolean, ref = ''): Promise<string> {
  const made = parsePlan(await p.parts.planFor(ref))

  if (made === null) return HOW_TO
  if (typeof made === 'string') return made

  const open = unsettledOf(made)

  // An auto run settles what the planner left open itself, and lists it; a risk to cover asks for a revision, which it does not make
  if (open.length > 0 && isAuto && !made.risks.some(risk => risk.wantsTask)) {
    const settled = parsePlan(await p.parts.settleAlone(made.ref))

    if (settled === null || typeof settled === 'string') return `The planner's work on ${made.ref} could not be settled by the run: ${settled ?? 'no plan is kept any more'}.`

    const said = await begin(p, { kind: 'plan', ref: settled.ref, url: settled.url, title: settled.title, branch: branchOf(settled), isAuto, checks: settled.verification ?? [], setup: settled.setup ?? [] }, settled)

    return `${said} It settled alone what the plan left open (${open.join('; ')}): the plan and the pull request list it under "Decided without the person".`
  }

  if (open.length > 0) return `The planner's work on ${made.ref} is not settled: ${open.join('; ')}. Settle them in the planner pane, then start the run${made.risks.some(risk => risk.wantsTask) ? '' : ', or start it auto to have it settle them alone'}.`

  return begin(p, { kind: 'plan', ref: made.ref, url: made.url, title: made.title, branch: branchOf(made), isAuto, checks: made.verification ?? [], setup: made.setup ?? [] }, made)
}

/**
 * Sets out on an issue as an errand: one task, the whole issue, read through the planner. One opened from outside the
 * repository is built only when the person asked for it themselves (`isPersons`): Claude's call may have been steered.
 */
export async function errand(p: Ports, input: string, isAuto: boolean, isPersons: boolean): Promise<string> {
  const issue = await p.parts.readIssue(input)

  if ('error' in issue) return issue.error
  if (issue.isOutside && !isPersons) return `${issue.ref} was opened by ${issue.author || 'someone'}, from outside the repository (or the forge could not say who can push to it): only the person starts on it, with /theseus build errand ${issue.ref} or from the issues pane (/theseus issues).`

  const task = errandTask(issue)
  const spec: Spec = { kind: 'errand', ref: issue.ref, url: issue.url ?? '', title: issue.title ?? '', branch: branchOf({ ref: issue.ref, title: issue.title ?? '' }), isAuto, tasks: [task], checks: verificationOf(issue.body ?? ''), setup: setupOf(issue.body ?? '') }

  return begin(p, spec, ownPlan(spec))
}

/** Why a run is not started where nothing could prove its tasks. */
export const noProofFor = (spec: Spec): string =>
  [
    `${spec.ref} is not started: the project names no target in .claude/theseus.toml, and ${spec.kind === 'plan' ? 'its plan states' : 'the issue states'} no verification command, so nothing could prove its tasks.`,
    spec.kind === 'plan'
      ? 'Have the planner plan it again: it names the commands that check the change (its tests, its linter). Or name what the project builds in .claude/theseus.toml (/theseus init proposes it).'
      : 'Add a `## Verification` section to the issue, a command a line (its tests, its linter), and `## Setup` for what a fresh worktree needs. Or name what the project builds in .claude/theseus.toml (/theseus init proposes it).',
  ].join(' ')
