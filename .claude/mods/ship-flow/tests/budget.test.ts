import { describe, expect, test } from 'claude-code/testing'

import { DEFAULTS, beforeTicket, clockTime, settingsOf } from '../hooks/budget'

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
    })
  })

  test('take what is set, and keep the default for a value that is empty or out of range', () => {
    expect(
      settingsOf({ implementerModel: 'opus', strongModel: ' ', shortWindowPercent: 75, weeklyPercent: 140 }),
    ).toEqual({ ...DEFAULTS, implementerModel: 'opus', shortWindowPercent: 75 })
  })
})

test('a time is told by its hour and minute in UTC', () => {
  expect(clockTime(Date.parse('2026-10-11T22:11:00.000Z'))).toBe('22:11 UTC')
})
