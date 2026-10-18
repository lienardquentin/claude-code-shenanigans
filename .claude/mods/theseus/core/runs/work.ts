import type { BuilderName, SpentTurn, Run, RunCommit, RunTask, RunTaskState, RunWork, TaskWeight, TestsToPass } from '../../types'
import { refOf } from '../forge'
import type { Target } from '../proof'

// A run's work: its plan read from the planner's answer, its tasks, which are ready and which may be built side by
// side, its branch and its lanes.

export type Commit = RunCommit

export type Builder = BuilderName

export type Plan = RunWork

export type Task = RunTask

export type TaskState = RunTaskState

export type Vision = TestsToPass

export type Weight = TaskWeight

export type Spend = SpentTurn

/** A target as a builder is chosen by: the kind of its source and its folders. */
export type TargetFolders = Pick<Target, 'label' | 'kind' | 'roots'>

export const HOW_TO =
  'No run is under way. Plan an issue with /theseus plan <issue>, answer its questions and decide its risks, then /theseus build starts on it (/theseus build --auto goes on by itself). A small issue goes straight to /theseus build errand <issue>; an open pull request\'s review comments, to /theseus follow-up <pr>.'

export const MARK: Record<TaskState, string> = { todo: '○', doing: '◐', done: '●', asked: '?' }

export const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((one): one is string => typeof one === 'string') : [])

export const numbers = (value: unknown): number[] => (Array.isArray(value) ? value.filter((one): one is number => typeof one === 'number') : [])

export const text = (value: unknown): string => (typeof value === 'string' ? value : '')

export const weightOf = (value: unknown): Weight => (value === 'light' || value === 'heavy' ? value : 'standard')

/** A task as a mod hands it over in JSON, every field read as what it should be. */
export const taskOf = (task: Record<string, unknown>): Task => ({
  id: Number(task.id),
  title: text(task.title),
  why: text(task.why),
  steps: strings(task.steps),
  files: strings(task.files),
  dependsOn: numbers(task.dependsOn),
  acceptance: text(task.acceptance),
  weight: weightOf(task.weight),
  ...(task.isUnweighed === true || (task.weight !== 'light' && task.weight !== 'standard' && task.weight !== 'heavy') ? { isUnweighed: true } : {}),
  state: task.state === 'doing' || task.state === 'done' || task.state === 'asked' ? task.state : 'todo',
  ...(typeof task.brief === 'string' ? { brief: task.brief } : {}),
  ...(typeof task.author === 'string' ? { author: task.author } : {}),
  ...(typeof task.where === 'string' ? { where: task.where } : {}),
  ...(typeof task.url === 'string' ? { url: task.url } : {}),
  ...(typeof task.thread === 'string' && task.thread !== '' ? { thread: task.thread } : {}),
  ...(typeof task.note === 'string' && task.note !== '' ? { note: task.note } : {}),
})

/** The plan the planner keeps, or as JSON text: `null` when none is in force, a sentence when the answer is not a plan. */
export const parsePlan = (answer: unknown): Plan | null | string => {
  let held: unknown = answer

  if (typeof answer === 'string') {
    try {
      held = JSON.parse(answer)
    } catch {
      return `The planner answered no plan the build can read: ${answer.trim().slice(0, 200)}`
    }
  }

  if (held === null) return null

  const plan = held as Record<string, unknown>

  if (typeof plan !== 'object' || !Array.isArray(plan.tasks) || typeof plan.ref !== 'string') return 'The planner answered no plan the build can read: it holds no tasks.'

  return {
    ref: plan.ref,
    url: text(plan.url),
    title: text(plan.title),
    summary: text(plan.summary),
    approach: text(plan.approach),
    tasks: (plan.tasks as Record<string, unknown>[]).map(taskOf),
    questions: (Array.isArray(plan.questions) ? (plan.questions as Record<string, unknown>[]) : []).map(one => ({ text: text(one.text), options: strings(one.options), answer: text(one.answer) })),
    decided: (Array.isArray(plan.decided) ? (plan.decided as Record<string, unknown>[]) : []).map(one => ({ text: text(one.text), answer: text(one.answer) })),
    risks: (Array.isArray(plan.risks) ? (plan.risks as Record<string, unknown>[]) : []).map(one => ({
      text: text(one.text),
      severity: one.severity === 'high' || one.severity === 'low' ? one.severity : 'medium',
      mitigation: text(one.mitigation),
      tasks: numbers(one.tasks),
      wantsTask: one.wantsTask === true,
    })),
    accepted: strings(plan.accepted),
    ...(strings(plan.alone).length > 0 ? { alone: strings(plan.alone) } : {}),
    ...(strings(plan.verification).length > 0 ? { verification: strings(plan.verification) } : {}),
    ...(strings(plan.setup).length > 0 ? { setup: strings(plan.setup) } : {}),
  }
}

