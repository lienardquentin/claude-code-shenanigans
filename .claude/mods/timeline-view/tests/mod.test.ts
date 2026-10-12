import { describe, expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { ALIVE, BUSY, MAIN, QUIET, busyOf, lanesIn, lengthOf, periodOf, rowOf, spansIn, targetOf } from '../hooks/timeline'
import type { TimelineLane, TimelineSpan } from '../types'

const START = Date.parse('2026-10-12T09:00:00.000Z')

const tool = (lane: string, name: string, start: number, end?: number, failed?: boolean): TimelineSpan => ({
  id: `${lane}-${name}-${start}`,
  lane,
  kind: 'tool',
  name,
  target: '',
  start,
  ...(end !== undefined ? { end } : {}),
  ...(failed !== undefined ? { failed } : {}),
})

const turn = (start: number, end?: number): TimelineSpan => ({
  id: `turn-${start}`,
  lane: MAIN,
  kind: 'turn',
  name: 'turn',
  target: 'do it',
  start,
  ...(end !== undefined ? { end } : {}),
})

const main: TimelineLane = { id: MAIN, label: 'main', start: 0 }
const text = (runs: readonly { text: string }[]): string => runs.map(run => run.text).join('')

describe('the drawing', () => {
  test('fills the cells a tool ran in, shades the rest of the turn and dots the idle time', () => {
    const spans = [turn(0, 600), tool(MAIN, 'Bash', 200, 400)]
    const runs = rowOf(main, spans, { from: 0, to: 1000 }, 10, 1000)

    expect(text(runs)).toBe(`${ALIVE}${ALIVE}${BUSY}${BUSY}${ALIVE}${ALIVE}${QUIET}${QUIET}${QUIET}${QUIET}`)
    expect(runs.find(run => run.text.includes(BUSY))?.tone).toBe('accent')
  })

  test('a call far shorter than a cell still shows, and a failed one is never painted over', () => {
    const spans = [tool(MAIN, 'Read', 0, 90), tool(MAIN, 'Bash', 95, 96, true), tool(MAIN, 'Edit', 500, 501)]
    const runs = rowOf(main, spans, { from: 0, to: 1000 }, 10, 1000)

    expect(text(runs)).toBe(`${BUSY}${QUIET.repeat(4)}${BUSY}${QUIET.repeat(4)}`)
    expect(runs[0]?.tone).toBe('danger')
    expect(runs[2]?.tone).toBe('warning')
  })

  test('a call that still runs reaches now, and a subagent is shaded from its spawn', () => {
    const lane: TimelineLane = { id: 'a1', label: 'explore', start: 500 }
    const runs = rowOf(lane, [tool('a1', 'Grep', 800)], { from: 0, to: 1000 }, 10, 1000)

    expect(text(runs)).toBe(`${QUIET.repeat(5)}${ALIVE.repeat(3)}${BUSY.repeat(2)}`)
  })

  test('a lane draws only its own calls', () => {
    const runs = rowOf(main, [tool('a1', 'Grep', 0, 1000)], { from: 0, to: 1000 }, 10, 1000)

    expect(text(runs)).toBe(QUIET.repeat(10))
  })
})

describe('the period', () => {
  const spans = [turn(1000, 2000), tool(MAIN, 'Read', 1200, 1300), turn(5000, 7000), tool(MAIN, 'Bash', 5500, 6000)]

  test('covers everything recorded, up to now only while something runs', () => {
    expect(periodOf(spans, [], 'all', 60_000)).toEqual({ from: 1000, to: 7000 })
    expect(periodOf([...spans, tool(MAIN, 'Bash', 8000)], [], 'all', 60_000)).toEqual({ from: 1000, to: 60_000 })
  })

  test('narrows to the latest turn, or to the last minutes', () => {
    expect(periodOf(spans, [], 'turn', 60_000)).toEqual({ from: 5000, to: 7000 })
    expect(periodOf(spans, [], '5m', 400_000)).toEqual({ from: 100_000, to: 400_000 })
  })

  test('is none when nothing was recorded', () => {
    expect(periodOf([], [], 'all', 1000)).toBeUndefined()
  })

  test('lists a lane only when it worked in the period, the main one always', () => {
    const lanes: TimelineLane[] = [
      { id: 'late', label: 'late', start: 6000, end: 6500 },
      { id: 'early', label: 'early', start: 1100, end: 1500 },
    ]

    expect(lanesIn(spans, lanes, { from: 5000, to: 7000 }, 60_000).map(lane => lane.id)).toEqual([MAIN, 'late'])
    expect(lanesIn(spans, lanes, { from: 1000, to: 7000 }, 60_000).map(lane => lane.id)).toEqual([MAIN, 'early', 'late'])
    expect(spansIn(spans, MAIN, { from: 5000, to: 7000 }, 60_000).map(span => span.name)).toEqual(['Bash', 'turn'])
  })
})

describe('the words', () => {
  test('a length of time reads as a person says it', () => {
    expect(lengthOf(850)).toBe('850ms')
    expect(lengthOf(12_340)).toBe('12.3s')
    expect(lengthOf(245_000)).toBe('4m 05s')
    expect(lengthOf(4_320_000)).toBe('1h 12m')
  })

  test('a call is named by what it worked on, on one line', () => {
    expect(targetOf({ tool: 'Bash', command: 'npm test\n  --watch' })).toBe('npm test --watch')
    expect(targetOf({ tool: 'Read', file_path: 'src/parse.ts' })).toBe('src/parse.ts')
    expect(targetOf({ tool: 'Odd', count: 3 })).toBe('')
  })

  test('the time in tools counts each call whole', () => {
    expect(busyOf([tool(MAIN, 'Read', 0, 300), tool(MAIN, 'Bash', 100, 600)], 1000)).toBe(800)
  })
})

type Kit = Parameters<TestBody>

const mountOn = <S extends 'terminal' | 'desktop' | 'vscode' | 'mobile'>($: Kit[0], surface: S) =>
  $.ui.mount({ plugin: 'timeline-view', surface, component: 'Pane', props: { bodyColumns: 100 } as never, requestId: 'timeline-view' })

// Stands for the engine: a turn starts and ends as asked
const turns = (on: Kit[1]) => {
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
}

const mountPane = ($: Kit[0]) => mountOn($, 'terminal')

describe('timeline-view', () => {
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    test(`says so when nothing ran yet (${surface})`, async ($, on) => {
      mock.clock(on, { now: START })
      const pane = await mountOn($, surface)

      expect(await pane.find({ text: /Nothing recorded yet/ })).toBeDefined()
    })

    test(`draws a call while it runs and how long it took once it ended (${surface})`, async ($, on) => {
      const clock = mock.clock(on, { now: START })
      on('tool.call', { tool: 'Bash' }, async () => {
        await clock.sleep(3000)

        return { result: { stdout: 'ok' } } as never
      })

      const pane = await mountOn($, surface)
      const call = $.tool.call({ tool: 'Bash', command: 'npm test' } as never)
      await clock.settle()

      expect(await pane.find({ text: /npm test/ })).toBeDefined()
      expect(await pane.find({ text: /running/ })).toBeDefined()

      await clock.advance(3000)
      await call

      expect(await pane.find({ text: /^3\.0s$/ })).toBeDefined()
      expect(await pane.find({ text: /main: 1 call, 3\.0s in tools/ })).toBeDefined()
      expect(await pane.find({ text: /running/ })).toBeUndefined()
    })
  }

  test('passes a call on untouched and marks one that failed', async ($, on) => {
    mock.clock(on, { now: START })
    on('tool.call', { tool: 'Read' }, () => ({ result: { text: 'no such file' }, isError: true }) as never)

    const pane = await mountPane($)
    const answer = await $.tool.call({ tool: 'Read', file_path: 'missing.ts' } as never)

    expect(JSON.stringify(answer)).toMatch(/no such file/)
    expect(await pane.find({ text: /missing\.ts/ })).toBeDefined()
    expect((await pane.find({ type: 'Text', text: BUSY }))?.props).toMatchObject({ color: 'error' })
  })

  test('gives a subagent a lane of its own, listed when its name is pressed', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    on('agent.spawn', () => ({ model: 'haiku', agentId: 'a1' }) as never)
    on('tool.call', { tool: 'Grep' }, () => ({ result: {} }) as never)
    on('tool.call', { tool: 'Edit' }, () => ({ result: {} }) as never)

    turns(on)

    const pane = await mountPane($)
    await $.turn.start({ text: 'find the parser', turnId: 't1' })
    await $.tool.call({ tool: 'Edit', file_path: 'src/draw.ts' } as never)
    await $.agent.spawn({ tool_use_id: 'u1', prompt: 'look', description: 'find parser', subagentType: 'Explore' } as never)
    await clock.advance(2000)
    await $.tool.call({ tool: 'Grep', pattern: 'parse\\(', agentId: 'a1' } as never)

    expect(await pane.find({ key: 'lane-a1' })).toBeDefined()
    expect(await pane.find({ text: /src\/draw\.ts/ })).toBeDefined()
    expect(await pane.find({ text: /parse\\\(/ })).toBeUndefined()

    await pane.press({ key: 'lane-a1' })

    expect(await pane.find({ text: /find parser: 1 call/ })).toBeDefined()
    expect(await pane.find({ text: /parse\\\(/ })).toBeDefined()
    expect(await pane.find({ text: /src\/draw\.ts/ })).toBeUndefined()
  })

  test('lists a turn with its prompt, and Clear empties what has ended', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    on('tool.call', { tool: 'Read' }, () => ({ result: {} }) as never)

    turns(on)

    const pane = await mountPane($)
    await $.turn.start({ text: 'explain the layout', turnId: 't1' })
    await $.tool.call({ tool: 'Read', file_path: 'layout.ts' } as never)
    await clock.advance(65_000)
    await $.turn.complete({ answer: 'done', durationMs: 65_000, isAborted: false, turnId: 't1', reason: 'answer' } as never)

    expect(await pane.find({ text: /explain the layout/ })).toBeDefined()
    expect(await pane.find({ text: /^1m 05s$/ })).toBeDefined()

    await pane.press({ key: 'clear' })

    expect(await pane.find({ text: /Nothing recorded yet/ })).toBeDefined()
  })

  test('the latest turn leaves out what ran before it', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    on('tool.call', { tool: 'Read' }, () => ({ result: {} }) as never)

    turns(on)

    const pane = await mountPane($)
    await $.turn.start({ text: 'first', turnId: 't1' })
    await $.tool.call({ tool: 'Read', file_path: 'old.ts' } as never)
    await clock.advance(1000)
    await $.turn.complete({ answer: '', durationMs: 1000, isAborted: false, turnId: 't1', reason: 'answer' } as never)
    await clock.advance(60_000)
    await $.turn.start({ text: 'second', turnId: 't2' })
    await $.tool.call({ tool: 'Read', file_path: 'new.ts' } as never)

    expect(await pane.find({ text: /old\.ts/ })).toBeDefined()

    await pane.select({ key: 'range', value: 'turn' } as never)

    expect(await pane.find({ text: /new\.ts/ })).toBeDefined()
    expect(await pane.find({ text: /old\.ts/ })).toBeUndefined()
  })
})
