import type { BuilderName, CurrentTry, Run, RunCommit, RunKind, RunPhase, TestsToPass } from '../../types'
import { refOf } from '../forge'
import type { ForgeKind, NewRequest } from '../forge'
import { BUILDERS } from './builders'
import { MARK, tally } from './work'
import type { Plan, Task, Spend } from './work'
import { numberOf } from './prompts'
import type { RunOf } from './prompts'

// What a run writes for people: its commits, its pull request, and the run as Claude and the panes read it.

/** The trailer each commit a builder's change is committed with ends with, and each pull request. */
export const COMMIT_TRAILER = 'Co-Authored-By: Claude <noreply@anthropic.com>'

export const PR_TRAILER = '🤖 Generated with [Claude Code](https://claude.com/claude-code)'

/** A comment's first line, short: what a review commit is named by. */
export const firstLine = (body: string): string => {
  const line = body.split('\n').find(one => one.trim() !== '' && !one.startsWith('---'))?.trim() ?? 'a review comment'

  return line.length > 60 ? `${line.slice(0, 57).trimEnd()}…` : line
}

/** The message a task is committed with. */
export const commitMessage = (quest: RunOf, plan: Plan, task: Task, by: string, minor: readonly string[] = [], unproven: readonly string[] = []): string => {
  const number = numberOf(quest.ref)
  const head =
    quest.kind === 'review'
      ? [`Review: ${firstLine(task.brief ?? task.title)}`, '', `Answers ${task.author ?? 'a reviewer'}'s comment${task.where !== undefined && task.where !== '' ? ` on ${task.where}` : ''} on ${quest.ref.replace(/^review:/, '')}${task.url !== undefined && task.url !== '' ? ` (${task.url})` : ''}, built by ${by}, proven and reviewed.`]
      : quest.kind === 'errand'
        ? [`${number === undefined ? quest.ref : `#${number}`}: ${quest.title}`, '', `The whole of ${quest.url !== '' ? quest.url : quest.ref} as an errand, built by ${by}, proven and reviewed.`]
        : [
            `${number === undefined ? plan.ref : `#${number}`}: ${task.title}`,
            '',
            `Task ${task.id} of the plan for ${plan.url !== '' ? plan.url : plan.ref}, built by ${by}, proven and reviewed.`,
            ...(task.acceptance !== '' ? ['', `Done when: ${task.acceptance}`] : []),
          ]

  return [
    ...head,
    ...(minor.length > 0 ? ['', 'Minor findings of the reviewers, left as they are:', ...minor] : []),
    ...(unproven.length > 0 ? ['', `Not proven by verify, which has no handler for ${unproven.join(', ')}: judged by the reviewers alone.`] : []),
    '',
    COMMIT_TRAILER,
  ].join('\n')
}

/** What closes the issue from the pull request, on either forge. */
export const closingLine = (ref: string): string => {
  const issue = refOf(ref)

  return issue === undefined ? '' : `Closes ${issue.repo}#${issue.number}`
}

/**
 * How an errand's pull request opens: its builder's account, then the proof. Where the person put the change
 * up for verification after the builder was back, the account came before the proof, and may tell of a failure since
 * mended: it is said so.
 */
export const errandOpening = (last: Run['commits'][number] | undefined): string[] => {
  const answer = (last?.answer ?? '').trim()
  const proof = (last?.proof ?? '').trim()

  if (last === undefined) return []
  if (last.isPutBefore === true) return [...(answer !== '' ? [answer, ''] : []), `${last.by}'s account above was written before its change was proven: the person put it up for verification, whose proof says: ${proof !== '' ? proof : 'nothing'}.`, '']

  return [...(answer !== '' ? [answer, ''] : []), ...(proof !== '' ? [`The the proof: ${proof}.`, ''] : [])]
}

/** A task's lines in a pull request: its commit, who built it and how long it took, then what it changed beyond its files and left unticked. */
export const taskLines = (one: RunCommit): string[] => [
  `- ${one.sha === '' ? 'no change' : one.sha.slice(0, 7)} ${one.taskId}. ${one.title} (${one.by}${one.took !== undefined ? `, ${Math.max(1, Math.round(one.took / 60_000))} min` : ''})`,
  ...((one.outside ?? []).length > 0 ? [`  - changed beyond its files: ${(one.outside ?? []).join(', ')}`] : []),
  ...((one.unticked ?? []).length > 0 ? [`  - left unticked: ${(one.unticked ?? []).join('; ')}`] : []),
]

/** What a run's work holds that was not built, and why: a task handed back to the person, with what it said. */
export const notBuilt = (plan: Plan): string[] => plan.tasks.filter(task => task.state === 'asked').map(task => `- ${task.id}. ${task.title}: handed back${task.note !== undefined && task.note !== '' ? `, ${task.note}` : ''}`)

export const prBody = (quest: Pick<Run, 'kind' | 'ref' | 'commits'>, plan: Plan, spent = ''): string =>
  [
    // An errand's pull request opens on what its builder said of the change, and on what verify proved of it
    ...(quest.kind === 'errand' ? errandOpening(quest.commits.at(-1)) : []),
    ...(plan.summary !== '' ? [plan.summary, ''] : []),
    ...(plan.approach !== '' ? [plan.approach, ''] : []),
    ...(quest.kind === 'plan' ? ['## Tasks', '', ...quest.commits.flatMap(taskLines)] : []),
    ...(quest.kind === 'errand' ? quest.commits.flatMap(one => [...(one.outside ?? []).length > 0 ? [`Changed beyond the files the issue named: ${(one.outside ?? []).join(', ')}.`, ''] : [], ...((one.unticked ?? []).length > 0 ? ['Left unticked by its builder:', ...(one.unticked ?? []).map(item => `- ${item}`), ''] : [])]) : []),
    ...(notBuilt(plan).length > 0 ? ['', '## Not built', '', ...notBuilt(plan)] : []),
    ...((plan.alone ?? []).length > 0
      ? ['', '## Decided without the person', '', 'This run went on by itself: what it decided that the person was not asked, for them to check.', '', ...(plan.alone ?? []).map(one => `- ${one}`)]
      : []),
    ...(quest.commits.some(one => one.minor.length > 0)
      ? ['', '## Minor findings', '', 'What the reviewers found and let pass:', '', ...quest.commits.flatMap(one => one.minor.map(line => `${line.replace(/^- /, `- task ${one.taskId}: `)}`))]
      : []),
    ...(quest.commits.some(one => (one.unproven ?? []).length > 0)
      ? ['', '## Not proven', '', 'What no integration test proves, for verify has no handler for it: the reviewers judged it alone.', '', ...quest.commits.filter(one => (one.unproven ?? []).length > 0).map(one => `- task ${one.taskId}: ${(one.unproven ?? []).join(', ')}`)]
      : []),
    ...(spent !== '' ? ['', '## Spent', '', spent] : []),
    '',
    quest.kind === 'errand' ? 'Built as an errand by the build, proven and reviewed.' : 'Planned by the planner, built task by task by the build, each change proven and reviewed.',
    '',
    closingLine(quest.ref),
    '',
    PR_TRAILER,
  ].join('\n')

/** The pull request that closes a run's issue, from its branch onto its base, and the forge it is opened on. */
export const requestOf = (quest: Pick<Run, 'kind' | 'ref' | 'branch' | 'base' | 'commits'>, plan: Plan, spent = ''): { forge: ForgeKind; request: NewRequest } => ({
  forge: refOf(plan.ref)?.forge ?? 'github',
  request: { branch: quest.branch, base: quest.base, title: plan.title, body: prBody(quest, plan, spent) },
})

export const KIND_LINE: Record<RunKind, string> = { plan: 'plan', errand: 'errand', review: 'review' }

/** A run in a line: what it is, where it stands, and on what branch. */
export const runLine = (quest: Run, plan: Plan | null): string =>
  `${quest.ref} (${KIND_LINE[quest.kind]}), "${quest.title}"${plan === null ? '' : ` (${tally(plan)})`}: ${quest.phase}${quest.isAuto ? ', going on by itself' : ''}, on ${quest.branch} from ${quest.base}`

/**
 * The turns of the record counted to a run: those of every agent sent for its issue (the planner that planned it, an
 * earlier run on it), and those of agents sent with no issue named into its worktree (the reviewers). An agent in the
 * project's own folder that names no issue is no run's.
 */
export const spentOn = (quest: Pick<Run, 'ref' | 'tree'>, root: string, turns: readonly Spend[]): Spend[] =>
  turns.filter(one => one.ref === quest.ref || (one.ref === undefined && quest.tree !== root && one.tree === quest.tree))

/** The run in full, for Claude, and what its agents cost where any was counted to it. */
export const runText = (quest: Run, plan: Plan | null, cost = ''): string =>
  [
    `The build's run on ${runLine(quest, plan)}.`,
    `It is built in ${quest.tree}.`,
    // A stuck run keeps its march, to be sent again, but its builder is out no more
    ...(quest.current !== null ? [`${BUILDERS[quest.current.builder].title} ${quest.phase === 'stuck' ? 'is back from' : 'is on'} task ${quest.current.taskId}, "${quest.current.title}" (try ${quest.current.attempt}).`] : []),
    ...(quest.phase === 'writing-tests' ? [`The test writer writes the tests of task ${quest.testsFor ?? ''} first.`] : []),
    ...(quest.testsToPass !== undefined && quest.testsToPass !== null && quest.testsToPass.tests.length > 0 ? [`The tests written first showed ${quest.testsToPass.tests.length} red ${quest.testsToPass.tests.length === 1 ? 'test' : 'tests'} for task ${quest.testsToPass.taskId}: ${quest.testsToPass.tests.map(test => test.name).join(', ')}.`] : []),
    ...(quest.proofLine !== '' ? [`Last proof: ${quest.proofLine}.`] : []),
    ...(quest.verdictLine !== '' ? [`The reviewers: ${quest.verdictLine}.`] : []),
    ...(plan === null
      ? []
      : [
          '',
          ...plan.tasks.map(
            task =>
              `${MARK[task.state]} ${task.id}. ${task.title}${task.dependsOn.length > 0 ? ` (after ${task.dependsOn.join(', ')})` : ''}${quest.commits.find(one => one.taskId === task.id) !== undefined ? ` · ${quest.commits.find(one => one.taskId === task.id)?.sha.slice(0, 7) || 'no change'}` : ''} [${task.weight}]${task.note !== undefined && task.note !== '' ? ` · ${task.note}` : ''}`,
          ),
        ]),
    ...(quest.pr !== '' ? ['', `Pull request: ${quest.pr}`] : []),
    ...(cost !== '' ? ['', cost] : []),
  ].join('\n')

// What a run kept in the store before the build was renamed called its phases, its builders and some of its fields
export const OLD_PHASES: Record<string, RunPhase> = { gazing: 'writing-tests', marching: 'building', judging: 'reviewing', arrived: 'built', warding: 'reviewing-branch', sailed: 'submitted' }

export const OLD_BUILDERS: Record<string, BuilderName> = { gandalf: 'builder-last', aragorn: 'builder-heavy', legolas: 'builder-frontend', gimli: 'builder-service', boromir: 'builder-cli', frodo: 'builder-light-1', samwise: 'builder-light-2', merry: 'builder-light-3', pippin: 'builder-light-4' }

/**
 * A run as the store kept it, in this build's names: one kept before the rename has its phase and its builder by
 * their old names, and `march`, `vision`, `gazed` and `isWarded` for `current`, `testsToPass`, `testsFor` and
 * `isBranchReviewed`. Nothing for what is no run.
 */
export const runFromStore = (kept: unknown): Run | undefined => {
  if (kept === null || typeof kept !== 'object') return undefined

  const { march, vision, gazed, isWarded, ...rest } = kept as Run & { march?: unknown; vision?: TestsToPass | null; gazed?: number; isWarded?: boolean }
  const was = (rest.current ?? march ?? null) as (CurrentTry & { member?: string }) | null
  const { member, ...current } = was ?? ({} as CurrentTry & { member?: string })
  const builder = was === null ? undefined : (OLD_BUILDERS[String(current.builder ?? member)] ?? current.builder)

  return {
    ...rest,
    phase: OLD_PHASES[rest.phase] ?? rest.phase,
    current: was === null || builder === undefined ? null : { ...current, builder },
    ...(rest.testsToPass === undefined && vision !== undefined ? { testsToPass: vision } : {}),
    ...(rest.testsFor === undefined && gazed !== undefined ? { testsFor: gazed } : {}),
    ...(rest.isBranchReviewed === undefined && isWarded !== undefined ? { isBranchReviewed: isWarded } : {}),
  }
}