/** The work of an errand or a review as one plan, of the tasks the run keeps: no question, risk or decision of a planner. */
export const ownPlan = (quest: Pick<Run, 'ref' | 'url' | 'title' | 'tasks'>): Plan => ({
  ref: quest.ref,
  url: quest.url,
  title: quest.title,
  summary: '',
  approach: '',
  tasks: quest.tasks ?? [],
  questions: [],
  decided: [],
  risks: [],
  accepted: [],
})

/** An errand's one task: the whole issue, as the planner read it, its thread with it, those from outside the repository left out and counted. */
export const errandTask = (issue: { title?: string; body?: string; comments?: { author: string; body: string }[]; leftOut?: number }): Task => ({
  id: 1,
  title: issue.title ?? '',
  why: '',
  steps: [],
  files: [],
  dependsOn: [],
  acceptance: 'What the issue asks for holds, and a test proves it.',
  weight: 'standard',
  state: 'todo',
  brief: [
    issue.body ?? '',
    ...(issue.comments ?? []).map(one => `--- ${one.author}:\n${one.body}`),
    ...((issue.leftOut ?? 0) > 0 ? [`--- (${issue.leftOut ?? 0} ${issue.leftOut === 1 ? 'comment' : 'comments'} from outside the repository left out)`] : []),
  ]
    .filter(one => one.trim() !== '')
    .join('\n\n'),
})

/** The review comments the review follow-up handed over, as tasks: each a change to make, in turn, on the pull request's branch. */
export const reviewTasks = (given: unknown): Task[] =>
  (Array.isArray(given) ? (given as Record<string, unknown>[]) : [])
    .map((one, at) => ({ ...taskOf({ ...one, id: at + 1, dependsOn: [], steps: [], state: 'todo' }), acceptance: text(one.acceptance) || 'What the comment asks for is done, and nothing else of the pull request.' }))
    .filter(task => task.title !== '' || (task.brief ?? '') !== '')

/**
 * How much of a plan the planner left open, which no run starts with: its questions not answered, its risks to cover
 * with a task (only a revision settles those), and those not decided. the planner's pane counts with it too.
 */
export const settlingOf = (plan: { questions: readonly { answer: string }[]; risks: readonly { wantsTask: boolean }[] }): { unanswered: number; toCover: number; undecided: number } => ({
  unanswered: plan.questions.filter(question => question.answer.trim() === '').length,
  toCover: plan.risks.filter(risk => risk.wantsTask).length,
  undecided: plan.risks.filter(risk => !risk.wantsTask).length,
})

/** What the planner left open, which the run does not started with: unanswered questions, risks not decided. */
export const unsettledOf = (plan: Plan): string[] => {
  const { unanswered, toCover, undecided } = settlingOf(plan)

  return [
    ...(unanswered > 0 ? [`${unanswered} unanswered ${unanswered === 1 ? 'question' : 'questions'}`] : []),
    ...(toCover > 0 ? [`${toCover} ${toCover === 1 ? 'risk' : 'risks'} to cover with a task: revise the plan first`] : []),
    ...(undecided > 0 ? [`${undecided} undecided ${undecided === 1 ? 'risk' : 'risks'} (accept each, or have it covered or asked about)`] : []),
  ]
}

/**
 * What the person decided, to build and judge with: what earlier revisions carried, and their answers to this plan's
 * own questions, which only a revision after it would carry as decided.
 */
export const decisionsOf = (plan: Plan): { text: string; answer: string }[] => [
  ...plan.decided,
  ...plan.questions.filter(question => question.answer.trim() !== '').map(({ text, answer }) => ({ text, answer })),
]

