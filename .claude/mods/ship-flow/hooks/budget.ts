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
}

export const DEFAULTS: Settings = {
  implementerModel: 'sonnet',
  strongModel: 'opus',
  exploreModel: 'haiku',
  shortWindowPercent: 90,
  weeklyPercent: 90,
}

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

/** The settings as the mod's options give them; a value missing or out of range is the default. */
export const settingsOf = (options: Readonly<Record<string, unknown>> | undefined): Settings => ({
  implementerModel: text(options?.implementerModel, DEFAULTS.implementerModel),
  strongModel: text(options?.strongModel, DEFAULTS.strongModel),
  exploreModel: text(options?.exploreModel, DEFAULTS.exploreModel),
  shortWindowPercent: percent(options?.shortWindowPercent, DEFAULTS.shortWindowPercent),
  weeklyPercent: percent(options?.weeklyPercent, DEFAULTS.weeklyPercent),
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

/** A time as a person reads it in a line of text: the hour and minute, in UTC. */
export const clockTime = (ms: number): string => `${new Date(ms).toISOString().slice(11, 16)} UTC`
