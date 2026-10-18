// What a run may spend: whether the quota leaves room for the next task, and how much of a context window a builder
// may fill before it is stopped. Numbers in, a decision out; the mod reads the quota and each step's usage.

/** Where a run stops spending, as the person sets it on the mod. */
export type Budget = {
  /** How full the 5-hour quota window may be, in percent, for a task to start. */
  fiveHourPercent: number
  /** How full the weekly quota window may be, in percent, for a task to start. */
  weeklyPercent: number
  /** How much of a context window a builder may fill, in percent, before it is stopped. */
  contextPercent: number
}

export const DEFAULT_BUDGET: Budget = { fiveHourPercent: 90, weeklyPercent: 90, contextPercent: 70 }

const percent = (value: unknown, fallback: number): number => (typeof value === 'number' && value > 0 && value <= 100 ? value : fallback)

/** The budget as the mod's options give it; a value missing or out of range is the default. */
export const budgetOf = (options: Readonly<Record<string, unknown>> | undefined): Budget => ({
  fiveHourPercent: percent(options?.fiveHourPercent, DEFAULT_BUDGET.fiveHourPercent),
  weeklyPercent: percent(options?.weeklyPercent, DEFAULT_BUDGET.weeklyPercent),
  contextPercent: percent(options?.contextPercent, DEFAULT_BUDGET.contextPercent),
})

/** One quota window as the session reads it: `five_hour`, `seven_day`, or another the API names. */
export type QuotaWindow = { kind: string; percentUsed: number; resetsAt?: string }

/** The quota at a moment, in the clock's milliseconds. */
export type Quota = { at: number; windows: readonly QuotaWindow[] }

// The windows as the session names them
const FIVE_HOUR = 'five_hour'
const WEEKLY = 'seven_day'

// How long after a window's reset a held run waits before it goes on, and how long it waits when the window over
// its threshold does not say when it resets
const MARGIN_MS = 60 * 1000
const RECHECK_MS = 30 * 60 * 1000

/**
 * Why the next task may not start now: the 5-hour window is past its threshold, and the run goes on by itself at
 * `until`; or the weekly window is, days from resetting, and the run stops for the person (`isOver`). Nothing when it
 * may start, or when no window was read.
 */
export type Hold = { why: string; until?: number; isOver?: true }

export const holdOf = (quota: Quota | undefined, budget: Budget): Hold | undefined => {
  if (quota === undefined) return undefined

  const weekly = quota.windows.find(window => window.kind === WEEKLY)
  const short = quota.windows.find(window => window.kind === FIVE_HOUR)

  // The weekly window is looked at first: waiting hours does not help it
  if (weekly !== undefined && weekly.percentUsed >= budget.weeklyPercent) return { why: `the weekly quota window is at ${Math.round(weekly.percentUsed)}% (the run stops at ${budget.weeklyPercent}%)`, isOver: true }
  if (short === undefined || short.percentUsed < budget.fiveHourPercent) return undefined

  const resetsAt = short.resetsAt === undefined ? Number.NaN : Date.parse(short.resetsAt)
  const until = Number.isNaN(resetsAt) || resetsAt <= quota.at ? quota.at + RECHECK_MS : resetsAt + MARGIN_MS

  return { why: `the 5-hour quota window is at ${Math.round(short.percentUsed)}% (the run waits from ${budget.fiveHourPercent}%)`, until }
}

/**
 * The context window the budget is a share of, in tokens. A fixed size, not each model's own: the engine does not say
 * what window a subagent's model has, and a model reasons less sharply long before a window of a million tokens is
 * full, so the budget is counted in the window every model has.
 */
export const BUDGET_WINDOW = 200_000

/** What one response was answered over, as the API reports it. */
export type StepUsage = { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }

/** How full the context was when a response was made, in tokens: everything the request carried. */
export const fillOf = (usage: StepUsage): number => (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0)

/** Whether a context this full is past a builder's budget. */
export const isOverBudget = (tokens: number, budget: Budget): boolean => tokens >= (BUDGET_WINDOW * budget.contextPercent) / 100

/** A context's fill as a share of the window, in whole percent. */
export const shareOf = (tokens: number): number => Math.round((tokens / BUDGET_WINDOW) * 100)

/** A time as a person reads it in a line: the hour and minute, on their own clock. */
export const clockTime = (ms: number): string => {
  const at = new Date(ms)

  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
}
