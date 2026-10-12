import { describe, expect, test } from 'claude-code/testing'

import { DEFAULTS, beforeTicket, clockTime, fillOf, holdOf, isOverBudget, roomFor, settingsOf } from '../hooks/budget'

const NOW = Date.parse('2026-10-11T20:00:00.000Z')
const RESET = '2026-10-11T22:10:00.000Z'

const reading = (short: number, weekly: number, resetsAt: string | null = RESET) => ({
  at: NOW,
  quota: [
    { kind: 'five_hour', percentUsed: short, ...(resetsAt !== null ? { resetsAt } : {}) },
    { kind: 'seven_day', percentUsed: weekly, resetsAt: '2026-10-15T19:00:00.000Z' },
  ],
})

describe('whether the run may start a ticket', () => {
  test('it may while both quota windows are under their thresholds', () => {
    expect(beforeTicket(reading(89.9, 89.9), DEFAULTS)).toEqual({ kind: 'start' })
  })

  test('it waits when the short window is at its threshold, until a minute after the window resets', () => {
    expect(beforeTicket(reading(90, 40), DEFAULTS)).toEqual({
      kind: 'wait',
      percentUsed: 90,
      until: Date.parse('2026-10-11T22:11:00.000Z'),
    })
  })

  test('it stops when the weekly window is at its threshold, whatever the short one says', () => {
    expect(beforeTicket(reading(10, 93), DEFAULTS)).toEqual({ kind: 'stop', percentUsed: 93 })
    expect(beforeTicket(reading(95, 93), DEFAULTS)).toEqual({ kind: 'stop', percentUsed: 93 })
  })

  test('it looks again in half an hour when the window does not say when it resets, or says a time gone by', () => {
    const halfAnHour = NOW + 30 * 60 * 1000

    expect(beforeTicket(reading(95, 40, null), DEFAULTS)).toMatchObject({ kind: 'wait', until: halfAnHour })
    expect(beforeTicket(reading(95, 40, '2026-10-11T19:00:00.000Z'), DEFAULTS)).toMatchObject({ kind: 'wait', until: halfAnHour })
  })

  test('it may when the session has no quota reading, as off a subscription', () => {
    expect(beforeTicket({ at: NOW, quota: [] }, DEFAULTS)).toEqual({ kind: 'start' })
  })

  test('the thresholds are the person\'s to set', () => {
    const settings = { ...DEFAULTS, shortWindowPercent: 50, weeklyPercent: 95 }

    expect(beforeTicket(reading(60, 93), settings).kind).toBe('wait')
  })
})

describe('the settings', () => {
  test('are the defaults when nothing is set', () => {
    expect(settingsOf(undefined)).toEqual({
      implementerModel: 'sonnet',
      strongModel: 'opus',
      exploreModel: 'haiku',
      shortWindowPercent: 90,
      weeklyPercent: 90,
      contextPercent: 70,
      parallelTickets: 3,
    })
  })

  test('take what is set, and keep the default for a value that is empty or out of range', () => {
    expect(
      settingsOf({ implementerModel: 'opus', strongModel: ' ', shortWindowPercent: 75, weeklyPercent: 140 }),
    ).toEqual({ ...DEFAULTS, implementerModel: 'opus', shortWindowPercent: 75 })
  })

  test('take how many tickets are built at once as a whole number from 1 to 8', () => {
    expect(settingsOf({ parallelTickets: 1 }).parallelTickets).toBe(1)
    expect(settingsOf({ parallelTickets: 8 }).parallelTickets).toBe(8)
    for (const outside of [0, 9, 2.5, '4']) expect(settingsOf({ parallelTickets: outside }).parallelTickets).toBe(3)
  })
})

describe('a ticket\'s context budget', () => {
  test('counts everything a request carried: what was read fresh, from the cache, and written to it', () => {
    expect(fillOf({ input_tokens: 1_000, cache_read_input_tokens: 120_000, cache_creation_input_tokens: 9_000 })).toBe(130_000)
  })

  test('is passed at its share of a 200,000-token window, whatever window the model has', () => {
    expect(isOverBudget(139_999, DEFAULTS)).toBe(false)
    expect(isOverBudget(140_000, DEFAULTS)).toBe(true)
    expect(isOverBudget(100_000, { ...DEFAULTS, contextPercent: 50 })).toBe(true)
  })
})

test('a time is told by its hour and minute on the person\'s own clock', () => {
  expect(clockTime(new Date(2026, 9, 11, 22, 11).getTime())).toBe('22:11')
  expect(clockTime(new Date(2026, 9, 11, 7, 5).getTime())).toBe('07:05')
})

describe('the room the quota has for tickets', () => {
  const start = reading(20, 30)

  test('has no limit while no ticket has ended, or where nothing was spent', () => {
    expect(roomFor(start, reading(60, 30), 0, DEFAULTS)).toBe(Number.POSITIVE_INFINITY)
    expect(roomFor(undefined, reading(60, 30), 3, DEFAULTS)).toBe(Number.POSITIVE_INFINITY)
    expect(roomFor(start, reading(20, 30), 3, DEFAULTS)).toBe(Number.POSITIVE_INFINITY)
  })

  test('is what is left under the threshold, over what a ticket has cost so far', () => {
    // 40 points spent over 2 tickets: 20 a ticket, and 30 left under 90
    expect(roomFor(start, reading(60, 30), 2, DEFAULTS)).toBe(1)
    // 10 a ticket, and 60 left
    expect(roomFor(start, reading(30, 30), 1, DEFAULTS)).toBe(6)
  })

  test('is one at least: the threshold itself is what holds a ticket back', () => {
    expect(roomFor(start, reading(85, 30), 1, DEFAULTS)).toBe(1)
  })

  test('is the smaller of the two windows\' rooms', () => {
    // The weekly window: 30 points over 3 tickets, and 30 left under 90; the short one has room for many more
    expect(roomFor(start, reading(26, 60), 3, DEFAULTS)).toBe(3)
  })

  test('has no limit from a window that has reset since the run started', () => {
    expect(roomFor(start, reading(60, 30, '2026-10-12T03:10:00.000Z'), 2, DEFAULTS)).toBe(Number.POSITIVE_INFINITY)
  })
})

describe('the hold the quota puts on work about to start', () => {
  test('is none under both thresholds', () => {
    expect(holdOf(reading(40, 30), DEFAULTS)).toBeUndefined()
  })

  test('says when the run goes on, for the short window', () => {
    expect(holdOf(reading(92, 30), DEFAULTS)).toEqual({
      pause: `the 5-hour quota window is at 92%: the run goes on by itself at ${clockTime(Date.parse(RESET) + 60_000)}`,
      resumeAt: Date.parse(RESET) + 60_000,
    })
  })

  test('says that waiting does not help, for the weekly one', () => {
    expect(holdOf(reading(40, 95), DEFAULTS)).toEqual({ pause: 'the weekly quota window is at 95%', isOver: true })
  })
})
