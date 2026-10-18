import type { Commit, Builder, Plan, Task, Weight, TargetFolders } from './work'

// Who builds and who reviews: the builders by rung, the one a task is sent first and on each try, and the reviewers' models.

/** The model the reviewers judge a change with when it is not heavy: lighter than their own, and enough for it. */
export const LIGHTER_REVIEWER_MODEL = 'claude-sonnet-5-5'

/** What a task of each weight is, as the planner weighs it and the reviewers weigh a change's size against it. */
export const WEIGHT_MEANS = {
  light: 'docs, config, a rename, a typo or a test to adjust',
  standard: "one module's change and the test that proves it",
  heavy: 'a change that crosses targets, reworks a design, or touches code that is risky to change',
} as const

export const OPUS = 'claude-opus-5-5'

export const SONNET = 'claude-sonnet-5-5'

export const HAIKU = 'claude-haiku-5-5'

/** What a builder is, by its rung: the model and effort it builds with. A rung up is sent when the one below did not finish. */
export const RUNGS = [
  { model: HAIKU, effort: 'medium' },
  { model: SONNET, effort: 'medium' },
  { model: OPUS, effort: 'medium' },
  { model: OPUS, effort: 'high' },
] as const

export const LIGHT = 'You carry a light task: keep it small, and stop and say so if it turns out not to be.'

/**
 * The builders of the build, by rung: the light builders carry light tasks, the frontend, service and CLI builders a
 * target's work, Heavy builder the heavy, and the last builder comes last, when every other has failed.
 */
export const BUILDER_LIST: readonly { name: Builder; title: string; rung: 0 | 1 | 2 | 3; kind?: TargetFolders['kind']; charge: string }[] = [
  { name: 'builder-last', title: 'Last builder', rung: 3, charge: 'You are sent last, when every builder before you could not finish the task. Read what they tried and what stopped them before you change anything.' },
  { name: 'builder-heavy', title: 'Heavy builder', rung: 2, charge: 'You carry the heavy tasks: the ones that cross targets, rework a design, or touch what is risky to change.' },
  { name: 'builder-frontend', title: 'Frontend builder', rung: 1, kind: 'frontend', charge: "You know the project's frontends best: their components, their state and how they are drawn." },
  { name: 'builder-service', title: 'Service builder', rung: 1, kind: 'service', charge: "You know the project's services best: their routes, their storage and the brokers they speak to." },
  { name: 'builder-cli', title: 'CLI builder', rung: 1, kind: 'cli', charge: "You know the project's command-line tools best: their arguments, their output and how they fail." },
  { name: 'builder-light-1', title: 'Light builder 1', rung: 0, charge: LIGHT },
  { name: 'builder-light-2', title: 'Light builder 2', rung: 0, charge: LIGHT },
  { name: 'builder-light-3', title: 'Light builder 3', rung: 0, charge: LIGHT },
  { name: 'builder-light-4', title: 'Light builder 4', rung: 0, charge: LIGHT },
]

export const BUILDERS = Object.fromEntries(BUILDER_LIST.map(one => [one.name, { ...one, ...RUNGS[one.rung] }])) as Record<Builder, (typeof BUILDER_LIST)[number] & (typeof RUNGS)[number]>

export const LIGHT_BUILDERS = BUILDER_LIST.filter(one => one.rung === 0).map(one => one.name)

/** The line a builder ends with when it hands its task back to the person, saying why. */
export const HAND_BACK = 'Handed back:'

/** The line of an answer that hands its task back, without its marker; nothing when it does not. */
export const handBackOf = (answer: string): string | undefined => {
  const line = answer.split('\n').find(one => one.trim().startsWith(HAND_BACK))
  const why = line?.trim().slice(HAND_BACK.length).trim()

  // A builder that says it hands nothing back ("Handed back: none.") hands nothing back
  return why === undefined || why === '' || /^(none|nothing|n\/a)\b|^no[.!]?$/i.test(why) ? undefined : why
}

export const WEIGHT_RUNG: Record<Weight, number> = { light: 0, standard: 1, heavy: 2 }

/** Whether a high risk threatens a task. */
export const isThreatened = (plan: Plan, task: Task): boolean => plan.risks.some(risk => risk.severity === 'high' && risk.tasks.includes(task.id))

/** The rung a task is first carried from: its weight, one up when a high risk threatens it. */
export const firstRung = (plan: Plan, task: Task): number => Math.min(2, WEIGHT_RUNG[task.weight] + (isThreatened(plan, task) ? 1 : 0))

/** How many tries a task is given: one a rung, from its first up to the last builder. */
export const triesOf = (plan: Plan, task: Task): number => 4 - firstRung(plan, task)

/** The kind of target most of a task's files are in; none when no file is in a target. */
export const kindOf = (task: Task, targets: readonly TargetFolders[]): TargetFolders['kind'] | undefined => {
  const counts = new Map<TargetFolders['kind'], number>()

  for (const file of task.files) {
    const target = targets.find(one => one.roots.some(root => file === root || file.startsWith(`${root.replace(/\/+$/, '')}/`)))
    if (target !== undefined) counts.set(target.kind, (counts.get(target.kind) ?? 0) + 1)
  }

  return [...counts].sort((one, other) => other[1] - one[1])[0]?.[0]
}

/** Who carries a task on a try: one rung up a try, the light builders by turn, the elf, the dwarf or the man by the target. */
export const builderFor = (plan: Plan, task: Task, attempt: number, targets: readonly TargetFolders[]): Builder => {
  const rung = Math.min(3, firstRung(plan, task) + attempt - 1)

  if (rung === 3) return 'builder-last'
  if (rung === 2) return 'builder-heavy'
  if (rung === 0) return LIGHT_BUILDERS[(task.id - 1) % LIGHT_BUILDERS.length] ?? 'builder-light-1'

  const kind = kindOf(task, targets)

  return BUILDER_LIST.find(one => one.rung === 1 && one.kind === (kind ?? 'service'))?.name ?? 'builder-service'
}

/** Whether a task is heavy to change: heavy by its weight, or threatened by a high risk. */
export const isWeighty = (plan: Plan, task: Task): boolean => task.weight === 'heavy' || isThreatened(plan, task)

/** The model the reviewers judge a task's change with: their own on a heavy task, a lighter one on any other. */
export const reviewerModelFor = (plan: Plan, task: Task): string | undefined => (isWeighty(plan, task) ? undefined : LIGHTER_REVIEWER_MODEL)

/**
 * The model the reviewers judge a plan's whole branch with: their own when a task of it is heavy, or a change of it went
 * unproven, as each such task was judged; a lighter one on any other.
 */
export const wardModelFor = (plan: Plan, commits: readonly Pick<Commit, 'unproven'>[]): string | undefined =>
  plan.tasks.some(task => isWeighty(plan, task)) || commits.some(one => (one.unproven ?? []).length > 0) ? undefined : LIGHTER_REVIEWER_MODEL

/** What a plan's whole branch is meant to do, for both reviewers to judge it against before it is submitted. */
export const wardPurpose = (plan: Plan): string =>
  [
    `The whole branch of the plan for ${plan.ref}, "${plan.title}", before its pull request is opened. Each task was proved and reviewed alone; review what the tasks do together: one task undoing or contradicting another, a seam between them left broken, and what they let in together.`,
    ...(plan.summary !== '' ? [`What it asks for: ${plan.summary}`] : []),
    'Its tasks:',
    ...plan.tasks.map(task => `- ${task.id}. ${task.title}`),
  ].join('\n')
