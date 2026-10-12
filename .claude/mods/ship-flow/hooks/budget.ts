import type { UsageReading } from './run'

/** What the person may set on the mod: the model of each kind of work, and where the run stops spending. */
export type Settings = {
  /** The model a ticket is built on, unless the ticket names its own. */
  implementerModel: string
  /** The model of the work that needs judgment: grilling, the spec, the tickets, the final review. */
  strongModel: string
  /** The model of reading the codebase. */
  exploreModel: string
  /** How full the short quota window may be, in percent, for a ticket to start. */
  shortWindowPercent: number
  /** How full the weekly quota window may be, in percent, for a ticket to start. */
  weeklyPercent: number
  /** How much of one context window a ticket's implementer may fill, in percent, before it is stopped. */
  contextPercent: number
  /** How many tickets the run builds at once, each in a worktree of its own. */
  parallelTickets: number
}

/** The most tickets a run may be set to build at once. */
export const MOST_PARALLEL = 8

export const DEFAULTS: Settings = {
  implementerModel: 'sonnet',
  strongModel: 'opus',
  exploreModel: 'haiku',
  shortWindowPercent: 90,
  weeklyPercent: 90,
  contextPercent: 70,
  parallelTickets: 3,
}

/**
 * The context window the budget is a share of, in tokens. A fixed size, not each model's own: the engine does not
 * say what window a subagent's model has, and a model reasons less sharply long before a window of a million
 * tokens is full, so the budget is counted in the window every model has.
 */
export const BUDGET_WINDOW = 200_000

/** What one response was answered over, as the API reports it. */
export type StepUsage = { input_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }

/** How full the context was when a response was made, in tokens: everything the request carried. */
export const fillOf = (usage: StepUsage): number =>
  usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens

/** Whether a context this full is past the ticket's budget. */
export const isOverBudget = (tokens: number, settings: Settings): boolean =>
  tokens >= (BUDGET_WINDOW * settings.contextPercent) / 100

// The quota windows as the session names them
const SHORT = 'five_hour'
const WEEKLY = 'seven_day'

// How long after a window's reset the run waits before it looks again
const MARGIN_MS = 60 * 1000

// How long the run waits when a window over its threshold does not say when it resets
const RECHECK_MS = 30 * 60 * 1000

const text = (value: unknown, fallback: string): string => (typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback)

const percent = (value: unknown, fallback: number): number =>
  typeof value === 'number' && value > 0 && value <= 100 ? value : fallback

const count = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MOST_PARALLEL ? value : fallback

/** The settings as the mod's options give them; a value missing or out of range is the default. */
export const settingsOf = (options: Readonly<Record<string, unknown>> | undefined): Settings => ({
  implementerModel: text(options?.implementerModel, DEFAULTS.implementerModel),
  strongModel: text(options?.strongModel, DEFAULTS.strongModel),
  exploreModel: text(options?.exploreModel, DEFAULTS.exploreModel),
  shortWindowPercent: percent(options?.shortWindowPercent, DEFAULTS.shortWindowPercent),
  weeklyPercent: percent(options?.weeklyPercent, DEFAULTS.weeklyPercent),
  contextPercent: percent(options?.contextPercent, DEFAULTS.contextPercent),
  parallelTickets: count(options?.parallelTickets, DEFAULTS.parallelTickets),
})

/**
 * Whether the run may start a ticket now. `start`: it may. `wait`: the short window is at its threshold, and the
 * run goes on by itself at `until`. `stop`: the weekly window is at its threshold, which is days from resetting,
 * so the run ends its building here.
 */
export type Verdict =
  | { kind: 'start' }
  | { kind: 'wait'; percentUsed: number; until: number }
  | { kind: 'stop'; percentUsed: number }

/** The verdict for a usage reading. The weekly window is looked at first: waiting hours does not help it. */
export const beforeTicket = (usage: UsageReading, settings: Settings): Verdict => {
  const weekly = usage.quota.find(window => window.kind === WEEKLY)
  const short = usage.quota.find(window => window.kind === SHORT)

  if (weekly && weekly.percentUsed >= settings.weeklyPercent) return { kind: 'stop', percentUsed: weekly.percentUsed }
  if (!short || short.percentUsed < settings.shortWindowPercent) return { kind: 'start' }

  const resetsAt = short.resetsAt === undefined ? Number.NaN : Date.parse(short.resetsAt)

  return {
    kind: 'wait',
    percentUsed: short.percentUsed,
    until: Number.isNaN(resetsAt) || resetsAt <= usage.at ? usage.at + RECHECK_MS : resetsAt + MARGIN_MS,
  }
}

/** A time as a person reads it in a line of text: the hour and minute, on their own clock. */
export const clockTime = (ms: number): string => {
  const at = new Date(ms)

  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
}

/** What the quota says before work starts, as the run words it: why it holds, when it goes on, or that waiting does not help. */
export type Hold = { pause: string; resumeAt?: number; isOver?: true }

/** The hold for a usage reading; undefined when the work may start. */
export const holdOf = (usage: UsageReading, settings: Settings): Hold | undefined => {
  const verdict = beforeTicket(usage, settings)

  if (verdict.kind === 'start') return undefined
  if (verdict.kind === 'stop') return { pause: `the weekly quota window is at ${verdict.percentUsed}%`, isOver: true }

  return {
    pause: `the 5-hour quota window is at ${verdict.percentUsed}%: the run goes on by itself at ${clockTime(verdict.until)}`,
    resumeAt: verdict.until,
  }
}

/**
 * How many tickets the quota has room for now, from what those ended so far have cost: the share of a window the
 * run has spent since `start`, over the attempts that ended in it. One at least, since the thresholds are
 * `beforeTicket`'s to hold; no limit while nothing has ended, or where a window has reset since `start`.
 */
export const roomFor = (start: UsageReading | undefined, now: UsageReading, ended: number, settings: Settings): number => {
  if (!start || ended <= 0) return Number.POSITIVE_INFINITY

  const rooms = (
    [
      [SHORT, settings.shortWindowPercent],
      [WEEKLY, settings.weeklyPercent],
    ] as const
  ).map(([kind, threshold]) => {
    const before = start.quota.find(window => window.kind === kind)
    const after = now.quota.find(window => window.kind === kind)

    if (!before || !after || before.resetsAt !== after.resetsAt || after.percentUsed <= before.percentUsed) return Number.POSITIVE_INFINITY

    return Math.max(1, Math.floor((threshold - after.percentUsed) / ((after.percentUsed - before.percentUsed) / ended)))
  })

  return Math.min(...rooms)
}