/** Whether a task is behind the run: built, or handed back to the person. */
export const isSettled = (task: Task): boolean => task.state === 'done' || task.state === 'asked'

/** How many of a plan's tasks are built at once, each beside the others in a lane of its own. */
export const LANES = 3

/** The ref a lane of a run is kept by: the run's, and its task's id. */
export const laneRefOf = (ref: string, taskId: number): string => `${ref}~${taskId}`

/** The branch a lane builds on, off its run's. */
export const laneBranchOf = (branch: string, taskId: number): string => `${branch}--task-${taskId}`

/** The issue a run works for: a lane's is its run's. */
export const issueRefOf = (quest: Pick<Run, 'ref' | 'lane'>): string => quest.lane?.of ?? quest.ref

/** The tasks a plan could send now: not behind it, every dependency done, and none already out in a lane. */
export const readyTasks = (plan: Plan, out: readonly number[]): Task[] => {
  const isDone = (id: number) => plan.tasks.find(one => one.id === id)?.state === 'done'

  return plan.tasks.filter(task => !isSettled(task) && !out.includes(task.id) && task.dependsOn.every(isDone))
}

/**
 * The ready tasks to send beside those out, in the plan's order, up to `LANES` out at once: each names its files, and
 * none of them is a file another task out or taken names, as two changes of one file would not land on each other. A
 * task that names no file could touch any, and is sent alone.
 */
export const besideOf = (ready: readonly Task[], out: readonly Task[]): Task[] => {
  const taken: Task[] = []
  const files = new Set(out.flatMap(task => task.files))

  if (out.some(task => task.files.length === 0)) return []

  for (const task of ready) {
    if (out.length + taken.length >= LANES) break
    if (task.files.length === 0 || task.files.some(file => files.has(file))) continue

    taken.push(task)
    for (const file of task.files) files.add(file)
  }

  return taken
}

/** What a lane's builder is sent back with when its change no longer lands on its run's branch as it stands. */
export const conflictPrompt = (branch: string, files: readonly string[]): string =>
  [
    `Your change passed its review, but ${branch} moved while you built it: another task landed there first, and your change conflicts with it. Your working tree is now ${branch} as it stands, with your change applied on it, and git's conflict markers where the two meet.`,
    `Resolve each conflict${files.length > 0 ? ` (${files.join(', ')})` : ''} so that both changes hold, keeping what the other task built. Change nothing else, prove it again, and end your turn with your account as before.`,
  ].join('\n')

/** The task to send a builder on: one already begun first, else the first whose every dependency is done. */
export const nextTask = (plan: Plan): Task | undefined => {
  const isDone = (id: number) => plan.tasks.find(one => one.id === id)?.state === 'done'
  const open = plan.tasks.filter(task => !isSettled(task) && task.dependsOn.every(isDone))

  return open.find(task => task.state === 'doing') ?? open[0]
}

export const isAllDone = (plan: Plan): boolean => plan.tasks.every(isSettled)

export const tally = (plan: Plan): string => {
  const asked = plan.tasks.filter(task => task.state === 'asked').length

  return `${plan.tasks.filter(task => task.state === 'done').length}/${plan.tasks.length} done${asked > 0 ? `, ${asked} for you` : ''}`
}

/** The branch a plan or an errand commits on: the issue's number and its title, as a branch name spells them. */
export const branchOf = (plan: Pick<Plan, 'ref' | 'title'>): string => {
  const slug = plan.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '')

  return `build/${refOf(plan.ref)?.number ?? 'run'}${slug === '' ? '' : `-${slug}`}`
}

/** The worktrees git lists, each folder with the branch checked out there (none when HEAD is detached). */
export const parseWorktrees = (porcelain: string): { path: string; branch: string }[] =>
  porcelain
    .split(/\n\s*\n/)
    .map(entry => ({ path: /^worktree (.+)$/m.exec(entry)?.[1]?.trim() ?? '', branch: (/^branch (.+)$/m.exec(entry)?.[1]?.trim() ?? '').replace(/^refs\/heads\//, '') }))
    .filter(one => one.path !== '')
