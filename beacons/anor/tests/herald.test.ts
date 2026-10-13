import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { herald } from '../server/utils/herald'

let written: string[]

beforeEach(() => {
  written = []
  vi.useFakeTimers().setSystemTime(new Date('2026-01-02T03:04:05.678Z'))
  vi.spyOn(process.stdout, 'write').mockImplementation(chunk => {
    written.push(String(chunk))
    return true
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('herald', () => {
  it('writes one JSON line, the level a number and the time in milliseconds', () => {
    herald('warn', 'Gondor is slow', { rid: 'abc' })

    expect(written).toHaveLength(1)
    expect(written[0]!.endsWith('\n')).toBe(true)
    expect(JSON.parse(written[0]!)).toEqual({ level: 40, time: Date.parse('2026-01-02T03:04:05.678Z'), msg: 'Gondor is slow', rid: 'abc' })
  })

  it.each([
    ['debug', 20],
    ['info', 30],
    ['warn', 40],
    ['error', 50],
  ] as const)('numbers %s as %i', (level, number) => {
    herald(level, 'x')

    expect(JSON.parse(written[0]!).level).toBe(number)
  })

  it('puts a trace under its line, indented, in the same write', () => {
    herald('error', 'it fell', {}, ['at a (a.ts:1)', 'at b (b.ts:2)'])

    expect(written).toHaveLength(1)

    const [line, ...frames] = written[0]!.trimEnd().split('\n')

    expect(JSON.parse(line!).msg).toBe('it fell')
    expect(frames).toEqual(['    at a (a.ts:1)', '    at b (b.ts:2)'])
  })
})
